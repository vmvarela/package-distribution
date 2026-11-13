// Writes the Scoop manifest for one catalog entry from a verified stable release.
// Stdlib only: Scoop downloads the release assets itself, so there is no site, no pool and no signature.
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT, PublishError, downloadRelease, parseSha256Sums, parseVersion, sha256 } from "./apt-publish.mjs";
import { SCOOP_ARCHES, validateCatalog } from "./validate-catalog.mjs";

const ARCHES = SCOOP_ARCHES;
const NAME = /^[A-Za-z0-9._-]+$/;

// One manifest per package, so the state keeps that package's current version and hashes.
const pkgStateDir = (root, pkg) => join(root, pkg);
export const manifestPath = (pkg) => join("bucket", `${pkg}.json`);

export function selectArches(catalog, requested, testSubset) {
  const all = Object.keys(catalog.channels.scoop.assets);
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
    for (const [arch, info] of Object.entries(state.architectures ?? {})) {
      if (!ARCHES.includes(arch) || !/^[0-9a-f]{64}$/.test(info.sha256) || typeof info.asset !== "string") {
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

const sameArches = (state, candidates) => {
  const arches = Object.keys(state.architectures ?? {});
  return arches.length === candidates.size && [...candidates].every(([arch, c]) => state.architectures[arch]?.sha256 === c.sha256);
};

// The manifest is generated, never hand-edited: same key order as the files it replaces, so a publish
// that changes nothing produces no diff.
export function manifest({ catalog, version, architectures }) {
  const channel = catalog.channels.scoop;
  // Each architecture keeps its own version: a release that ships one Windows target carries the others over.
  const download = (arch, version) =>
    `https://github.com/${catalog.repo}/releases/download/v${version}/${architectureAsset(catalog, arch, version)}#/${channel.package}.exe`;
  const ordered = Object.fromEntries(ARCHES.filter((a) => a in architectures).map((a) => [a, architectures[a]]));
  return `${JSON.stringify(
    {
      version,
      description: channel.description,
      homepage: `https://github.com/${catalog.repo}`,
      license: channel.license,
      architecture: Object.fromEntries(
        Object.entries(ordered).map(([arch, info]) => [arch, { url: download(arch, info.version), hash: info.sha256 }]),
      ),
      bin: `${channel.package}.exe`,
      checkver: "github",
      autoupdate: {
        architecture: Object.fromEntries(Object.keys(ordered).map((arch) => [arch, { url: download(arch, "$version") }])),
        hash: { url: `https://github.com/${catalog.repo}/releases/download/v$version/${catalog.checksums}` },
      },
    },
    null,
    4,
  )}\n`;
}

const architectureAsset = (catalog, arch, version) => catalog.channels.scoop.assets[arch].replaceAll("{version}", version);

// Pure-ish orchestration: every check runs before the first write to out.
// Writes only to out and the candidate state <out>.state/; never to stateRoot.
export async function publish({ catalog, version, sourceDir, out, stateDir, arches, testSubset = false, force = false }) {
  parseVersion(version);
  const errors = validateCatalog(catalog);
  if (errors.length) throw new PublishError(errors.join("; "), EXIT.tool);
  const channel = catalog.channels.scoop;
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
    const name = architectureAsset(catalog, arch, version);
    let buf;
    try {
      buf = await readFile(join(sourceDir, name));
    } catch {
      throw new PublishError(`missing asset: ${name}`, EXIT.verify);
    }
    if (!sums.has(name)) throw new PublishError(`not listed in ${catalog.checksums}: ${name}`, EXIT.verify);
    const hash = sha256(buf);
    if (hash !== sums.get(name)) throw new PublishError(`sha256 mismatch: ${name}`, EXIT.verify);
    candidates.set(arch, { version, sha256: hash, asset: name });
  }

  // An architecture cannot move backwards unless a maintainer forces it.
  if (state && !force) {
    for (const [arch, cand] of candidates) {
      const current = state.architectures?.[arch];
      if (current && compareVersions(cand.version, current.version) < 0) {
        throw new PublishError(`refusing to downgrade ${arch}: ${cand.version} is older than published ${current.version}`, EXIT.version);
      }
    }
  }

  // Retained architectures are carried forward: a release that only ships one Windows target keeps the others.
  const next = { ...(state?.architectures ?? {}) };
  for (const [arch, cand] of candidates) next[arch] = cand;
  const ordered = Object.fromEntries(ARCHES.filter((a) => a in next).map((a) => [a, next[a]]));

  const noop = state !== null && state.version === version && sameArches(state, candidates);
  if (noop && !force) return { action: "noop", version };

  if (existsSync(out) && (await readdir(out)).length) throw new PublishError(`${out} is not empty; remove it before publishing`, EXIT.tool);
  if (existsSync(stateOut) && (await readdir(stateOut)).length) throw new PublishError(`${stateOut} is not empty; remove it before publishing`, EXIT.tool);

  await mkdir(join(out, "bucket"), { recursive: true });
  await writeFile(join(out, manifestPath(channel.package)), manifest({ catalog, version, architectures: ordered }));

  for (const [pkg, other] of states) {
    if (pkg === channel.package) continue;
    await mkdir(pkgStateDir(stateOut, pkg), { recursive: true });
    await writeFile(join(pkgStateDir(stateOut, pkg), "state.json"), `${JSON.stringify(other, null, 2)}\n`);
  }
  const dir = pkgStateDir(stateOut, channel.package);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    `${JSON.stringify({ schema_version: 1, package: channel.package, version, architectures: ordered }, null, 2)}\n`,
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
  const selected = selectArches(catalog, a.arches, a.testSubset);
  const names = [catalog.checksums, ...selected.map((arch) => architectureAsset(catalog, arch, a.version))];
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
      testSubset: a.testSubset,
      force: a.force,
    });
    console.log(`scoop-publish: ${result.action} ${result.version}`);
  } finally {
    if (github) await rm(sourceDir, { recursive: true, force: true });
  }
}

// CLI: node scripts/scoop-publish.mjs --catalog catalog/sql-pipe.json --version X.Y.Z --source <dir|github> --out <dir> --state <dir> [--arches a,b] [--test-subset] [--force]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`scoop-publish: ${err.message}`);
    process.exitCode = err.exitCode ?? EXIT.tool;
  });
}
