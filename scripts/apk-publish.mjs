// Builds a signed APK repository for one catalog entry from a verified stable release. Stdlib only.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { EXIT, PublishError, decideAction, downloadRelease, nextArchitectures, parseSha256Sums, parseVersion, sha256 } from "./apt-publish.mjs";
import { APK_ARCHES, validateCatalog } from "./validate-catalog.mjs";

const run = promisify(execFile);
const ARCHES = APK_ARCHES;
const NAME = /^[A-Za-z0-9._-]+$/;
const KEY_FILE = "vmvarela.rsa.pub";
// abuild-sign names the signature after the public key file, and apk only trusts keys installed under that name.
const KEY_NAME = KEY_FILE;

// The durable state uses the APT layout (docs/receivers.md, section 3a): <state>/<package>/state.json and pool/.
const pkgStateDir = (root, pkg) => join(root, pkg);

// apk derives the package URL from P: and V: in the index, so the site always serves <name>-<version>.apk.
export const siteFileName = (pkg, version) => `${pkg}-${version}.apk`;

export function selectArches(catalog, requested, testSubset) {
  const all = Object.keys(catalog.channels.apk.assets);
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

const assetName = (catalog, version, arch) => catalog.channels.apk.assets[arch].replaceAll("{version}", version);

async function apk(args, exitCode = EXIT.verify) {
  try {
    return (await run("apk", args, { maxBuffer: 1 << 22 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("apk not found: the APK receiver needs apk-tools", EXIT.tool);
    throw new PublishError(`apk failed: ${e.stderr?.trim() || e.message}`, exitCode);
  }
}

async function abuildSign(args) {
  try {
    // Never pass -q: abuild-sign 3.17 fails silently with it.
    return (await run("abuild-sign", args, { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("abuild-sign not found: install abuild", EXIT.tool);
    throw new PublishError(`abuild-sign failed: ${e.stderr?.trim() || e.message}`, EXIT.tool);
  }
}

async function openssl(args) {
  try {
    return (await run("openssl", args, { maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("openssl not found: install openssl", EXIT.tool);
    throw new PublishError(`openssl failed: ${e.stderr?.trim() || e.message}`, EXIT.tool);
  }
}

async function tar(args, exitCode = EXIT.verify) {
  try {
    return (await run("tar", args, { maxBuffer: 1 << 22 })).stdout;
  } catch (e) {
    if (e.code === "ENOENT") throw new PublishError("tar not found", EXIT.tool);
    throw new PublishError(`tar failed: ${e.stderr?.trim() || e.message}`, exitCode);
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
  const dir = await mkdtemp(join(tmpdir(), "apk-publish-"));
  try {
    const file = join(dir, "snapshot.apk");
    await writeFile(file, buf);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// nfpm .apk files carry .PKGINFO in the control stream; producers do not sign them.
async function readPkginfo(file) {
  const text = await tar(["-xzOf", file, ".PKGINFO"]);
  const fields = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

// Alpine trusts the packages a signed index lists by their index checksum, so signing every package is not
// needed: the signature that matters is APKINDEX.tar.gz. abuild-sign prepends .SIGN.RSA.<key> in one stream.
async function writeIndex(dir, arch, privateKey, publicKeyPath) {
  const index = join(dir, "APKINDEX.tar.gz");
  const pkgs = (await readdir(dir)).filter((f) => f.endsWith(".apk")).sort();
  // The release assets are not signed, so indexing them needs --allow-untrusted; the signature clients check
  // is the one added below.
  await apk(["--allow-untrusted", "index", "--description", "vmvarela APK repository", "--rewrite-arch", arch, "-o", index, ...pkgs.map((f) => join(dir, f))]);
  // abuild-sign signs these exact bytes and prepends the signature member to them, so keep a copy to verify
  // against: a name-only check would pass an empty or corrupt signature. It uses RSA-SHA1 for RSA keys.
  const unsigned = `${index}.unsigned`;
  await copyFile(index, unsigned);
  const work = await mkdtemp(join(tmpdir(), "apk-index-"));
  try {
    await abuildSign(["-k", privateKey, "-p", KEY_NAME, index]);
    const members = (await tar(["-tzf", index])).trim().split("\n");
    if (members[0] !== `.SIGN.RSA.${KEY_NAME}`) throw new PublishError(`${index}: unsigned index: ${members.join(",")}`, EXIT.verify);
    await tar(["-xzf", index, "-C", work, `.SIGN.RSA.${KEY_NAME}`]);
    await openssl(["dgst", "-sha1", "-verify", publicKeyPath, "-signature", join(work, `.SIGN.RSA.${KEY_NAME}`), unsigned]);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(unsigned, { force: true });
  }
}

// Pure-ish orchestration: every check runs before the first write to out.
// Writes only to out and the candidate state <out>.state/; never to stateRoot. Shadow runs are the same, plus a guard.
export async function publish({ catalog, version, sourceDir, out, stateDir, arches, privateKey, testSubset = false, shadow = false, force = false }) {
  parseVersion(version);
  const errors = validateCatalog(catalog);
  if (errors.length) throw new PublishError(errors.join("; "), EXIT.tool);
  if (!privateKey) throw new PublishError("APK_SIGNING_KEY is required to sign the index", EXIT.tool);
  const channel = catalog.channels.apk;
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
    const info = await withSnapshot(cand.buf, readPkginfo);
    if (info.pkgname !== channel.package || info.pkgver !== version || info.arch !== arch) {
      throw new PublishError(`${cand.file}: metadata is ${info.pkgname} ${info.pkgver} ${info.arch}, expected ${channel.package} ${version} ${arch}`, EXIT.verify);
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

  const keyDir = await mkdtemp(join(tmpdir(), "apk-keys-"));
  const keyPath = join(keyDir, "signing.rsa");
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  try {
    for (const [pkg, next] of plan) {
      const statePool = join(pkgStateDir(stateOut, pkg), "pool");
      await mkdir(statePool, { recursive: true });
      for (const [arch, entries] of Object.entries(next)) {
        const dir = join(out, arch);
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
          await writeFile(join(dir, siteFileName(pkg, entry.version)), buf);
        }
      }
    }

    // Site arch directories are the ones the plan actually has, so an aarch64-only catalog never grows an empty x86_64 tree.
    const siteArches = ARCHES.filter((arch) => [...plan.values()].some((next) => arch in next));
    const publicKey = await openssl(["rsa", "-in", keyPath, "-pubout"]);
    const publicKeyPath = join(keyDir, KEY_FILE);
    await writeFile(publicKeyPath, publicKey);
    for (const arch of siteArches) await writeIndex(join(out, arch), arch, keyPath, publicKeyPath);
    await writeFile(join(out, KEY_FILE), publicKey);
  } finally {
    await rm(keyDir, { recursive: true, force: true });
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
      privateKey: process.env.APK_SIGNING_KEY,
      testSubset: a.testSubset,
      shadow: a.shadow,
      force: a.force,
    });
    console.log(`apk-publish: ${a.shadow ? "shadow " : ""}${result.action} ${result.version}`);
  } finally {
    if (github) await rm(sourceDir, { recursive: true, force: true });
  }
}

// CLI: node scripts/apk-publish.mjs --catalog catalog/sql-pipe.json --version X.Y.Z --source <dir|github> --out <dir> --state <dir> [--arches a,b] [--test-subset] [--shadow] [--force]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`apk-publish: ${err.message}`);
    process.exitCode = err.exitCode ?? EXIT.tool;
  });
}
