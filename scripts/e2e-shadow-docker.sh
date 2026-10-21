#!/usr/bin/env bash
# Shadow-mode check of the APT receiver in a clean Debian container: candidate sites are built from a
# state root and compared with a live site. Nothing is deployed and the state root is never written.
# Ghoten inputs are synthetic .deb files built with dpkg-deb in the container (not the public release).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEBS="${APT_E2E_DEBS:-${TMPDIR:-/tmp}/apt-test}"
PLATFORM="${APT_E2E_PLATFORM:-linux/amd64}"
IMAGE="${APT_E2E_IMAGE:-debian:stable-slim}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/apt-shadow.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

for v in 0.26.0 0.27.0; do
  [ -f "$DEBS/sql-pipe_${v}_amd64.deb" ] || "$ROOT/scripts/fetch-e2e-debs.sh"
done
mkdir -p "$WORK/src/sql-pipe/0.26.0" "$WORK/src/sql-pipe/0.27.0"
for v in 0.26.0 0.27.0; do
  cp "$DEBS/sql-pipe_${v}_amd64.deb" "$WORK/src/sql-pipe/$v/"
  (cd "$WORK/src/sql-pipe/$v" && shasum -a 256 "sql-pipe_${v}_amd64.deb" > sha256sums.txt)
done

docker run --rm -i --platform "$PLATFORM" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$ROOT:/work/repo:ro" \
  -v "$WORK:/work/data" \
  "$IMAGE" bash -s <<'CONTAINER'
set -eu
trap 'chown -R "$HOST_UID:$HOST_GID" /work/data 2>/dev/null || true' EXIT
export DEBIAN_FRONTEND=noninteractive TMPDIR=/tmp
apt-get update -qq >/dev/null
apt-get install -y -qq nodejs gnupg ca-certificates >/dev/null
cd /work/repo

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
D=/work/data

export GNUPGHOME=/root/gnupg
mkdir -m 700 -p "$GNUPGHOME"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key 'test@invalid' default default never >/dev/null 2>&1
export GPG_KEY_ID=test@invalid

echo "== synthetic ghoten 1.13.1 fixtures (amd64, arm64) with dpkg-deb"
mkdir -p "$D/src/ghoten/1.13.1"
for arch in amd64 arm64; do
  stage="$D/stage-$arch"
  mkdir -p "$stage/DEBIAN" "$stage/usr/bin"
  printf 'Package: ghoten\nVersion: 1.13.1\nArchitecture: %s\nMaintainer: t <t@invalid>\nDescription: shadow fixture\n' "$arch" > "$stage/DEBIAN/control"
  printf '#!/bin/sh\necho 1.13.1\n' > "$stage/usr/bin/ghoten"; chmod 755 "$stage/usr/bin/ghoten"
  dpkg-deb --root-owner-group --build "$stage" "$D/src/ghoten/1.13.1/ghoten_1.13.1_${arch}.deb" >/dev/null
done
(cd "$D/src/ghoten/1.13.1" && sha256sum ghoten_1.13.1_amd64.deb ghoten_1.13.1_arm64.deb > sha256sums.txt)
pass "built ghoten 1.13.1 fixtures"

PUB_SP="node scripts/apt-publish.mjs --catalog catalog/sql-pipe.json --release-date 2026-10-20 --arches amd64 --test-subset --state $D/state"
PUB_GH="node scripts/apt-publish.mjs --catalog catalog/ghoten.json --release-date 2026-10-20 --state $D/state"
APT_COMPARE="node scripts/apt-compare.mjs"
tree() { (cd "$1" && find . -type f -exec sha256sum {} + | sort); }

echo "== live site: sql-pipe 0.26.0 promoted to the state root"
$PUB_SP --version 0.26.0 --source "$D/src/sql-pipe/0.26.0" --out "$D/live" || fail "publish sql-pipe 0.26.0"
mkdir -p "$D/state"
cp -R "$D/live.state/." "$D/state/"
rm -rf "$D/state.live" && cp -R "$D/state" "$D/state.live"
pass "live site and state root built"

echo "== shadow: ghoten 1.13.1 candidate from the state root"
$PUB_GH --version 1.13.1 --source "$D/src/ghoten/1.13.1" --out "$D/shadow-gh" --shadow || fail "shadow publish ghoten"
diff -r "$D/state.live" "$D/state" >/dev/null || fail "shadow publish wrote into the state root"
grep -q '^Package: sql-pipe$' "$D/shadow-gh/dists/stable/main/binary-amd64/Packages" || fail "candidate lost sql-pipe (carry-forward)"
grep -q '^Package: ghoten$' "$D/shadow-gh/dists/stable/main/binary-arm64/Packages" || fail "candidate lacks ghoten arm64"
grep -q '^Architectures: amd64 arm64$' "$D/shadow-gh/dists/stable/Release" || fail "unexpected architecture set in Release"
pass "candidate keeps sql-pipe and adds ghoten; state root untouched"

echo "== compare: candidate differs from live (ghoten is new) and is signed by the live key"
set +e; out=$($APT_COMPARE --candidate "$D/shadow-gh" --live "$D/live" 2>&1); rc=$?; set -e
[ "$rc" = 3 ] || fail "compare exit $rc, expected 3 for a new package"
case "$out" in *"only in candidate: ghoten 1.13.1"*) ;; *) fail "compare did not report ghoten: $out" ;; esac
case "$out" in *"does not verify"*|*"does not match"*) fail "signature or pool check failed: $out" ;; esac
pass "compare reports the new ghoten entry (exit 3), signatures verify"

echo "== negative: a candidate pool file altered after indexing must fail the compare"
cp -R "$D/shadow-gh" "$D/shadow-bad"
printf 'X' | dd of="$D/shadow-bad/pool/main/g/ghoten/ghoten_1.13.1_amd64.deb" bs=1 seek=100 conv=notrunc 2>/dev/null
set +e; out=$($APT_COMPARE --candidate "$D/shadow-bad" --live "$D/live" 2>&1); rc=$?; set -e
[ "$rc" = 3 ] || fail "tampered pool exit $rc, expected 3"
case "$out" in *"does not match its SHA256"*) ;; *) fail "tampered pool not reported: $out" ;; esac
pass "altered pool file detected (exit 3)"

echo "== after a hypothetical cutover, a sql-pipe update must keep ghoten"
rm -rf "$D/state-sim" && cp -R "$D/shadow-gh.state" "$D/state-sim"
node scripts/apt-publish.mjs --catalog catalog/sql-pipe.json --release-date 2026-10-20 --arches amd64 --test-subset \
  --version 0.27.0 --source "$D/src/sql-pipe/0.27.0" --out "$D/shadow-sp" --state "$D/state-sim" --shadow || fail "shadow publish sql-pipe 0.27.0"
grep -q '^Package: ghoten$' "$D/shadow-sp/dists/stable/main/binary-amd64/Packages" || fail "sql-pipe update dropped ghoten"
set +e; out=$($APT_COMPARE --candidate "$D/shadow-sp" --live "$D/shadow-gh" 2>&1); rc=$?; set -e
[ "$rc" = 3 ] || fail "compare exit $rc, expected 3 for the sql-pipe update"
case "$out" in *"missing in candidate"*) fail "candidate dropped a package: $out" ;; esac
case "$out" in *"only in candidate: sql-pipe 0.27.0"*) ;; *) fail "sql-pipe 0.27.0 not reported: $out" ;; esac
pass "sql-pipe 0.27.0 keeps ghoten 1.13.1; only the sql-pipe change differs"

echo "== no-op shadow: the same version builds a candidate site for comparison"
# state-sim already holds ghoten 1.13.1, so no promotion is needed; shadow still materializes it.
tree "$D/state-sim" > "$D/state-before-noop"
node scripts/apt-publish.mjs --catalog catalog/ghoten.json --release-date 2026-10-20 --version 1.13.1 \
  --source "$D/src/ghoten/1.13.1" --out "$D/noop" --state "$D/state-sim" --shadow || fail "no-op shadow run failed"
[ -f "$D/noop/.complete" ] && [ -f "$D/noop/dists/stable/Release" ] || fail "no-op shadow run did not build a candidate site"
$APT_COMPARE --candidate "$D/noop" --live "$D/shadow-gh" || fail "identical no-op candidate did not match live"
tree "$D/state-sim" > "$D/state-after-noop"
diff -u "$D/state-before-noop" "$D/state-after-noop" || fail "no-op shadow run changed durable state"
pass "same-version shadow candidate matches live; durable state untouched"

echo "SHADOW E2E OK"
CONTAINER
