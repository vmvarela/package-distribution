#!/usr/bin/env bash
# End-to-end check of the APK receiver in a clean Alpine container. Runs in CI (ci.yml) and locally.
# Publishes sql-pipe and damas from the pinned release fixtures, installs both through apk with the
# published key and no --allow-untrusted, then checks the unsigned-index and missing-key refusals.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APKS="${APK_E2E_APKS:-${TMPDIR:-/tmp}/apk-test}"
case "$(uname -m)" in
  arm64|aarch64) DEFAULT_PLATFORM=linux/arm64 ;;
  *) DEFAULT_PLATFORM=linux/amd64 ;;
esac
PLATFORM="${APK_E2E_PLATFORM:-$DEFAULT_PLATFORM}"
IMAGE="${APK_E2E_IMAGE:-alpine:latest}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/apk-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Fetches the pinned release .apk inputs when they are missing (public assets, no auth).
[ -f "$APKS/sql-pipe/sha256sums.txt" ] && [ -f "$APKS/damas/sha256sums.txt" ] || "$ROOT/scripts/fetch-e2e-apks.sh"
mkdir -p "$WORK/src"
cp -R "$APKS/sql-pipe" "$APKS/damas" "$WORK/src/"

docker run --rm -i --platform "$PLATFORM" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$ROOT:/work/repo:ro" \
  -v "$WORK:/work/data" \
  "$IMAGE" sh -s <<'CONTAINER'
set -eu
# The container runs as root; hand the work tree back to the host user so the host can remove it.
trap 'chown -R "$HOST_UID:$HOST_GID" /work/data || true' EXIT
export TMPDIR=/tmp
# nodejs is the publisher runtime, abuild provides abuild-sign, openssl makes the throwaway key and
# python3 serves the site; apk and tar ship with the image.
apk add --no-cache nodejs abuild openssl python3 >/dev/null
cd /work/repo

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

D=/work/data
BASE=http://127.0.0.1:8000
PUB="node scripts/apk-publish.mjs"

echo "== disposable RSA key"
mkdir -p "$D/keys"
openssl genrsa -out "$D/keys/vmvarela.rsa" 2048
openssl rsa -in "$D/keys/vmvarela.rsa" -pubout -out "$D/keys/vmvarela.rsa.pub"
APK_SIGNING_KEY="$(cat "$D/keys/vmvarela.rsa")"
export APK_SIGNING_KEY
pass "throwaway RSA key"

for pkg in sql-pipe damas; do
  [ -f "$D/src/$pkg/sha256sums.txt" ] || fail "missing $pkg fixtures in $D/src/$pkg"
done

echo "== publish sql-pipe 0.27.0 with an empty state"
$PUB --catalog catalog/sql-pipe.json --version 0.27.0 --source "$D/src/sql-pipe" \
  --out "$D/site-sp" --state "$D/state" || fail "publish sql-pipe 0.27.0"
grep -qx 'promote 0.27.0' "$D/site-sp/.complete" || fail ".complete is not promote 0.27.0"
[ -f "$D/site-sp/vmvarela.rsa.pub" ] || fail "site root lacks vmvarela.rsa.pub"
for arch in x86_64 aarch64; do
  [ -f "$D/site-sp/$arch/sql-pipe-0.27.0.apk" ] || fail "site $arch lacks sql-pipe-0.27.0.apk"
  tar -tzf "$D/site-sp/$arch/APKINDEX.tar.gz" > /tmp/members.txt || fail "$arch APKINDEX is unreadable"
  [ "$(sed -n 1p /tmp/members.txt)" = ".SIGN.RSA.vmvarela.rsa.pub" ] ||
    fail "$arch APKINDEX first member is $(sed -n 1p /tmp/members.txt)"
  for f in "$D/site-sp/$arch"/*.apk; do
    case "${f##*/}" in *_*) fail "release asset name leaked into the site: ${f##*/}" ;; esac
  done
done
pass "signed site: .complete, both arches, signed indexes, canonical names"

echo "== publish damas 0.1.10 with the previous candidate state (carry-forward)"
$PUB --catalog catalog/damas.json --version 0.1.10 --source "$D/src/damas" \
  --out "$D/site" --state "$D/site-sp.state" || fail "publish damas 0.1.10"
for arch in x86_64 aarch64; do
  [ -f "$D/site/$arch/sql-pipe-0.27.0.apk" ] || fail "site $arch lacks sql-pipe-0.27.0.apk"
  [ -f "$D/site/$arch/damas-0.1.10.apk" ] || fail "site $arch lacks damas-0.1.10.apk"
done
[ -f "$D/site.state/sql-pipe/state.json" ] || fail "state lost sql-pipe"
[ -f "$D/site.state/damas/state.json" ] || fail "state lost damas"
pass "site carries sql-pipe and damas on both arches; state keeps both packages"

echo "== serve the site and install both packages through apk"
python3 -m http.server 8000 --bind 127.0.0.1 --directory "$D/site" >/tmp/http.log 2>&1 &
ready=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/.complete", timeout=2)' >/tmp/probe.log 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { cat /tmp/http.log /tmp/probe.log; fail "http server did not start"; }

cp "$D/site/vmvarela.rsa.pub" /etc/apk/keys/vmvarela.rsa.pub
out="$(apk add --no-cache --repository "$BASE" sql-pipe damas 2>&1)" || fail "apk add must accept the signature: $out"
v="$(sql-pipe --version 2>&1)" || fail "sql-pipe --version failed: [$v]"
case "$v" in *0.27.0*) ;; *) fail "sql-pipe --version is [$v]" ;; esac
v="$(damas --version 2>&1)" || fail "damas --version failed: [$v]"
case "$v" in *0.1.10*) ;; *) fail "damas --version is [$v]" ;; esac
pass "apk installed signed sql-pipe 0.27.0 and damas 0.1.10"

echo "== negative: an unsigned index must break apk"
arch="$(apk --print-arch)"
idx="$D/site/$arch/APKINDEX.tar.gz"
cp "$idx" /tmp/APKINDEX.signed
apk --allow-untrusted index --rewrite-arch "$arch" -o /tmp/APKINDEX.unsigned.tar.gz "$D/site/$arch"/*.apk
mv /tmp/APKINDEX.unsigned.tar.gz "$idx"
mkdir -p /tmp/root-unsigned
if out="$(apk --root /tmp/root-unsigned --initdb --keys-dir /etc/apk/keys add --no-cache --repository "$BASE" sql-pipe 2>&1)"; then
  fail "apk accepted an unsigned index"
fi
printf '%s\n' "$out" | grep -qiE 'sign|trust' || fail "apk refused for another reason, not the missing signature: $out"
cp /tmp/APKINDEX.signed "$idx"
pass "unsigned index refused by apk"

echo "== negative: a missing trusted key must break apk"
rm -f /etc/apk/keys/vmvarela.rsa.pub /etc/apk/keys/.SIGN.RSA.vmvarela.rsa.pub
mkdir -p /tmp/root-nokey
if out="$(apk --root /tmp/root-nokey --initdb --keys-dir /etc/apk/keys add --no-cache --repository "$BASE" sql-pipe 2>&1)"; then
  fail "apk accepted an index without the trusted key"
fi
printf '%s\n' "$out" | grep -qiE 'sign|trust' || fail "apk refused for another reason, not the missing key: $out"
pass "missing trusted key refused by apk"

echo "E2E OK"
CONTAINER
