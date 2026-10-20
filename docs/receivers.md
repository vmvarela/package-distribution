# Shared package receivers: design

Status: proposal. Implemented locally: the APT publisher (`scripts/apt-publish.mjs`) and its manual Docker e2e check. Pending: real publication, GitHub Pages, CI, promotion, and RPM/APK/Nix/Scoop receivers.

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

One catalog entry per project, stored in this repository (`catalog/<project>.json`, format to be decided):

- `repo`: source repository, e.g. `vmvarela/sql-pipe`.
- `channels`: subset of `apt`, `rpm`, `apk`, `nix`, `scoop`, with per-channel target repository.
- `architectures`: release architectures per channel (e.g. `amd64`, `arm64`; `x86_64`, `aarch64`).
- `asset_pattern`: template with `{version}`, `{arch}`, `{os}` placeholders, e.g. `sql-pipe-{arch}-linux`.
- `checksums`: name of the checksum asset (e.g. `sha256sums.txt`) that every asset must match.
- `version_source`: how the version is read from the release tag (`vX.Y.Z` strip rule).

The catalog is data only. It contains no secrets and no workflow logic.

## 3. Receiver contract

Input: a catalog entry plus a release tag or version. The receiver never guesses assets from the repository state.

Guarantees (all receivers):

- Rejects the run if any required asset is missing or its SHA-256 does not match the checksum asset.
- On failure, the last valid published state stays live. Nothing is partially promoted.
- Keeps the current and previous version per app and architecture for APT, RPM and APK.
- Idempotent: re-running the same tag produces the same published state.
- No downgrade: a version lower than the currently published one is refused unless explicitly forced by a maintainer.
- Serialized per destination with `concurrency: { group: <destination>, cancel-in-progress: false }` (queue, never cancel).

Errors:

- Retry only bounded, repeatable operations (downloads, GET requests, API reads), with a fixed small attempt count.
- Never retry ambiguous writes (pushes to Pages, branch commits, index publication). Fail and report; the next trigger or recovery sync converges.
- Download failure is an error, never a skip.

Secrets:

- Cross-repo access uses the classic token `PACKAGE_DISTRIBUTION_TOKEN`, scoped per destination repository.
- GPG (APT, RPM) and APK signing keys live in the repository that publishes that channel, not here.
- Missing signing key on a signed channel is a failure, not a warning.

## 4. Triggering

Agreed by the user:

- Automatic, immediate: a `repository_dispatch` is sent after a project publishes a complete release (all assets present).
- Periodic recovery sync: a scheduled run reconciles every destination against its catalog entries, so missed dispatches converge.
- Manual: `workflow_dispatch` with tag/version input.

Scheduled-workflow limits to account for:

- GitHub scheduled runs can be delayed under load; they are not exact.
- Scheduled workflows are disabled in public repositories after 60 days without repository activity. The sync must be re-enabled manually or kept alive by a documented activity source; decide which (see section 5).

## 5. Open decisions and risks

Open decisions (not answered; need the user):

1. Catalog location and format: single file or one file per project? JSON or YAML?
2. Whether `damas` joins the first phase or waits for its receiver to be designed.
3. Retention depth: "current + previous" for every channel, or per-channel different values?
4. Keep-alive for the recovery sync after 60 days of inactivity: accept manual re-enable, or add a documented activity source?
5. Whether Nix should consume the catalog at all, or stop updating `versions.json` from the receiver and rely solely on the producer.
6. Who owns the APK and RPM signing keys after migration, and whether unsigned repositories are allowed for any channel.
7. Scoop: create a receiver workflow in `scoop-bucket`, or keep manual manifest updates for now.

Risks:

- Silent download skips already exist in RPM and APK; migrating them without fixing this would hide regressions.
- A single classic token with broad scope spans several destinations.
- Duplicate producer/receiver logic (Nix) can drift from the source of truth.
- Dispatch events are not durable; the recovery sync is required, not optional.

## 6. Validation plan (per phase)

Phase 1, one channel (APT, sql-pipe):

- Real install on a clean Debian/Ubuntu container with `apt`; verify the installed version and signature check.
- Repeat trigger with the same tag: no change in published index (idempotence).

Phase 2, RPM, APK, Nix, Scoop:

- `dnf` install on Fedora container, `apk add` on Alpine, `nix profile install` from the flake, `scoop install` on Windows runner, and `brew` where applicable.

Negative tests in every phase:

- Failed download of one asset: receiver fails, previously published state still installable.
- Wrong SHA-256 in checksum file: receiver rejects, nothing published.
- Concurrency: two triggers for the same destination are serialized, none cancelled.
- Replay: an older tag after a newer one is refused (no downgrade).
- Recovery: suppress one dispatch, run the periodic sync, and confirm convergence.

Each phase is merged only after its checks pass on the default branch of the destination repository.
