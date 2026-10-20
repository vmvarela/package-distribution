#!/usr/bin/env bash
# Downloads the sql-pipe amd64 .deb inputs of the APT e2e from public releases (no auth needed).
# Each file is checked against its release sha256sums.txt and against a pinned SHA-256.
set -euo pipefail

REPO="vmvarela/sql-pipe"
DEBS="${APT_E2E_DEBS:-${TMPDIR:-/tmp}/apt-test}"
mkdir -p "$DEBS"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fetch-e2e-debs.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Pinned from the v0.26.0 and v0.27.0 release sha256sums.txt. Changing them requires a reviewed update.
PIN_0_26_0=d3163d24eb1d67037be9a52234f6033d0f1ee7b8a92ede996b4e29f16f7dc3c1
PIN_0_27_0=68c761e657fd9a9add00a9504b5a409201fe684127b6b898efd7d3433b41219a

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch_one() {
  local v="$1" pin="$2" name="sql-pipe_$1_amd64.deb" base="https://github.com/$REPO/releases/download/v$1"
  mkdir -p "$TMP/$v"
  curl --fail --silent --show-error --location -o "$TMP/$v/sha256sums.txt" "$base/sha256sums.txt"
  curl --fail --silent --show-error --location -o "$TMP/$v/$name" "$base/$name"

  local listed got
  listed="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$TMP/$v/sha256sums.txt")"
  [ "$listed" = "$pin" ] || { echo "FAIL: release sha256sums.txt for $name does not match pinned $pin" >&2; exit 1; }
  got="$(sha256_of "$TMP/$v/$name")"
  [ "$got" = "$pin" ] || { echo "FAIL: $name sha256 $got does not match pinned $pin" >&2; exit 1; }
  mv "$TMP/$v/$name" "$DEBS/$name"
}

fetch_one 0.26.0 "$PIN_0_26_0"
fetch_one 0.27.0 "$PIN_0_27_0"
echo "OK: sql-pipe 0.26.0 and 0.27.0 amd64 .deb in $DEBS"
