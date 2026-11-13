// Builds a signed RPM repository for one catalog entry from a verified stable release. Stdlib only.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { EXIT, PublishError, decideAction, downloadRelease, nextArchitectures, parseSha256Sums, parseVersion, sha256 } from "./apt-publish.mjs";
import { RPM_ARCHES, validateCatalog } from "./validate-catalog.mjs";

const run = promisify(execFile);
const ARCHES = RPM_ARCHES;
const NAME = /^[A-Za-z0-9._-]+$/;
const KEYRING_FILE = "RPM-GPG-KEY-vmvarela";

// The durable state uses the APT layout (docs/receivers.md, section 3a): <state>/<package>/state.json and pool/.
const pkgStateDir = (root, pkg) => join(root, pkg);

export function defaultBaseUrl(repo) {
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}`;
}

export function repoFile({ baseUrl }) {
  return [
    "[vmvarela]",
    "name=vmvarela tools",
    `baseurl=${baseUrl}/packages/$basearch`,
    // Packages are signed by the receiver; the metadata is signed separately. Neither check is optional.
    "gpgcheck=1",
    "repo_gpgcheck=1",
    // dnf5 downgrades a missing or bad repomd signature to a warning unless this is set, so consumers get it too.
    "skip_if_unavailable=0",
    `gpgkey=${baseUrl}/${KEYRING_FILE}`,
    "enabled=1",
    "",
  ].join("\n");
}

export function selectArches(catalog, requested, testSubset) {
  const all = Object.keys(catalog.channels.rpm.assets);
  if (!requested) return all;
  const arches = requested.split(",").map((a) => a.trim());
  for (const arch of arches) {
    if (!all.includes(arch)) throw new PublishError(`architecture "${arch}" is not in the catalog`, EXIT.tool);
  }
  if (new Set(arches).size !== arches.length) throw new PublishError(`duplicate architecture in "${requested}"`, EXIT.tool);
  if (arches.length !== all.length && !testSubset) {
    throw new PublishError("partial architectures are test-only: pass --test-subset explicitly", EXIT.tool);
  }
  return arches;
}

const assetName = (catalog, version, arch) => catalog.channels.rpm.assets[arch].replaceAll("{version}", version);

async function rpm(args, exitCode = EXIT.verify) {
  try {
    return (await run("rpm", args, { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("rpm not found: install rpm to read and sign packages", EXIT.tool);
    const err = e.stderr?.trim() || e.message;
    if (/rpmsign/.test(err)) throw new PublishError(`rpmsign not found: install the rpm signing helper (rpm-sign on Fedora, rpmsign on Debian): ${err}`, EXIT.tool);
    throw new PublishError(`rpm failed: ${err}`, exitCode);
  }
}

async function rpmkeys(args) {
  try {
    return (await run("rpmkeys", args, { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("rpmkeys not found: install rpm", EXIT.tool);
    throw new PublishError(`rpmkeys failed: ${e.stderr?.trim() || e.message}`, EXIT.verify);
  }
}

async function gpg(args, exitCode = EXIT.tool) {
  try {
    return (await run("gpg", ["--batch", "--yes", ...args], { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("gpg not found", EXIT.tool);
    throw new PublishError(`gpg failed: ${e.stderr?.trim() || e.message}`, exitCode);
  }
}

async function createrepo(dir) {
  try {
    // gz keeps the metadata readable by older dnf/yum builds; createrepo_c otherwise picks zstd.
    await run("createrepo_c", ["--quiet", "--general-compress-type", "gz", dir], { maxBuffer: 1 << 22 });
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("createrepo_c not found: install createrepo-c", EXIT.tool);
    throw new PublishError(`createrepo_c failed: ${e.stderr?.trim() || e.message}`, EXIT.verify);
  }
}

async function readStates(stateRoot) {
  const states = new Map();
  if (!existsSync(stateRoot)) return states;
  if (existsSync(join(stateRoot, "state.json"))) throw new PublishError("legacy flat state layout: migrate to <package>/state.json first", EXIT.tool);
  for (const entry of await readdir(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const file = join(pkgStateDir(stateRoot, entry.name), "state.json");
    if (!existsSync(file)) continue;
    const state = JSON.parse(await readFile(file, "utf8"));
    if (state.schema_version !== 1 || state.package !== entry.name) throw new PublishError(`unexpected state file: ${file}`, EXIT.tool);
    // Retained versions become path segments and hashes are compared: validate every entry before use.
    for (const [arch, entries] of Object.entries(state.architectures ?? {})) {
      if (!ARCHES.includes(arch) || !Array.isArray(entries)) throw new PublishError(`unexpected state file: ${file}`, EXIT.tool);
      for (const e of entries) {
        parseVersion(e.version);
        if (!/^[0-9a-f]{64}$/.test(e.sha256) || typeof e.file !== "string" || !NAME.test(e.file)) throw new PublishError(`unexpected state file: ${file}`, EXIT.tool);
      }
    }
    states.set(entry.name, state);
  }
  return states;
}

// Verifies metadata from a private copy of the bytes that were checksummed, never from the source path.
async function withSnapshot(buf, fn) {
  const dir = await mkdtemp(join(tmpdir(), "rpm-publish-"));
  try {
    const file = join(dir, "snapshot.rpm");
    await writeFile(file, buf);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --addsign rewrites the file in place and embeds a fresh signature timestamp, so the site copy is signed
// while the durable state keeps the exact release asset bytes.
async function signPackage(file, gpgKeyId) {
  await rpm(["--define", `_gpg_name ${gpgKeyId}`, "--addsign", file], EXIT.tool);
}

// rpm 6 reports the signature in stderr as NOKEY and returns "(none)" from the query format, so the package
// signature is verified the way a client does: import the public key into a private rpmdb and check the file.
async function openKeyring(publicKey) {
  const db = await mkdtemp(join(tmpdir(), "rpm-keys-"));
  const pub = join(db, "pub.asc");
  await writeFile(pub, publicKey);
  await rpm(["--dbpath", db, "--import", pub]);
  return db;
}

async function verifyPackage(file, keyring) {
  const out = await rpmkeys(["--dbpath", keyring, "--checksig", file]);
  if (!/signatures OK/.test(out)) throw new PublishError(`${file}: signature check failed: ${out.trim()}`, EXIT.verify);
}

// Pure-ish orchestration: every check runs before the first write to out.
// Writes only to out and the candidate state <out>.state/; never to stateRoot. Shadow runs are the same, plus a guard.
export async function publish({ catalog, version, sourceDir, out, stateDir, arches, gpgKeyId, baseUrl, testSubset = false, shadow = false, force = false }) {
  parseVersion(version);
  const errors = validateCatalog(catalog);
  if (errors.length) throw new PublishError(errors.join("; "), EXIT.tool);
  if (!gpgKeyId) throw new PublishError("GPG_KEY_ID is required to sign packages and metadata", EXIT.tool);
  // gpg --export exits 0 with no output for an unknown key id, so fail here instead of at the first signing step.
  const publicKey = await gpg(["--armor", "--export", gpgKeyId]);
  if (!publicKey.trim()) throw new PublishError(`gpg has no public key for ${gpgKeyId}: check GPG_KEY_ID`, EXIT.tool);
  const channel = catalog.channels.rpm;
  const selected = selectArches(catalog, arches, testSubset);
  const stateOut = `${out}.state`;
  const inside = (dir, root) => {
    const rel = relative(resolve(root), resolve(dir));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (inside(out, stateDir) || inside(stateOut, stateDir)) {
    throw new PublishError("output must not be inside the state directory", EXIT.tool);
  }
  const states = await readStates(stateDir);
  const state = states.get(channel.package) ?? null;

  let sums;
  try {
    sums = parseSha256Sums(await readFile(join(sourceDir, catalog.checksums), "utf8"));
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError(`checksum file unreadable: ${catalog.checksums}`, EXIT.verify);
  }

  const candidates = new Map();
  for (const arch of selected) {
    const name = assetName(catalog, version, arch);
    let buf;
    try {
      buf = await readFile(join(sourceDir, name));
    } catch {
      throw new PublishError(`missing asset: ${name}`, EXIT.verify);
    }
    if (!sums.has(name)) throw new PublishError(`not listed in ${catalog.checksums}: ${name}`, EXIT.verify);
    const hash = sha256(buf);
    if (hash !== sums.get(name)) throw new PublishError(`sha256 mismatch: ${name}`, EXIT.verify);
    candidates.set(arch, { version, sha256: hash, file: name, buf });
  }
  for (const [arch, cand] of candidates) {
    const fields = (await withSnapshot(cand.buf, (file) => rpm(["-qp", "--queryformat", "%{NAME} %{VERSION} %{ARCH}", file]))).trim().split(" ");
    const [name, ver, rpmArch] = fields;
    if (name !== channel.package || ver !== version || rpmArch !== arch) {
      throw new PublishError(`${cand.file}: metadata is ${name} ${ver} ${rpmArch}, expected ${channel.package} ${version} ${arch}`, EXIT.verify);
    }
  }

  const action = decideAction(state, candidates);
  if (action === "noop" && !shadow && !force) return { action, version };

  if (existsSync(out) && (await readdir(out)).length) throw new PublishError(`${out} is not empty; remove it before publishing`, EXIT.tool);
  if (existsSync(stateOut) && (await readdir(stateOut)).length) throw new PublishError(`${stateOut} is not empty; remove it before publishing`, EXIT.tool);
  await mkdir(out, { recursive: true });

  // Every package in the state (plus the triggered one) is rebuilt into the site; only the triggered one gets new candidates.
  const names = new Set([...states.keys(), channel.package]);
  const plan = new Map();
  for (const pkg of names) {
    const next = pkg === channel.package ? nextArchitectures(state, candidates) : nextArchitectures(states.get(pkg), new Map());
    plan.set(pkg, next);
  }

  const keyring = await openKeyring(publicKey);
  try {
    for (const [pkg, next] of plan) {
      const statePool = join(pkgStateDir(stateOut, pkg), "pool");
      await mkdir(statePool, { recursive: true });
      for (const [arch, entries] of Object.entries(next)) {
        const dir = join(out, "packages", arch);
        await mkdir(dir, { recursive: true });
        for (const entry of entries) {
          let buf;
          const candidate = pkg === channel.package ? candidates.get(arch) : undefined;
          if (candidate && entry.version === version) {
            buf = candidate.buf;
          } else {
            try {
              buf = await readFile(join(pkgStateDir(stateDir, pkg), "pool", entry.file));
            } catch {
              throw new PublishError(`retained package missing from state: ${entry.file}`, EXIT.verify);
            }
            if (sha256(buf) !== entry.sha256) throw new PublishError(`retained package sha256 mismatch: ${entry.file}`, EXIT.verify);
          }
          await writeFile(join(statePool, entry.file), buf);
          const siteFile = join(dir, entry.file);
          await writeFile(siteFile, buf);
          await signPackage(siteFile, gpgKeyId);
          await verifyPackage(siteFile, keyring);
        }
      }
    }

    // Site arch directories are the ones the plan actually has, so an aarch64-only catalog never grows an empty x86_64 tree.
    const siteArches = ARCHES.filter((arch) => [...plan.values()].some((next) => arch in next));
    for (const arch of siteArches) {
      const dir = join(out, "packages", arch);
      await createrepo(dir);
      const repomd = join(dir, "repodata", "repomd.xml");
      await gpg(["--local-user", gpgKeyId, "--armor", "--detach-sign", "--output", `${repomd}.asc`, repomd]);
    }
    await writeFile(join(out, KEYRING_FILE), publicKey);
    await writeFile(join(out, "vmvarela.repo"), repoFile({ baseUrl: baseUrl ?? defaultBaseUrl(channel.repo) }));
  } finally {
    await rm(keyring, { recursive: true, force: true });
  }

  for (const [pkg, next] of plan) {
    const dir = pkgStateDir(stateOut, pkg);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), `${JSON.stringify({ schema_version: 1, package: pkg, architectures: next }, null, 2)}\n`);
  }

  await writeFile(join(out, ".complete"), `${shadow ? "shadow " : ""}${action} ${version}\n`);
  return { action, version };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new PublishError(`unexpected argument: ${key}`, EXIT.tool);
    if (key === "--test-subset" || key === "--shadow" || key === "--force") {
      args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    if (argv[i + 1] === undefined) throw new PublishError(`missing value for ${key}`, EXIT.tool);
    args[key.slice(2)] = argv[++i];
  }
  return args;
}

async function main(argv) {
  const a = parseArgs(argv);
  for (const key of ["catalog", "version", "source", "out", "state"]) {
    if (!a[key]) throw new PublishError(`missing --${key}`, EXIT.tool);
  }
  const catalog = JSON.parse(await readFile(a.catalog, "utf8"));
  const catalogErrors = validateCatalog(catalog);
  if (catalogErrors.length) throw new PublishError(catalogErrors.join("; "), EXIT.tool);
  parseVersion(a.version);
  const arches = selectArches(catalog, a.arches, a.testSubset);
  const names = [catalog.checksums, ...arches.map((arch) => assetName(catalog, a.version, arch))];
  const github = a.source === "github";
  const sourceDir = github ? await downloadRelease({ repo: catalog.repo, version: a.version, names }) : a.source;
  try {
    const result = await publish({
      catalog,
      version: a.version,
      sourceDir,
      out: a.out,
      stateDir: a.state,
      arches: a.arches,
      gpgKeyId: process.env.GPG_KEY_ID,
      baseUrl: a["base-url"],
      testSubset: a.testSubset,
      shadow: a.shadow,
      force: a.force,
    });
    console.log(`rpm-publish: ${a.shadow ? "shadow " : ""}${result.action} ${result.version}`);
  } finally {
    if (github) await rm(sourceDir, { recursive: true, force: true });
  }
}

// CLI: node scripts/rpm-publish.mjs --catalog catalog/sql-pipe.json --version X.Y.Z --source <dir|github> --out <dir> --state <dir> [--base-url <url>] [--arches a,b] [--shadow] [--force]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`rpm-publish: ${err.message}`);
    process.exitCode = err.exitCode ?? EXIT.tool;
  });
}
