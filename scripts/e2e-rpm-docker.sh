#!/usr/bin/env bash
# End-to-end check of the RPM receiver in a clean Fedora container. Runs in CI (ci.yml) and locally.
# Publishes sql-pipe and damas from the pinned release fixtures, installs through dnf with gpgcheck=1
# and repo_gpgcheck=1, then checks that the refusal paths fail loudly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPMS="${RPM_E2E_RPMS:-${TMPDIR:-/tmp}/rpm-test}"
case "$(uname -m)" in
  arm64|aarch64) DEFAULT_PLATFORM=linux/arm64 ;;
  *) DEFAULT_PLATFORM=linux/amd64 ;;
esac
PLATFORM="${RPM_E2E_PLATFORM:-$DEFAULT_PLATFORM}"
IMAGE="${RPM_E2E_IMAGE:-fedora:latest}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rpm-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Fetches the pinned release .rpm inputs when they are missing (public assets, no auth).
[ -f "$RPMS/sql-pipe/sha256sums.txt" ] && [ -f "$RPMS/damas/sha256sums.txt" ] || "$ROOT/scripts/fetch-e2e-rpms.sh"
mkdir -p "$WORK/src"
cp -R "$RPMS/sql-pipe" "$RPMS/damas" "$WORK/src/"

docker run --rm -i --platform "$PLATFORM" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$ROOT:/work/repo:ro" \
  -v "$WORK:/work/data" \
  "$IMAGE" bash -s <<'CONTAINER'
set -eu
# The container runs as root; hand the work tree back to the host user so the host can remove it.
trap 'chown -R "$HOST_UID:$HOST_GID" /work/data || true' EXIT
export TMPDIR=/tmp
# nodejs is the publisher runtime, rpm-sign provides rpmsign for `rpm --addsign`; the rest is the receiver toolchain.
dnf -y install createrepo_c rpm rpm-sign gnupg python3 nodejs >/dev/null
cd /work/repo

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# rpm 6 no longer fills %{SIGPGP:pgpsig} (it answers "(none)" even for a signed file), so the query is
# printed as evidence and the signature itself is proven the way a client does: a scratch rpmdb that holds
# the published key, then rpmkeys.
assert_signed() {
  local file="$1" sig out
  sig="$(rpm -qp --queryformat '%{SIGPGP:pgpsig}' "$file")"
  [ -n "$sig" ] || fail "empty %{SIGPGP:pgpsig} for $file"
  out="$(rpmkeys --dbpath "$KEYDB" --checksig "$file" 2>&1 || true)"
  case "$out" in
    *"signatures OK"*) echo "  $(basename "$file"): pgpsig=[$sig] checksig=[$out]" ;;
    *) fail "no valid signature in $file: $out" ;;
  esac
}

echo "== disposable GPG key"
export GNUPGHOME=/root/gnupg
mkdir -m 700 -p "$GNUPGHOME"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key 'test@invalid' rsa2048 default never >/dev/null
GPG_KEY_ID="$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr:/{print $10; exit}')"
[ -n "$GPG_KEY_ID" ] || fail "gpg key was not created"
export GPG_KEY_ID
pass "gpg key $GPG_KEY_ID"

D=/work/data
BASE=http://127.0.0.1:8000
PUB="node scripts/rpm-publish.mjs"
for pkg in sql-pipe damas; do
  [ -f "$D/src/$pkg/sha256sums.txt" ] || fail "missing $pkg fixtures in $D/src/$pkg"
done

echo "== publish sql-pipe 0.27.0 from the fixtures with an empty state"
$PUB --catalog catalog/sql-pipe.json --version 0.27.0 --source "$D/src/sql-pipe" \
  --out "$D/out-sp" --state "$D/state" --base-url "$BASE" || fail "publish sql-pipe 0.27.0"
[ -f "$D/out-sp/.complete" ] || fail "site has no .complete"
grep -qx 'gpgcheck=1' "$D/out-sp/vmvarela.repo" || fail "vmvarela.repo lacks gpgcheck=1"
grep -qx 'repo_gpgcheck=1' "$D/out-sp/vmvarela.repo" || fail "vmvarela.repo lacks repo_gpgcheck=1"
grep -qx "baseurl=$BASE/packages/\$basearch" "$D/out-sp/vmvarela.repo" || fail "vmvarela.repo has an unexpected baseurl"
KEYDB=/tmp/site-keydb
mkdir -p "$KEYDB"
rpm --dbpath "$KEYDB" --import "$D/out-sp/RPM-GPG-KEY-vmvarela" || fail "cannot import RPM-GPG-KEY-vmvarela"
for arch in x86_64 aarch64; do
  rpmfile="$D/out-sp/packages/$arch/sql-pipe-0.27.0-1.$arch.rpm"
  [ -f "$rpmfile" ] || fail "site lacks $rpmfile"
  assert_signed "$rpmfile"
done
pass "signed site: .complete, repo file, signatures on x86_64 and aarch64"

echo "== publish damas 0.1.10 with the previous candidate state (carry-forward)"
$PUB --catalog catalog/damas.json --version 0.1.10 --source "$D/src/damas" \
  --out "$D/out" --state "$D/out-sp.state" --base-url "$BASE" || fail "publish damas 0.1.10"
for arch in x86_64 aarch64; do
  for f in sql-pipe-0.27.0-1 damas-0.1.10-1; do
    [ -f "$D/out/packages/$arch/$f.$arch.rpm" ] || fail "site $arch lacks $f.$arch.rpm"
  done
done
[ -f "$D/out.state/sql-pipe/state.json" ] || fail "state lost sql-pipe"
[ -f "$D/out.state/damas/state.json" ] || fail "state lost damas"
pass "site carries sql-pipe and damas on both arches; state keeps both packages"

echo "== serve the site and install sql-pipe through dnf"
python3 -m http.server 8000 --bind 127.0.0.1 --directory "$D/out" >/tmp/http.log 2>&1 &
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/.complete", timeout=2)' >/tmp/probe.log 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { cat /tmp/http.log /tmp/probe.log; fail "http server did not start"; }

mkdir -p /etc/yum.repos.d
cp "$D/out/vmvarela.repo" /etc/yum.repos.d/vmvarela.repo
# Without skip_if_unavailable=0 dnf5 downgrades a missing or bad repomd signature to a warning and exits 0.
printf 'sslverify=0\nskip_if_unavailable=0\n' >> /etc/yum.repos.d/vmvarela.repo
grep -qx 'gpgcheck=1' /etc/yum.repos.d/vmvarela.repo || fail "installed repo lacks gpgcheck=1"
grep -qx 'repo_gpgcheck=1' /etc/yum.repos.d/vmvarela.repo || fail "installed repo lacks repo_gpgcheck=1"
grep -qx 'sslverify=0' /etc/yum.repos.d/vmvarela.repo || fail "installed repo lacks sslverify=0"
grep -qx 'skip_if_unavailable=0' /etc/yum.repos.d/vmvarela.repo || fail "installed repo lacks skip_if_unavailable=0"
dnf -y clean all >/dev/null
dnf -y install sql-pipe || fail "dnf install sql-pipe must accept the signature"
got="$(rpm -q --queryformat '%{VERSION}' sql-pipe)"
[ "$got" = 0.27.0 ] || fail "installed version is $got, expected 0.27.0"
v="$(sql-pipe --version 2>&1)" || fail "sql-pipe --version failed: [$v]"
case "$v" in *0.27.0*) ;; *) fail "sql-pipe --version is [$v]" ;; esac
pass "dnf installed signed sql-pipe 0.27.0"

echo "== negative: repodata without repomd.xml.asc must break dnf"
for arch in x86_64 aarch64; do
  [ -f "$D/out/packages/$arch/repodata/repomd.xml.asc" ] || fail "missing repomd.xml.asc for $arch"
  rm "$D/out/packages/$arch/repodata/repomd.xml.asc"
done
dnf -y clean all >/dev/null
if dnf -y makecache --disablerepo='*' --enablerepo=vmvarela; then
  fail "dnf makecache accepted repodata without repomd.xml.asc"
fi
for arch in x86_64 aarch64; do
  gpg --batch --yes --local-user "$GPG_KEY_ID" --armor --detach-sign \
    --output "$D/out/packages/$arch/repodata/repomd.xml.asc" \
    "$D/out/packages/$arch/repodata/repomd.xml"
done
dnf -y clean all >/dev/null
pass "dnf makecache fails without repomd.xml.asc"

echo "== negative: an unsigned rpm in the site must not install with gpgcheck=1"
arch="$(rpm -E '%{_arch}')"
unsigned="$D/src/sql-pipe/sql-pipe-0.27.0-1.$arch.rpm"
[ -f "$unsigned" ] || fail "missing fixture $unsigned"
pkgdir="$D/out/packages/$arch"
cp -R "$pkgdir" "$D/pkgdir-backup"
cp "$unsigned" "$pkgdir/sql-pipe-0.27.0-1.$arch.rpm"
createrepo_c --quiet "$pkgdir"
gpg --batch --yes --local-user "$GPG_KEY_ID" --armor --detach-sign \
  --output "$pkgdir/repodata/repomd.xml.asc" "$pkgdir/repodata/repomd.xml"
dnf -y clean all >/dev/null
dnf -y remove sql-pipe >/dev/null || fail "dnf remove sql-pipe"
if dnf -y install sql-pipe; then fail "dnf installed an unsigned rpm with gpgcheck=1"; fi
rm -rf "$pkgdir" && cp -R "$D/pkgdir-backup" "$pkgdir"
rm -rf "$D/pkgdir-backup"
dnf -y clean all >/dev/null
pass "unsigned rpm refused by dnf with gpgcheck=1"

echo "== negative: republishing an older version exits 2"
set +e
$PUB --catalog catalog/sql-pipe.json --version 0.26.0 --source github \
  --out "$D/out-old" --state "$D/out.state" --base-url "$BASE"
rc=$?
set -e
[ "$rc" = 2 ] || fail "older release exit $rc, expected 2"
[ ! -e "$D/out-old" ] || fail "older release wrote $D/out-old"
pass "older sql-pipe 0.26.0 refused with exit 2 and no site"

echo "E2E OK"
CONTAINER
