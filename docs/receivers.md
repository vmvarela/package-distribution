# Shared package receivers: design

Status: design in progress. Implemented: the APT publisher (`scripts/apt-publish.mjs`), its unit tests and the Docker e2e (`scripts/e2e-apt-docker.sh`), run in CI on Linux. Pending: real publication, GitHub Pages, promotion, and the RPM, APK, Nix and Scoop receivers.

## 1. Current problem

Facts checked against the default branches of each repository on the day of writing.

| Receiver | Triggers | Problems |
|---|---|---|
| `vmvarela/apt-packages` (`update.yml`) | `update-sql-pipe`, `update-ghoten` | Rebuilds the whole index from scratch for sql-pipe and ghoten. Target mapping sets `ghoten`, but the guard at line ~137 compares against `ghoton`, so the "Ghoten-triggered rebuild requires both DEB packages" check never fires. |
| `vmvarela/rpm-packages` (`update.yml`) | `update-sql-pipe` only | Asset downloads use `curl ... 2>/dev/null` inside `if`, so a failed download is skipped silently. GPG signing is optional (warning if key missing). Generated `.repo` sets `gpgcheck=0` and `repo_gpgcheck=1`. |
| `vmvarela/apk-packages` (`update.yml`) | `update-sql-pipe` only | Downloads use `curl ... 2>/dev/null` inside `if`; failures are skipped silently. Index signing is optional. Index generation uses `--allow-untrusted`. |
| `vmvarela/nix-packages` (`update.yml`) | `update-sql-pipe` only | Rewrites `versions.json` from the release `sha256sums.txt`. The producer already performs the same update, so the work is duplicated. |
| `vmvarela/scoop-bucket` | none | Holds `bucket/damas.json` and `bucket/sql-pipe.json`. No receiver workflow. |
| `vmvarela/damas` | dispatches `update-damas` | No receiver exists for that event. Not re-verified in this pass. |

Consequences: partial failures can publish incomplete or unsigned repositories without an error; there is no shared definition of which assets a channel needs; each receiver encodes its own event names and version logic.

## 2. Declarative catalog contract

Decided: one catalog file per project, `catalog/<project>.json` in this repository. JSON, no YAML. The catalog is data only: no secrets and no workflow logic.

Fields (as implemented by `catalog/sql-pipe.json` and `scripts/validate-catalog.mjs`):

- `repo`: source repository, e.g. `vmvarela/sql-pipe`.
- `checksums`: name of the checksum asset (`sha256sums.txt`) that every asset must match.
- `channels`: per channel, the target repository and `assets` (architecture to file name template with `{version}`). Only `apt` is defined today.
- `channels.apt.architectures` (optional): explicit subset of `amd64`, `arm64`, `armhf`, `i386`. Must be non-empty, unique, and match the keys of `assets` exactly. Absent means all four, as for `sql-pipe`. `ghoten` declares `amd64` and `arm64` only.

Phase 1 covers `sql-pipe` and `ghoten`, APT only.

## 3. Receiver contract

Input: a catalog entry plus a release tag or version. The receiver never guesses assets from the repository state.

Guarantees (all receivers):

- Rejects the run if any required asset is missing or its SHA-256 does not match the checksum asset. The APT publisher also checks the `.deb` control metadata before writing.
- A failure before deployment keeps the previous published state; nothing is partially promoted.
- An ambiguous failure after deployment may leave either the old or the new state live. Recovery reconciles the destination with the catalog; the next trigger or the recovery sync converges.
- Keeps the current and previous version per app and architecture for APT, RPM and APK. Retention is per channel.
- Idempotent: re-running the same tag produces the same published state.
- No downgrade: a version lower than the currently published one is refused unless explicitly forced by a maintainer.
- Concurrency per destination: GitHub's default concurrency keeps one running and one pending run; extra triggers replace the pending one. `queue: max` allows up to 100 pending runs, but without ordering guarantees. `cancel-in-progress: false` does not preserve all pending runs. Design rule: receivers must converge from the current catalog and published state, not from the sequence of triggers.

Errors:

- Retry only bounded, repeatable operations (downloads, GET requests, API reads), with a fixed small attempt count.
- Never retry ambiguous writes (pushes to Pages, branch commits, index publication). Fail and report; the next trigger or recovery sync converges.
- Download failure is an error, never a skip.

Secrets:

- Cross-repo access uses the classic token `PACKAGE_DISTRIBUTION_TOKEN`: one token, stored in each producer repository. Classic PATs cannot be scoped to a single repository, so it is not per destination and its scope is broad.
- GPG (APT, RPM) and APK signing keys live in the repository that publishes that channel, not here.
- Missing signing key on a signed channel is a failure, not a warning.

## 3a. APT durable state

The durable state lives in `vmvarela/apt-packages`, not in this repository. This section is the contract that repository implements. It is not yet implemented there.

Layout, read by `scripts/apt-publish.mjs --state <root>`:

```text
state/<package>/state.json
state/<package>/pool/<file>.deb        retained .deb files of that package
```

`state.json` (schema_version 1): `{"schema_version":1,"package":"<name>","architectures":{"<arch>":[{"version":"X.Y.Z","sha256":"<hex>","file":"<name>.deb"}]}}`. Newest first, at most two entries per architecture (current and previous). Every `file` must exist in `pool/` with the recorded SHA-256; a missing or altered file fails the run.

Rules:

- A publish run updates one package (the triggered one) and carries forward every other package in the state unchanged. Updating sql-pipe never drops ghoten, and the reverse.
- Retention is per package and per architecture: exactly one current and one previous version. An architecture without a new candidate is carried forward unchanged, never rotated alone.
- The site contains every package in the state. The index for each architecture lists each package's newest version; retained previous versions stay in the pool but not in the index.
- The publisher writes nothing to the state root. Its candidate state is `<out>.state/` with the same layout; promotion replaces the state root with it after the site is verified and deployed.

Shadow mode (`--shadow`) builds the candidate from the state root and the triggered package, and refuses an output inside the state root. `scripts/apt-compare.mjs --candidate <site> --live <site>` then compares the candidate with the live site (per-architecture entries including all control fields, and `Release` headers except `Date`), verifies that each site lists both index files per architecture, serves every file its own Release lists with the listed size and SHA-256, and that each `Packages.gz` matches its `Packages`. It also checks indexed and retained candidate files against their manifests, and verifies the candidate's signatures against the live `key.asc`. Any difference exits `3`. Shadow never deploys.

Not part of this change: migrating the existing `apt-packages` layout to this state, the shadow workflow in `apt-packages`, cutover, and the change of the dispatch flow. Those are separate PRs and need explicit approval.

## 4. Triggering

Agreed by the user:

- Automatic, immediate: a `repository_dispatch` is sent after a project publishes a complete release (all assets present).
- Periodic recovery sync: a scheduled run reconciles every destination against its catalog entries, so missed dispatches converge.
- Manual: `workflow_dispatch` with tag/version input.

Scheduled-workflow limits:

- GitHub scheduled runs can be delayed under load; they are not exact.
- Scheduled workflows are disabled in public repositories after 60 days without repository activity. Decided: accept a documented manual re-enable of the schedules; no artificial keep-alive.

## 5. Decisions and open items

Decided:

1. Catalog location and format: one JSON file per project in `catalog/<project>.json` (section 2).
2. Phase 1 is `sql-pipe` and `ghoten`, APT only, and APT comes first. RPM, APK, Nix and Scoop follow in later phases. RPM, APK, Nix and Scoop follow in later phases.
3. Retention is per channel (APT keeps current and previous).
4. Scheduled sync after 60 days of inactivity: manual re-enable, documented.
5. Nix has a single writer for `versions.json`, not both producer and receiver.
6. Signing: each destination has its own signing key. APT, RPM and APK are signed; `--allow-untrusted` is not used; unsigned repositories are not allowed.
7. Scoop gets a receiver after APT, not before.

Open (need the user):

1. Whether `damas` joins the first phase or waits for its receiver to be designed.
2. Which side is the single writer for Nix `versions.json`: the producer or the receiver. Section 1 shows the receiver today duplicates the producer.
3. Whether Nix consumes the catalog at all.

Risks:

- Silent download skips already exist in RPM and APK; migrating them without fixing this would hide regressions.
- A single classic token with broad scope spans several destinations.
- Duplicate producer/receiver logic (Nix) can drift from the source of truth.
- Dispatch events are not durable; the recovery sync is required, not optional.

## 6. Validation plan (per phase)

Phase 1, one channel (APT, sql-pipe and ghoten):

- Linux CI: syntax checks, catalog tests, publisher tests with required tools (no skips), and the Docker e2e (`scripts/e2e-apt-docker.sh`) with pinned release inputs (`scripts/fetch-e2e-debs.sh`).
- Shadow e2e (`scripts/e2e-shadow-docker.sh`): carry-forward between packages, comparison with the live site, altered pool file, and no-op. Ghoten inputs are synthetic.
- Real install on a clean Debian/Ubuntu container with `apt`; verify the installed version and signature check (covered by the e2e).
- Repeat trigger with the same tag: no change in published index (idempotence). Not yet tested.

Phase 2, RPM, APK, Nix, Scoop:

- `dnf` install on Fedora container, `apk add` on Alpine, `nix profile install` from the flake, `scoop install` on Windows runner, and `brew` where applicable.

Negative tests in every phase:

- Failed download of one asset: receiver fails, previously published state still installable.
- Wrong SHA-256 in checksum file: receiver rejects, nothing published (covered for APT by unit tests and the e2e).
- Concurrency: two triggers for the same destination converge to the newest catalog state; none is assumed to be preserved by the queue.
- Replay: an older tag after a newer one is refused (no downgrade; covered for APT by the e2e).
- Recovery: suppress one dispatch, run the periodic sync, and confirm convergence.

Each phase is merged only after its checks pass on the default branch of the destination repository.
