import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../scripts/apt-publish.mjs";
import { manifestPath, publish, selectArches } from "../scripts/scoop-publish.mjs";
import { validateCatalog } from "../scripts/validate-catalog.mjs";

const sqlPipe = JSON.parse(readFileSync(new URL("../catalog/sql-pipe.json", import.meta.url), "utf8"));
const damas = JSON.parse(readFileSync(new URL("../catalog/damas.json", import.meta.url), "utf8"));
const ARCHES = ["64bit", "32bit", "arm64"];

const scratchDirs = [];
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "scoop-publish-test-"));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });
const expectExit = (promise, code, pattern) => assert.rejects(promise, (e) => e.exitCode === code && (!pattern || pattern.test(e.message)));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Synthetic fixtures: this receiver only reads Windows binaries and hashes them, so no Scoop runtime is needed.
let fixtureCount = 0;
function fixture(root, catalog, version, body) {
  const dir = join(root, `src-${catalog.project}-${version}-${++fixtureCount}`);
  mkdirSync(dir, { recursive: true });
  const sums = [];
  for (const [arch, template] of Object.entries(catalog.channels.scoop.assets)) {
    const asset = template.replaceAll("{version}", version);
    const buf = Buffer.from(body(arch, version));
    writeFileSync(join(dir, asset), buf);
    sums.push(`${sha256(buf)}  ${asset}`);
  }
  writeFileSync(join(dir, catalog.checksums), `${sums.join("\n")}\n`);
  return dir;
}

test("catalogs declare a scoop channel with every manifest architecture", () => {
  for (const catalog of [sqlPipe, damas]) {
    assert.deepEqual(validateCatalog(catalog), []);
    assert.deepEqual(Object.keys(catalog.channels.scoop.assets), ARCHES);
    assert.ok(catalog.channels.scoop.description.length > 0);
    assert.equal(catalog.channels.scoop.license, "MIT");
  }
});

test("rejects scoop architectures outside the manifest vocabulary", () => {
  const c = structuredClone(sqlPipe);
  c.channels.scoop.assets.riscv64 = "sql-pipe-riscv64-windows.exe";
  assert.match(validateCatalog(c).join("\n"), /channels\.scoop\.assets: unknown architecture "riscv64"/);

  const subset = structuredClone(damas);
  subset.channels.scoop.architectures = ["64bit"];
  assert.match(validateCatalog(subset).join("\n"), /channels\.scoop\.assets: unknown architecture "32bit"/);

  const blank = structuredClone(sqlPipe);
  blank.channels.scoop.description = " ";
  assert.match(validateCatalog(blank).join("\n"), /channels\.scoop\.description: must be a non-empty string/);
});

test("architectures are selected from the scoop channel only", () => {
  assert.deepEqual(selectArches(sqlPipe, undefined, false), ARCHES);
  assert.deepEqual(selectArches(sqlPipe, "arm64", true), ["arm64"]);
  assert.throws(() => selectArches(sqlPipe, "arm64", false), /partial architectures are test-only/);
  assert.throws(() => selectArches(sqlPipe, "x86_64", true), /"x86_64" is not in the catalog/);
  assert.throws(() => selectArches(sqlPipe, "64bit,64bit", true), /duplicate architecture/);
});

test("writes a manifest Scoop accepts and carries other packages forward", async () => {
  const root = scratch();
  const out = join(root, "out");
  const result = await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (a) => `sql-pipe ${a}`), out, stateDir: join(root, "state") });
  assert.equal(result.action, "promote");
  assert.match(readFileSync(join(out, ".complete"), "utf8"), /^promote 0\.27\.0\n$/);

  const m = JSON.parse(readFileSync(join(out, manifestPath("sql-pipe")), "utf8"));
  assert.equal(m.version, "0.27.0");
  assert.equal(m.homepage, "https://github.com/vmvarela/sql-pipe");
  assert.equal(m.bin, "sql-pipe.exe");
  assert.equal(m.checkver, "github");
  assert.deepEqual(Object.keys(m.architecture), ARCHES, "architectures keep the documented order");
  for (const arch of ARCHES) {
    assert.equal(m.architecture[arch].url, `https://github.com/vmvarela/sql-pipe/releases/download/v0.27.0/${sqlPipe.channels.scoop.assets[arch]}#/sql-pipe.exe`);
    assert.match(m.architecture[arch].hash, /^[0-9a-f]{64}$/);
  }
  // autoupdate is what Scoop runs later, so its tag has to be the literal $version placeholder.
  assert.match(m.autoupdate.architecture["64bit"].url, /\/download\/v\$version\/sql-pipe-x86_64-windows\.exe#\/sql-pipe\.exe$/);
  assert.match(m.autoupdate.hash.url, /\/v\$version\/sha256sums\.txt$/);

  const second = await publish({ catalog: damas, version: "0.1.10", sourceDir: fixture(root, damas, "0.1.10", (a) => `damas ${a}`), out: join(root, "out2"), stateDir: join(root, "out.state") });
  assert.equal(second.action, "promote");
  assert.deepEqual(readdirSync(join(root, "out2", "bucket")), ["damas.json"], "each package writes only its own manifest");
  const carried = JSON.parse(readFileSync(join(root, "out2.state", "sql-pipe", "state.json"), "utf8"));
  assert.equal(carried.version, "0.27.0", "the other package's state is preserved");
});

test("keeps architectures a release does not ship and refuses an untouched release", async () => {
  const root = scratch();
  const stateDir = join(root, "state");
  await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (a) => `sql-pipe ${a}`), out: join(root, "o1"), stateDir });
  // A later release that only ships 64bit keeps the other targets on the previous version.
  const partial = fixture(root, sqlPipe, "0.28.0", (a) => `sql-pipe ${a}`);
  for (const arch of ["32bit", "arm64"]) rmSync(join(partial, sqlPipe.channels.scoop.assets[arch]));
  const kept = readFileSync(join(partial, "sha256sums.txt"), "utf8").split("\n").filter((l) => !/x86-windows|aarch64-windows/.test(l));
  writeFileSync(join(partial, "sha256sums.txt"), `${kept.join("\n").trimEnd()}\n`);
  await publish({ catalog: sqlPipe, version: "0.28.0", sourceDir: partial, out: join(root, "o2"), stateDir: join(root, "o1.state"), arches: "64bit", testSubset: true });
  const m = JSON.parse(readFileSync(join(root, "o2", manifestPath("sql-pipe")), "utf8"));
  assert.equal(m.version, "0.28.0");
  assert.match(m.architecture["64bit"].url, /v0\.28\.0\//);
  assert.match(m.architecture["32bit"].url, /v0\.27\.0\//, "a target without a candidate stays on the published version");

  // Going back to an older release is refused before anything is written.
  await expectExit(
    publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (a) => `sql-pipe ${a}`), out: join(root, "o3"), stateDir: join(root, "o2.state") }),
    EXIT.version,
    /older than published/,
  );
  assert.equal(existsSync(join(root, "o3")), false);

  // Same version and hashes again: no output at all.
  const again = await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (a) => `sql-pipe ${a}`), out: join(root, "o5"), stateDir: join(root, "o1.state") });
  assert.equal(again.action, "noop");
  assert.equal(existsSync(join(root, "o5")), false);

  // --force rebuilds the manifest without inventing a new release.
  const forced = await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (a) => `sql-pipe ${a}`), out: join(root, "o4"), stateDir: join(root, "o1.state"), force: true });
  assert.equal(forced.action, "rebuild");
  assert.match(readFileSync(join(root, "o4", ".complete"), "utf8"), /^rebuild 0\.27\.0\n$/);
});

test("refuses missing assets, wrong checksums and an output inside the state", async () => {
  const root = scratch();
  const base = { catalog: damas, version: "0.1.10", out: join(root, "out"), stateDir: join(root, "state") };

  const missing = fixture(root, damas, "0.1.10", (a) => `damas ${a}`);
  rmSync(join(missing, damas.channels.scoop.assets.arm64));
  await expectExit(publish({ ...base, sourceDir: missing }), EXIT.verify, /missing asset: damas-aarch64-windows\.exe/);
  assert.equal(existsSync(join(root, "out")), false);

  const tampered = fixture(root, damas, "0.1.10", (a) => `damas ${a}`);
  writeFileSync(join(tampered, "damas-x86_64-windows.exe"), "changed");
  await expectExit(publish({ ...base, sourceDir: tampered }), EXIT.verify, /sha256 mismatch: damas-x86_64-windows\.exe/);

  const unlisted = fixture(root, damas, "0.1.10", (a) => `damas ${a}`);
  writeFileSync(join(unlisted, "sha256sums.txt"), "");
  await expectExit(publish({ ...base, sourceDir: unlisted }), EXIT.verify, /not listed in sha256sums\.txt/);

  await expectExit(
    publish({ ...base, sourceDir: fixture(root, damas, "0.1.10", (a) => `damas ${a}`), out: join(root, "state", "tmp") }),
    EXIT.tool,
    /inside the state directory/,
  );
});
