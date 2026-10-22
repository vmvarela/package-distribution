# package-distribution

Shared distribution automation for vmvarela projects (Homebrew, APT, RPM, APK, Nix, Scoop, npm, AUR, WinGet).

Project repositories build, package and publish a complete GitHub release. This repository owns the channel catalog and the receiver automation that consumes those releases.

Status: bootstrap. No channel is published yet; the APT publisher, its shadow mode and comparison are implemented and tested locally and in CI.

## APT receiver (local)

`scripts/apt-publish.mjs` builds a signed APT site for one catalog entry from a verified stable release. It verifies every asset against the checksum file and the `.deb` control metadata before writing anything, keeps the current and previous version per package and architecture in the pool, and writes the site to `--out`, with a `.complete` marker last. The index lists only the newest version of each package and architecture. Publication to the destination is outside this script.

```sh
GPG_KEY_ID=<key> node scripts/apt-publish.mjs --catalog catalog/sql-pipe.json --version X.Y.Z \
  --source <dir> --out <new-dir> --state <state-root> --release-date YYYY-MM-DD [--shadow] [--force]
```

- `--origin`, `--label` and `--description` set the Release repository fields; they default to `vmvarela`, `vmvarela` and `vmvarela APT repository`.
- `--state` is the durable state root, read-only (layout in `docs/receivers.md`, section 3a). The run carries forward every other package in it, so a sql-pipe run keeps ghoten and vice versa.
- The candidate state is written beside the site as `<out>.state/`. Promotion, outside this script, replaces the state root with it.
- `--shadow` builds the same candidate and refuses an `--out` inside the state root. It never deploys and never writes the state root. Use it with `scripts/apt-compare.mjs`.
- `--source github` downloads the release assets from the GitHub API (tag `vX.Y.Z`). It refuses draft and prerelease releases. Unit tests cover these checks with a stubbed `fetch`; it has not run against the live API in this repository.
- Exit codes: `1` tool or usage error, `2` version refused (older, or same version with different content), `3` verification failed.
- Requires `dpkg-deb` (metadata) and `gpg` (signing). Missing tools fail; checks are never skipped.
- Same version with identical content is a `noop`: live mode exits 0 without writing. Shadow mode still builds a candidate site and candidate state for comparison, without changing the durable state root. `--force` rebuilds and signs the site even for a `noop`, for regenerating a published site after a publisher change.
- Duplicate architectures are always rejected. Without `--test-subset`, the set must be exactly the catalog architectures (four for sql-pipe, `amd64,arm64` for ghoten).

Test-only exception: `--arches amd64 --test-subset` publishes a partial architecture set. Production runs must use all catalog architectures.

`scripts/apt-compare.mjs --candidate <site> --live <site>` compares the per-architecture `Packages` entries (package, version, all control fields, with missing and empty values treated as equal and hash fields excluded) and the `Release` headers (except `Date`). It does not compare the Release hashed file lists across sites: each site must list both `Packages` and `Packages.gz` for every architecture in its Release, serve every listed file with the listed size and SHA-256 (except `Release`, `InRelease` and `Release.gpg`, which the signature covers), and each `Packages.gz` must decompress to the site's own `Packages`. It checks candidate pool files against the index and retained files against the `<candidate>.state/` manifests, and verifies `Release.gpg` and `InRelease` against the live `key.asc` in an isolated keyring. It prints up to 50 differences and exits `3` on any difference or verification failure.

Tests: `node --test test/apt-publish.test.mjs` skips the signing and metadata cases when `dpkg-deb` or `gpg` is missing. Set `APT_PUBLISH_TEST_REQUIRE_TOOLS=1` to fail instead; CI always sets it, and the macOS host fails without `dpkg-deb`.

`scripts/fetch-e2e-debs.sh` downloads the public `sql-pipe` 0.26.0 and 0.27.0 amd64 `.deb` files from their GitHub releases into `$APT_E2E_DEBS` (default `$TMPDIR/apt-test`). It checks each file against the release `sha256sums.txt` and against a pinned SHA-256, and fails on mismatch.

- `scripts/e2e-apt-docker.sh` repeats the sql-pipe scenario in `debian:stable-slim` (install 0.26.0, upgrade to 0.27.0, refuse downgrade, tampered release, unsigned index, altered pool file). Needs Docker and the `.deb` files; CI runs it (job `apt-e2e`).
- `scripts/e2e-shadow-docker.sh` runs shadow mode in the same image: builds a live site, a ghoten candidate from the state (ghoten `.deb` files are synthetic, built with `dpkg-deb`, not the public release), checks carry-forward, compare, a tampered pool file, a sql-pipe update that keeps ghoten, and a no-op.

CI (`.github/workflows/ci.yml`): syntax checks, catalog tests and validation, publisher tests with `APT_PUBLISH_TEST_REQUIRE_TOOLS=1`, and the Docker e2e. It has read-only permissions and no secrets.

Remaining:

- Durable state lives in `vmvarela/apt-packages`, not here. Its migration, the shadow workflow there, cutover and the dispatch change are separate later PRs, pending approval.
- The publish step is a TOCTOU window between reading the state and writing: no regression test yet.
- `--source github` is not exercised against the live API.
- The real ghoten `.deb` files are not exercised by the e2e; the public release names were checked (`ghoten_1.13.1_{amd64,arm64}.deb`, `sha256sums.txt`).
