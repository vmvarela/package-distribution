// Compares a candidate APT site with a live one and verifies the candidate signature. Stdlib only. Never writes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SUITE = "stable";
const MAX_LINES = 50;
export const EXIT = { tool: 1, diff: 3 };

// Paragraphs of "Key: value" fields; Packages stanzas are separated by blank lines.
export function parseStanzas(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const fields = {};
      for (const line of block.split("\n")) {
        const m = /^([A-Za-z0-9-]+): ?(.*)$/.exec(line);
        if (m) fields[m[1]] = m[2];
      }
      return fields;
    });
}

// Release: header fields (Date excluded: it is not part of the content) and the hashed file entries.
export function parseRelease(text) {
  const header = {};
  const files = [];
  let alg = null;
  for (const line of text.split("\n")) {
    const section = /^(MD5Sum|SHA256|SHA512):\s*$/.exec(line);
    if (section) {
      alg = section[1];
      continue;
    }
    if (line.startsWith(" ") && alg) {
      const [hash, size, path] = line.trim().split(/\s+/);
      files.push({ alg, hash, size, path });
      continue;
    }
    alg = null;
    const m = /^([A-Za-z-]+): ?(.*)$/.exec(line);
    if (m && m[1] !== "Date") header[m[1]] = m[2];
  }
  return { header, files };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const readOptional = async (file) => (existsSync(file) ? readFile(file, "utf8") : null);

// Each site must serve exactly the files its own Release lists: existence, size and SHA-256.
// Release paths are relative to dists/<suite>.
async function verifyReleaseFiles(site, dir, release) {
  const diffs = [];
  const listed = release.files.filter((f) => f.alg === "SHA256");
  if (!listed.length) return [`${site}: Release lists no SHA256 files`];
  for (const f of listed) {
    const file = join(dir, "dists", SUITE, f.path);
    if (!existsSync(file)) {
      diffs.push(`${site}: ${f.path} listed in Release is missing`);
      continue;
    }
    const buf = await readFile(file);
    if (String(buf.length) !== f.size) diffs.push(`${site}: ${f.path} size ${buf.length} does not match Release ${f.size}`);
    if (sha256(buf) !== f.hash) diffs.push(`${site}: ${f.path} does not match its SHA256 in Release`);
  }
  return diffs;
}

// Returns human-readable differences. Empty array means the candidate matches the live site.
export async function compareSites(candidateDir, liveDir) {
  const diffs = [];
  const [cRel, lRel] = [await readOptional(join(candidateDir, "dists", SUITE, "Release")), await readOptional(join(liveDir, "dists", SUITE, "Release"))];
  if (!cRel || !lRel) return [`Release missing in ${!cRel ? "candidate" : "live"}`];
  const c = parseRelease(cRel);
  const l = parseRelease(lRel);
  for (const key of new Set([...Object.keys(c.header), ...Object.keys(l.header)])) {
    if (c.header[key] !== l.header[key]) diffs.push(`Release ${key}: live "${l.header[key] ?? ""}" -> candidate "${c.header[key] ?? ""}"`);
  }
  // The hashed file lists cannot match across sites (the live ones come from apt-ftparchive and gzip -k), so each site is checked against its own Release instead.
  diffs.push(...(await verifyReleaseFiles("candidate", candidateDir, c)), ...(await verifyReleaseFiles("live", liveDir, l)));

  const arches = [...new Set([...(c.header.Architectures ?? "").split(" "), ...(l.header.Architectures ?? "").split(" ")])].filter(Boolean);
  for (const arch of arches) {
    const dir = join("dists", SUITE, "main", `binary-${arch}`, "Packages");
    const cPkgs = await readOptional(join(candidateDir, dir));
    const lPkgs = await readOptional(join(liveDir, dir));
    if (cPkgs === null || lPkgs === null) {
      diffs.push(`${arch}: Packages missing in ${cPkgs === null ? "candidate" : "live"}`);
      continue;
    }
    const index = (text) => new Map(parseStanzas(text).map((p) => [`${p.Package} ${p.Version}`, p]));
    const cm = index(cPkgs);
    const lm = index(lPkgs);
    for (const [key, p] of lm) {
      if (!cm.has(key)) {
        diffs.push(`${arch}: missing in candidate: ${key}`);
        continue;
      }
      const q = cm.get(key);
      for (const field of ["Filename", "Size", "SHA256"]) {
        if (p[field] !== q[field]) diffs.push(`${arch}: ${key} ${field} changed: ${p[field]} -> ${q[field]}`);
      }
    }
    for (const key of cm.keys()) if (!lm.has(key)) diffs.push(`${arch}: only in candidate: ${key}`);
    // The candidate must serve exactly the bytes it indexes.
    for (const p of cm.values()) {
      const file = join(candidateDir, p.Filename ?? "");
      if (!p.Filename || !existsSync(file)) {
        diffs.push(`${arch}: ${p.Package} ${p.Version} file missing in candidate: ${p.Filename}`);
      } else if (sha256(await readFile(file)) !== p.SHA256) {
        diffs.push(`${arch}: ${p.Package} ${p.Version} file does not match its SHA256: ${p.Filename}`);
      }
    }
  }
  return diffs;
}

// Verifies InRelease and Release.gpg of the candidate against the live key in an isolated keyring.
export async function verifySignatures(candidateDir, keyFile) {
  const home = await mkdtemp(join(tmpdir(), "apt-compare-gpg-"));
  const env = { ...process.env, GNUPGHOME: home };
  const dists = join(candidateDir, "dists", SUITE);
  const gpg = async (args) => run("gpg", ["--batch", "--no-tty", "--quiet", ...args], { env, maxBuffer: 1 << 22 });
  try {
    await chmod(home, 0o700);
    await gpg(["--import", keyFile]);
    const errors = [];
    try {
      await gpg(["--verify", join(dists, "Release.gpg"), join(dists, "Release")]);
    } catch {
      errors.push("Release.gpg does not verify against the live key");
    }
    try {
      await gpg(["--verify", join(dists, "InRelease")]);
      // The clearsigned text must be the same Release that the detached signature covers.
      const signed = (await gpg(["--decrypt", join(dists, "InRelease")])).stdout;
      if (signed !== (await readFile(join(dists, "Release"), "utf8"))) errors.push("InRelease text differs from Release");
    } catch {
      errors.push("InRelease does not verify against the live key");
    }
    return errors;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// CLI: node scripts/apt-compare.mjs --candidate <dir> --live <dir>
export async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--candidate", "--live"].includes(argv[i]) || argv[i + 1] === undefined) throw Object.assign(new Error("usage: --candidate <dir> --live <dir>"), { exitCode: EXIT.tool });
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.candidate || !args.live) throw Object.assign(new Error("usage: --candidate <dir> --live <dir>"), { exitCode: EXIT.tool });
  if (!existsSync(join(args.live, "key.asc"))) throw Object.assign(new Error("live site has no key.asc"), { exitCode: EXIT.tool });
  const diffs = await compareSites(args.candidate, args.live);
  const sig = await verifySignatures(args.candidate, join(args.live, "key.asc"));
  const all = [...diffs, ...sig];
  for (const line of all.slice(0, MAX_LINES)) console.log(`- ${line}`);
  if (all.length > MAX_LINES) console.log(`... ${all.length - MAX_LINES} more`);
  if (all.length) throw Object.assign(new Error(`${all.length} difference(s)`), { exitCode: EXIT.diff });
  console.log("apt-compare: candidate matches live and is signed by the live key");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`apt-compare: ${err.message}`);
    process.exitCode = err.exitCode ?? EXIT.tool;
  });
}
