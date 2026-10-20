#!/usr/bin/env bash
# End-to-end check of the APT receiver in a clean Debian container. Runs in CI (ci.yml) and locally.
# Test-only exception: amd64 is the only architecture published (--arches amd64 --test-subset).
# Production runs require all four catalog architectures.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEBS="${APT_E2E_DEBS:-${TMPDIR:-/tmp}/apt-test}"
PLATFORM="${APT_E2E_PLATFORM:-linux/amd64}"
IMAGE="${APT_E2E_IMAGE:-debian:stable-slim}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/apt-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Fetches the pinned release .deb inputs when they are missing (public assets, no auth).
for v in 0.26.0 0.27.0; do
  [ -f "$DEBS/sql-pipe_${v}_amd64.deb" ] || "$ROOT/scripts/fetch-e2e-debs.sh"
done

sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
for v in 0.26.0 0.27.0; do
  mkdir -p "$WORK/src/$v"
  cp "$DEBS/sql-pipe_${v}_amd64.deb" "$WORK/src/$v/"
  (cd "$WORK/src/$v" && sha256_file "sql-pipe_${v}_amd64.deb" > sha256sums.txt)
done

docker run --rm -i --platform "$PLATFORM" \
  -v "$ROOT:/work/repo:ro" \
  -v "$WORK:/work/data" \
  "$IMAGE" bash -s <<'CONTAINER'
set -eu
export DEBIAN_FRONTEND=noninteractive TMPDIR=/tmp
apt-get update -qq >/dev/null
apt-get install -y -qq nodejs gnupg python3 ca-certificates >/dev/null
cd /work/repo

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

echo "== publisher and unit tests (dpkg-deb and gpg available)"
APT_PUBLISH_TEST_REQUIRE_TOOLS=1 node --test test/apt-publish.test.mjs >/tmp/unit.log 2>&1 || { cat /tmp/unit.log; fail "unit tests"; }
pass "node --test test/apt-publish.test.mjs"

export GNUPGHOME=/root/gnupg
mkdir -m 700 -p "$GNUPGHOME"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key 'test@invalid' default default never >/dev/null 2>&1
export GPG_KEY_ID=test@invalid

PUB="node scripts/apt-publish.mjs --catalog catalog/sql-pipe.json --state /work/data/state --release-date 2026-10-20 --arches amd64 --test-subset"
publish() { $PUB --version "$1" --source "/work/data/$2" --out "/work/data/$3"; }
promote() {
  rm -rf /srv/www && cp -R "/work/data/$1" /srv/www
  mkdir -p /work/data/state && rm -rf /work/data/state/pool
  cp -R "/work/data/$1/pool" /work/data/state/
  cp "/work/data/$1.state.json" /work/data/state/state.json
}

echo "== publish 0.26.0 and install it through apt"
publish 0.26.0 src/0.26.0 out-0.26.0 || fail "publish 0.26.0"
promote out-0.26.0
python3 -m http.server 8080 --directory /srv/www >/tmp/http.log 2>&1 &
sleep 1
mkdir -p /etc/apt/keyrings
cp /srv/www/key.asc /etc/apt/keyrings/vmvarela-test.asc
echo "deb [signed-by=/etc/apt/keyrings/vmvarela-test.asc] http://127.0.0.1:8080 stable main" > /etc/apt/sources.list.d/vmvarela-test.list
apt-get update -qq >/dev/null 2>&1 || fail "apt update after 0.26.0"
apt-get install -y -qq sql-pipe=0.26.0 >/dev/null 2>&1 || fail "install 0.26.0"
v=$(sql-pipe --version 2>&1) || fail "sql-pipe --version failed: [$v]"
case "$v" in *0.26.0*) ;; *) fail "installed version is not 0.26.0: [$v]" ;; esac
pass "installed sql-pipe 0.26.0 from the signed index"

echo "== publish 0.27.0 and upgrade through apt"
publish 0.27.0 src/0.27.0 out-0.27.0 || fail "publish 0.27.0"
promote out-0.27.0
apt-get update -qq >/dev/null 2>&1 || fail "apt update after 0.27.0"
apt-get install -y -qq sql-pipe >/dev/null 2>&1 || fail "upgrade to 0.27.0"
v=$(sql-pipe --version 2>&1) || fail "sql-pipe --version failed: [$v]"
case "$v" in *0.27.0*) ;; *) fail "installed version is not 0.27.0: [$v]" ;; esac
pass "upgraded to 0.27.0"

echo "== negative: replaying 0.26.0 after 0.27.0 is a downgrade and must be refused"
set +e; publish 0.26.0 src/0.26.0 out-replay >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 2 ] || fail "downgrade exit code $rc, expected 2"
[ ! -e /work/data/out-replay/.complete ] || fail "downgrade left a complete site"
pass "downgrade refused (exit 2), no complete site"

echo "== negative: tampered .deb in the release must be refused before writing"
mkdir -p /work/data/src-bad/0.27.0
cp /work/data/src/0.27.0/sha256sums.txt /work/data/src-bad/0.27.0/
cp /work/data/src/0.27.0/sql-pipe_0.27.0_amd64.deb /work/data/src-bad/0.27.0/
printf 'X' | dd of=/work/data/src-bad/0.27.0/sql-pipe_0.27.0_amd64.deb bs=1 seek=100 conv=notrunc 2>/dev/null
set +e; publish 0.27.0 src-bad/0.27.0 out-bad >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 3 ] || fail "tampered release exit code $rc, expected 3"
[ ! -e /work/data/out-bad ] || fail "tampered release created the output directory"
pass "tampered release refused (exit 3), nothing written"

echo "== negative: unsigned index must be refused by apt"
mkdir -p /tmp/sig && mv /srv/www/dists/stable/InRelease /srv/www/dists/stable/Release.gpg /tmp/sig/
if apt-get update -qq >/dev/null 2>&1; then fail "apt accepted an unsigned index"; fi
mv /tmp/sig/InRelease /tmp/sig/Release.gpg /srv/www/dists/stable/
apt-get update -qq >/dev/null 2>&1 || fail "apt update after restoring signatures"
pass "unsigned index rejected by apt"

echo "== negative: pool .deb altered after indexing must fail the apt hash check"
deb=/srv/www/pool/main/s/sql-pipe/sql-pipe_0.27.0_amd64.deb
cp "$deb" /tmp/good.deb
printf 'X' | dd of="$deb" bs=1 seek=100 conv=notrunc 2>/dev/null
apt-get clean
apt-get update -qq >/dev/null 2>&1 || fail "apt update with altered pool file"
if apt-get install -y -qq --reinstall sql-pipe=0.27.0 >/dev/null 2>&1; then fail "apt installed an altered .deb"; fi
cp /tmp/good.deb "$deb"
pass "altered .deb rejected by apt"

echo "E2E OK"
CONTAINER
