# package-distribution

Shared distribution automation for vmvarela projects (Homebrew, APT, RPM, APK, Nix, Scoop, npm, AUR, WinGet).

Project repositories build, package and publish a complete GitHub release. This repository owns the channel catalog and the receiver automation that consumes those releases.

Status: bootstrap. No channel is active yet.

## APT receiver (local)

`scripts/apt-publish.mjs` builds a signed APT site for one catalog entry from a verified stable release. It verifies every asset against the checksum file and the `.deb` control metadata before writing anything, keeps the current and previous version per architecture, and writes the site to `--out` with a `.complete` marker last. Publication to the destination is outside this script.

```sh
GPG_KEY_ID=<key> node scripts/apt-publish.mjs --catalog catalog/sql-pipe.json --version X.Y.Z \
  --source <dir> --out <new-dir> --state <dir> --release-date YYYY-MM-DD
```

- `--source github` downloads the release assets from the GitHub API (tag `vX.Y.Z`); it is implemented but not exercised here.
- `--state` is read-only: it holds the published `state.json` and `pool/`. The candidate state is written beside the site as `<out>.state.json`.
- Exit codes: `1` tool or usage error, `2` version refused (older, or same version with different content), `3` verification failed.
- Requires `dpkg-deb` (metadata) and `gpg` (signing). Missing tools fail; checks are never skipped.

Test-only exception: `--arches amd64 --test-subset` publishes a partial architecture set. Production runs must use all four catalog architectures.

`scripts/e2e-apt-docker.sh` repeats the scenario in `debian:stable-slim` (install 0.26.0, upgrade to 0.27.0, refuse downgrade, tampered release, unsigned index, altered pool file). It is manual and not part of CI; it needs Docker and the test `.deb` files in `$TMPDIR/apt-test` (override with `APT_E2E_DEBS`).
