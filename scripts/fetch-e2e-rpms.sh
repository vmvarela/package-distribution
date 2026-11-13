#!/usr/bin/env bash
# Downloads the sql-pipe and damas .rpm inputs of the RPM e2e from public releases (no auth needed).
# Each file is checked against its release sha256sums.txt and against a pinned SHA-256.
# Every release lands in its own subdirectory because --source is a directory and the publisher
# reads sha256sums.txt from it.
set -euo pipefail

RPMS="${RPM_E2E_RPMS:-${TMPDIR:-/tmp}/rpm-test}"
mkdir -p "$RPMS"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fetch-e2e-rpms.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch_release <repo> <version> <package> <file=pin>...
fetch_release() {
  local repo="$1" version="$2" pkg="$3"
  shift 3
  local dir="$RPMS/$pkg" base="https://github.com/$repo/releases/download/v$version"
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
  "sql-pipe-0.27.0-1.x86_64.rpm=5895f462412d0a53203d90fdc9d6edd20be9d3b67e80d83ec779355f9a2f00e9" \
  "sql-pipe-0.27.0-1.aarch64.rpm=adb25167771453a71ea45c59648a1752f88d86afc24083de16b27d5177c3a9e1"

fetch_release vmvarela/damas 0.1.10 damas \
  "damas-0.1.10-1.x86_64.rpm=e795e6d77b08a580b05a8839d76f97732d52757dcda964dafdc1e23404c686fe" \
  "damas-0.1.10-1.aarch64.rpm=6116fb0337772d5414438cd38102d82981248b83536b2d122361d41af5100fd5"

echo "OK: sql-pipe 0.27.0 and damas 0.1.10 (x86_64, aarch64) .rpm in $RPMS"
