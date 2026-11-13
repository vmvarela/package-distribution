#!/usr/bin/env bash
# Downloads the sql-pipe and damas .apk inputs of the APK e2e from public releases (no auth needed).
# Each file is checked against its release sha256sums.txt and against a pinned SHA-256.
# Every release lands in its own subdirectory because --source is a directory and the publisher
# reads sha256sums.txt from it.
set -euo pipefail

APKS="${APK_E2E_APKS:-${TMPDIR:-/tmp}/apk-test}"
mkdir -p "$APKS"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fetch-e2e-apks.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch_release <repo> <version> <package> <file=pin>...
fetch_release() {
  local repo="$1" version="$2" pkg="$3"
  shift 3
  local dir="$APKS/$pkg" base="https://github.com/$repo/releases/download/v$version"
  mkdir -p "$dir" "$TMP/$pkg"
  curl --fail --silent --show-error --location -o "$TMP/$pkg/sha256sums.txt" "$base/sha256sums.txt"

  local spec name pin listed got
  for spec in "$@"; do
    name="${spec%%=*}"
    pin="${spec##*=}"
    curl --fail --silent --show-error --location -o "$TMP/$pkg/$name" "$base/$name"

    listed="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$TMP/$pkg/sha256sums.txt")"
    [ "$listed" = "$pin" ] || { echo "FAIL: release sha256sums.txt for $name does not match pinned $pin" >&2; exit 1; }
    got="$(sha256_of "$TMP/$pkg/$name")"
    [ "$got" = "$pin" ] || { echo "FAIL: $name sha256 $got does not match pinned $pin" >&2; exit 1; }
  done
  # Everything verified: replace the package directory in one move.
  mv "$TMP/$pkg/"* "$dir/"
}

# Pinned from the v0.27.0 (sql-pipe) and v0.1.10 (damas) release sha256sums.txt. Changing them requires a reviewed update.
fetch_release vmvarela/sql-pipe 0.27.0 sql-pipe \
  "sql-pipe_0.27.0_x86_64.apk=4c653adab1476fcbd5c274b0fc7f1cd5956c139c4d0dd9ab52bef262c6254507" \
  "sql-pipe_0.27.0_aarch64.apk=ed9ac79cf75d9d61cbd25ba954ca00543b7964fd0f292122cea17a501e0e1306"

fetch_release vmvarela/damas 0.1.10 damas \
  "damas_0.1.10_x86_64.apk=b12acb9cc5199698879c650fc13f511751ea264a1b91c4ee19c80deadbbe0267" \
  "damas_0.1.10_aarch64.apk=14ac5144adf9d34cc41c450a13a22a94b09eacd11feadb1ede248aece214152d"

echo "OK: sql-pipe 0.27.0 and damas 0.1.10 (x86_64, aarch64) .apk in $APKS"
