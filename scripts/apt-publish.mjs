// Builds a signed APT site for one catalog entry from a verified stable release. Stdlib only.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { validateCatalog } from "./validate-catalog.mjs";

const run = promisify(execFile);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RETAIN = 2;
const SUITE = "stable";
export const EXIT = { tool: 1, version: 2, verify: 3 };

export class PublishError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const digests = (buf) => ({
  size: buf.length,
  md5: createHash("md5").update(buf).digest("hex"),
  sha256: sha256(buf),
  sha512: createHash("sha512").update(buf).digest("hex"),
});

export function parseVersion(version) {
  const m = VERSION.exec(version);
  // Components above MAX_SAFE_INTEGER would lose precision in comparisons.
  const parts = m ? m.slice(1).map(Number) : [];
  if (!m || parts.some((n) => n > Number.MAX_SAFE_INTEGER)) {
    throw new PublishError(`version must be a stable X.Y.Z: "${version}"`, EXIT.tool);
  }
  return parts;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (!m) throw new PublishError(`malformed checksum line: "${line}"`, EXIT.verify);
    if (sums.has(m[2])) throw new PublishError(`duplicate checksum entry: ${m[2]}`, EXIT.verify);
    sums.set(m[2], m[1]);
  }
  return sums;
}

// Pool layout follows Debian policy: lib* packages use a four-character prefix.
export const poolDir = (pkg) => join("pool", "main", pkg.startsWith("lib") ? pkg.slice(0, 4) : pkg[0], pkg);

// candidates: Map arch -> { version, sha256 }. Compares against the published state (newest first per arch).
export function decideAction(state, candidates) {
  let unchanged = true;
  for (const [arch, cand] of candidates) {
    const current = state?.architectures?.[arch]?.[0];
    if (!current) {
      unchanged = false;
      continue;
    }
    const cmp = compareVersions(cand.version, current.version);
    if (cmp < 0) throw new PublishError(`${arch}: ${cand.version} is older than published ${current.version}`, EXIT.version);
    if (cmp > 0) {
      unchanged = false;
      continue;
    }
    if (cand.sha256 !== current.sha256) {
      throw new PublishError(`${arch}: ${cand.version} is already published with different content`, EXIT.version);
    }
  }
  return unchanged ? "noop" : "promote";
}

export function nextArchitectures(state, candidates) {
  const out = {};
  for (const [arch, cand] of candidates) {
    const previous = state?.architectures?.[arch] ?? [];
    out[arch] = [{ version: cand.version, sha256: cand.sha256 }, ...previous.filter((e) => e.version !== cand.version)].slice(0, RETAIN);
  }
  return out;
}

// Keeps Packages control fields from dpkg-deb and appends the fields apt needs to fetch and verify the file.
export function packageStanza(control, { filename, size, md5, sha256: hash }) {
  return `${control.trimEnd()}\nFilename: ${filename}\nSize: ${size}\nMD5sum: ${md5}\nSHA256: ${hash}\n`;
}

export function buildRelease({ origin, date, arches, files }) {
  const lines = [
    `Origin: ${origin}`,
    `Label: ${origin}`,
    `Suite: ${SUITE}`,
    `Codename: ${SUITE}`,
    `Date: ${date}`,
    `Architectures: ${arches.join(" ")}`,
    "Components: main",
  ];
  for (const [alg, key] of [["md5", "MD5Sum"], ["sha256", "SHA256"], ["sha512", "SHA512"]]) {
    lines.push(`${key}:`);
    for (const f of files) lines.push(` ${f[alg]} ${f.size} ${f.path}`);
  }
  return `${lines.join("\n")}\n`;
}

export function selectArches(catalog, requested, testSubset) {
  const all = Object.keys(catalog.channels.apt.assets);
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

const assetName = (catalog, version, arch) => catalog.channels.apt.assets[arch].replaceAll("{version}", version);

async function dpkg(args) {
  try {
    return (await run("dpkg-deb", args, { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("dpkg-deb not found: install dpkg to read package metadata", EXIT.tool);
    throw new PublishError(`dpkg-deb failed: ${e.stderr?.trim() || e.message}`, EXIT.verify);
  }
}

async function gpg(args) {
  try {
    return (await run("gpg", ["--batch", "--yes", ...args], { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("gpg not found", EXIT.tool);
    throw new PublishError(`gpg failed: ${e.stderr?.trim() || e.message}`, EXIT.tool);
  }
}

async function readState(stateDir, pkg) {
  const file = join(stateDir, "state.json");
  if (!existsSync(file)) return null;
  const state = JSON.parse(await readFile(file, "utf8"));
  if (state.schema_version !== 1 || state.package !== pkg) throw new PublishError(`unexpected state file: ${file}`, EXIT.tool);
  // Retained versions become path segments and hashes are compared: validate every entry before use.
  for (const entries of Object.values(state.architectures ?? {})) {
    if (!Array.isArray(entries)) throw new PublishError(`unexpected state file: ${file}`, EXIT.tool);
    for (const e of entries) {
      parseVersion(e.version);
      if (!SHA256.test(e.sha256)) throw new PublishError(`unexpected state file: ${file}`, EXIT.tool);
    }
  }
  return state;
}

// Verifies metadata from a private copy of the bytes that were checksummed, never from the source path.
async function withSnapshot(buf, fn) {
  const dir = await mkdtemp(join(tmpdir(), "apt-publish-"));
  try {
    const file = join(dir, "snapshot.deb");
    await writeFile(file, buf);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Pure-ish orchestration: every check runs before the first write to out.
export async function publish({ catalog, version, sourceDir, out, stateDir, releaseDate, arches, gpgKeyId, testSubset = false }) {
  parseVersion(version);
  const errors = validateCatalog(catalog);
  if (errors.length) throw new PublishError(errors.join("; "), EXIT.tool);
  if (!gpgKeyId) throw new PublishError("GPG_KEY_ID is required to sign the index", EXIT.tool);
  const when = new Date(`${releaseDate}T00:00:00Z`);
  // Round-trip rejects dates JS would normalize, such as 2026-02-30.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) || Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== releaseDate) {
    throw new PublishError("release date must be a real YYYY-MM-DD date", EXIT.tool);
  }
  const apt = catalog.channels.apt;
  const selected = selectArches(catalog, arches, testSubset);
  const state = await readState(stateDir, apt.package);

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
    const path = join(sourceDir, name);
    let buf;
    try {
      buf = await readFile(path);
    } catch {
      throw new PublishError(`missing asset: ${name}`, EXIT.verify);
    }
    if (!sums.has(name)) throw new PublishError(`not listed in ${catalog.checksums}: ${name}`, EXIT.verify);
    const hash = sha256(buf);
    if (hash !== sums.get(name)) throw new PublishError(`sha256 mismatch: ${name}`, EXIT.verify);
    candidates.set(arch, { version, sha256: hash, name, buf });
  }
  for (const [arch, cand] of candidates) {
    const fields = await withSnapshot(cand.buf, (file) => dpkg(["--showformat=${Package} ${Version} ${Architecture}", "--show", file]));
    const [pkg, ver, debArch] = fields.trim().split(" ");
    if (pkg !== apt.package || ver !== version || debArch !== arch) {
      throw new PublishError(`${cand.name}: control is ${pkg} ${ver} ${debArch}, expected ${apt.package} ${version} ${arch}`, EXIT.verify);
    }
  }

  const action = decideAction(state, candidates);
  // Nothing to publish: the site is not regenerated or re-signed.
  if (action === "noop") return { action, version };
  const stateOut = `${out}.state.json`;

  if (existsSync(out) && (await readdir(out)).length) throw new PublishError(`${out} is not empty; remove it before publishing`, EXIT.tool);
  await mkdir(out, { recursive: true });

  const pool = join(out, poolDir(apt.package));
  await mkdir(pool, { recursive: true });
  const nextArch = nextArchitectures(state, candidates);
  for (const arch of selected) {
    for (const entry of nextArch[arch]) {
      const name = assetName(catalog, entry.version, arch);
      const dest = join(pool, name);
      if (entry.version === version) {
        await writeFile(dest, candidates.get(arch).buf);
        continue;
      }
      const prev = join(stateDir, poolDir(apt.package), name);
      let buf;
      try {
        buf = await readFile(prev);
      } catch {
        throw new PublishError(`retained package missing from state: ${name}`, EXIT.verify);
      }
      if (sha256(buf) !== entry.sha256) throw new PublishError(`retained package sha256 mismatch: ${name}`, EXIT.verify);
      await writeFile(dest, buf);
    }
  }

  const indexFiles = [];
  for (const arch of selected) {
    const stanzas = [];
    for (const entry of nextArch[arch]) {
      const name = assetName(catalog, entry.version, arch);
      const file = join(pool, name);
      const control = await dpkg(["-f", file]);
      stanzas.push(packageStanza(control, { filename: join(poolDir(apt.package), name), ...digests(await readFile(file)) }));
    }
    const packages = Buffer.from(stanzas.join("\n"));
    const dir = join(out, "dists", SUITE, "main", `binary-${arch}`);
    await mkdir(dir, { recursive: true });
    const gz = gzipSync(packages);
    await writeFile(join(dir, "Packages"), packages);
    await writeFile(join(dir, "Packages.gz"), gz);
    indexFiles.push({ path: `main/binary-${arch}/Packages`, ...digests(packages) }, { path: `main/binary-${arch}/Packages.gz`, ...digests(gz) });
  }

  const dists = join(out, "dists", SUITE);
  const release = buildRelease({
    origin: apt.package,
    date: new Date(`${releaseDate}T00:00:00Z`).toUTCString(),
    arches: selected,
    files: indexFiles,
  });
  await writeFile(join(dists, "Release"), release);
  const keyArgs = ["--local-user", gpgKeyId];
  await gpg([...keyArgs, "--armor", "--detach-sign", "--output", join(dists, "Release.gpg"), join(dists, "Release")]);
  await gpg([...keyArgs, "--clearsign", "--output", join(dists, "InRelease"), join(dists, "Release")]);
  await writeFile(join(out, "key.asc"), await gpg(["--armor", "--export", gpgKeyId]));

  await writeFile(stateOut, `${JSON.stringify({ schema_version: 1, package: apt.package, architectures: nextArch }, null, 2)}\n`);
  await writeFile(join(out, ".complete"), `${action} ${version}\n`);
  return { action, version };
}

export async function downloadRelease({ repo, version, names }) {
  const api = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
  const release = await fetchJson(api);
  if (release.draft || release.prerelease) throw new PublishError(`release v${version} is a draft or prerelease`, EXIT.verify);
  const dir = await mkdtemp(join(tmpdir(), "apt-publish-"));
  try {
    for (const name of names) {
      const asset = release.assets?.find((a) => a.name === name);
      if (!asset) throw new PublishError(`missing asset: ${name}`, EXIT.verify);
      await writeFile(join(dir, name), await fetchBytes(asset.browser_download_url));
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

const ATTEMPTS = 3;

async function fetchBytes(url) {
  let last;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
    }
  }
  throw new PublishError(`download failed after ${ATTEMPTS} attempts: ${url}: ${last.message}`, EXIT.tool);
}

async function fetchJson(url) {
  return JSON.parse((await fetchBytes(url)).toString("utf8"));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new PublishError(`unexpected argument: ${key}`, EXIT.tool);
    if (key === "--test-subset") {
      args.testSubset = true;
      continue;
    }
    if (argv[i + 1] === undefined) throw new PublishError(`missing value for ${key}`, EXIT.tool);
    args[key.slice(2)] = argv[++i];
  }
  return args;
}

async function main(argv) {
  const a = parseArgs(argv);
  for (const key of ["catalog", "version", "source", "out", "state", "release-date"]) {
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
      releaseDate: a["release-date"],
      arches: a.arches,
      gpgKeyId: process.env.GPG_KEY_ID,
      testSubset: a.testSubset,
    });
    console.log(`apt-publish: ${result.action} ${result.version}`);
  } finally {
    if (github) await rm(sourceDir, { recursive: true, force: true });
  }
}

// CLI: node scripts/apt-publish.mjs --catalog catalog/sql-pipe.json --version X.Y.Z --source <dir|github> --out <dir> --state <dir> --release-date YYYY-MM-DD
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`apt-publish: ${err.message}`);
    process.exitCode = err.exitCode ?? EXIT.tool;
  });
}
