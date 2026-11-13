// Writes the flake's per-package versions.json for one catalog entry from a verified stable release.
// Stdlib only: Nix reads the JSON, so there is no site, no metadata tooling and no signature.
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT, PublishError, downloadRelease, parseSha256Sums, parseVersion, sha256 } from "./apt-publish.mjs";
import { NIX_SYSTEMS, validateCatalog } from "./validate-catalog.mjs";

const SYSTEMS = NIX_SYSTEMS;
const NAME = /^[A-Za-z0-9._-]+$/;

// One versions.json per package, so the state keeps that package's current version and hashes. There is no
// pool and no retention: the file can only point at one version per system.
const pkgStateDir = (root, pkg) => join(root, pkg);
export const versionsPath = (pkg) => join("pkgs", pkg, "versions.json");

export function selectSystems(catalog, requested, testSubset) {
  const all = Object.keys(catalog.channels.nix.assets);
  if (!requested) return all;
  const systems = requested.split(",").map((s) => s.trim());
  for (const system of systems) {
    if (!all.includes(system)) throw new PublishError(`system "${system}" is not in the catalog`, EXIT.tool);
  }
  if (new Set(systems).size !== systems.length) throw new PublishError(`duplicate system in "${requested}"`, EXIT.tool);
  if (systems.length !== all.length && !testSubset) {
    throw new PublishError("partial systems are test-only: pass --test-subset explicitly", EXIT.tool);
  }
  return systems;
}

const assetName = (catalog, system) => catalog.channels.nix.assets[system];

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
    parseVersion(state.version);
    for (const [system, info] of Object.entries(state.systems ?? {})) {
      if (!SYSTEMS.includes(system) || !/^[0-9a-f]{64}$/.test(info.sha256) || typeof info.url !== "string") {
        throw new PublishError(`unexpected state file: ${file}`, EXIT.tool);
      }
    }
    states.set(entry.name, state);
  }
  return states;
}

const compareVersions = (a, b) => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const sameSystems = (state, candidates) => {
  const systems = Object.keys(state.systems ?? {});
  return systems.length === candidates.size && [...candidates].every(([system, c]) => state.systems[system]?.sha256 === c.sha256);
};

// Pure-ish orchestration: every check runs before the first write to out.
// Writes only to out and the candidate state <out>.state/; never to stateRoot.
export async function publish({ catalog, version, sourceDir, out, stateDir, systems, testSubset = false, force = false }) {
  parseVersion(version);
  const errors = validateCatalog(catalog);
  if (errors.length) throw new PublishError(errors.join("; "), EXIT.tool);
  const channel = catalog.channels.nix;
  const selected = selectSystems(catalog, systems, testSubset);
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
  for (const system of selected) {
    const name = assetName(catalog, system);
    let buf;
    try {
      buf = await readFile(join(sourceDir, name));
    } catch {
      throw new PublishError(`missing asset: ${name}`, EXIT.verify);
    }
    if (!sums.has(name)) throw new PublishError(`not listed in ${catalog.checksums}: ${name}`, EXIT.verify);
    const hash = sha256(buf);
    if (hash !== sums.get(name)) throw new PublishError(`sha256 mismatch: ${name}`, EXIT.verify);
    candidates.set(system, {
      version,
      sha256: hash,
      url: `https://github.com/${catalog.repo}/releases/download/v${version}/${name}`,
    });
  }

  // A system cannot move backwards unless a maintainer forces it: Nix would otherwise downgrade silently.
  if (state && !force) {
    for (const [system, cand] of candidates) {
      const current = state.systems?.[system];
      if (current && compareVersions(cand.version, current.version) < 0) {
        throw new PublishError(`refusing to downgrade ${system}: ${cand.version} is older than published ${current.version}`, EXIT.version);
      }
    }
  }

  // Retained systems are carried forward: a release that only ships one platform keeps the others working.
  const next = { ...(state?.systems ?? {}) };
  for (const [system, cand] of candidates) next[system] = cand;
  const ordered = Object.fromEntries(SYSTEMS.filter((s) => s in next).map((s) => [s, next[s]]));

  const noop = state !== null && state.version === version && sameSystems(state, candidates);
  if (noop && !force) return { action: "noop", version };

  if (existsSync(out) && (await readdir(out)).length) throw new PublishError(`${out} is not empty; remove it before publishing`, EXIT.tool);
  if (existsSync(stateOut) && (await readdir(stateOut)).length) throw new PublishError(`${stateOut} is not empty; remove it before publishing`, EXIT.tool);

  const file = versionsPath(channel.package);
  await mkdir(join(out, "pkgs", channel.package), { recursive: true });
  await writeFile(join(out, file), `${JSON.stringify(ordered, null, 2)}\n`);

  for (const [pkg, other] of states) {
    if (pkg === channel.package) continue;
    await mkdir(pkgStateDir(stateOut, pkg), { recursive: true });
    await writeFile(join(pkgStateDir(stateOut, pkg), "state.json"), `${JSON.stringify(other, null, 2)}\n`);
  }
  const dir = pkgStateDir(stateOut, channel.package);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    `${JSON.stringify({ schema_version: 1, package: channel.package, version, systems: ordered }, null, 2)}\n`,
  );

  await writeFile(join(out, ".complete"), `${noop ? "rebuild" : "promote"} ${version}\n`);
  return { action: noop ? "rebuild" : "promote", version };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new PublishError(`unexpected argument: ${key}`, EXIT.tool);
    if (key === "--test-subset" || key === "--force") {
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
  const selected = selectSystems(catalog, a.systems, a.testSubset);
  const names = [catalog.checksums, ...selected.map((system) => assetName(catalog, system))];
  const github = a.source === "github";
  const sourceDir = github ? await downloadRelease({ repo: catalog.repo, version: a.version, names }) : a.source;
  try {
    const result = await publish({
      catalog,
      version: a.version,
      sourceDir,
      out: a.out,
      stateDir: a.state,
      systems: a.systems,
      testSubset: a.testSubset,
      force: a.force,
    });
    console.log(`nix-publish: ${result.action} ${result.version}`);
  } finally {
    if (github) await rm(sourceDir, { recursive: true, force: true });
  }
}

// CLI: node scripts/nix-publish.mjs --catalog catalog/sql-pipe.json --version X.Y.Z --source <dir|github> --out <dir> --state <dir> [--systems a,b] [--test-subset] [--force]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`nix-publish: ${err.message}`);
    process.exitCode = err.exitCode ?? EXIT.tool;
  });
}
