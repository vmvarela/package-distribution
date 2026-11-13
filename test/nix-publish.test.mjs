import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../scripts/apt-publish.mjs";
import { publish, selectSystems, versionsPath } from "../scripts/nix-publish.mjs";
import { validateCatalog } from "../scripts/validate-catalog.mjs";

const sqlPipe = JSON.parse(readFileSync(new URL("../catalog/sql-pipe.json", import.meta.url), "utf8"));
const damas = JSON.parse(readFileSync(new URL("../catalog/damas.json", import.meta.url), "utf8"));
const SYSTEMS = ["x86_64-linux", "aarch64-linux", "x86_64-darwin", "aarch64-darwin"];

const scratchDirs = [];
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "nix-publish-test-"));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });
const expectExit = (promise, code, pattern) => assert.rejects(promise, (e) => e.exitCode === code && (!pattern || pattern.test(e.message)));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Synthetic fixtures: this receiver only reads bytes and hashes them, so no release asset or Nix toolchain is needed.
let fixtureCount = 0;
function fixture(root, catalog, version, body) {
  const dir = join(root, `src-${catalog.project}-${version}-${++fixtureCount}`);
  mkdirSync(dir, { recursive: true });
  const sums = [];
  for (const [system, template] of Object.entries(catalog.channels.nix.assets)) {
    const asset = template.replaceAll("{version}", version);
    const buf = Buffer.from(body(system, version));
    writeFileSync(join(dir, asset), buf);
    sums.push(`${sha256(buf)}  ${asset}`);
  }
  writeFileSync(join(dir, catalog.checksums), `${sums.join("\n")}\n`);
  return dir;
}

test("catalogs declare a nix channel with every supported system", () => {
  for (const catalog of [sqlPipe, damas]) {
    assert.deepEqual(validateCatalog(catalog), []);
    assert.deepEqual(Object.keys(catalog.channels.nix.assets).sort(), [...SYSTEMS].sort());
  }
});

test("rejects nix systems outside the channel vocabulary", () => {
  const c = structuredClone(sqlPipe);
  c.channels.nix.assets["riscv64-linux"] = "sql-pipe-riscv64-linux";
  assert.match(validateCatalog(c).join("\n"), /channels\.nix\.assets: unknown architecture "riscv64-linux"/);

  const subset = structuredClone(damas);
  subset.channels.nix.architectures = ["x86_64-linux"];
  assert.match(validateCatalog(subset).join("\n"), /channels\.nix\.assets: unknown architecture "aarch64-linux"/);
});

test("systems are selected from the nix channel only", () => {
  assert.deepEqual(selectSystems(sqlPipe, undefined, false), SYSTEMS);
  assert.deepEqual(selectSystems(sqlPipe, "x86_64-linux", true), ["x86_64-linux"]);
  assert.throws(() => selectSystems(sqlPipe, "x86_64-linux", false), /partial systems are test-only/);
  assert.throws(() => selectSystems(sqlPipe, "x86_64", true), /"x86_64" is not in the catalog/);
  assert.throws(() => selectSystems(sqlPipe, "x86_64-linux,x86_64-linux", true), /duplicate system/);
});

test("writes versions.json in the shape the flake reads and carries other packages forward", async () => {
  const root = scratch();
  const out = join(root, "out");
  const result = await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (s) => `sql-pipe ${s}`), out, stateDir: join(root, "state") });
  assert.equal(result.action, "promote");
  assert.match(readFileSync(join(out, ".complete"), "utf8"), /^promote 0\.27\.0\n$/);

  const versions = JSON.parse(readFileSync(join(out, versionsPath("sql-pipe")), "utf8"));
  assert.deepEqual(Object.keys(versions), SYSTEMS, "systems keep the documented order");
  for (const system of SYSTEMS) {
    assert.equal(versions[system].version, "0.27.0");
    assert.equal(versions[system].url, `https://github.com/vmvarela/sql-pipe/releases/download/v0.27.0/${sqlPipe.channels.nix.assets[system]}`);
    assert.match(versions[system].sha256, /^[0-9a-f]{64}$/);
  }

  const second = await publish({ catalog: damas, version: "0.1.10", sourceDir: fixture(root, damas, "0.1.10", (s) => `damas ${s}`), out: join(root, "out2"), stateDir: join(root, "out.state") });
  assert.equal(second.action, "promote");
  assert.deepEqual(readdirSync(join(root, "out2", "pkgs")).sort(), ["damas"], "each package writes only its own file");
  const carried = readFileSync(join(root, "out2.state", "sql-pipe", "state.json"), "utf8");
  assert.equal(JSON.parse(carried).version, "0.27.0", "the other package's state is preserved");
});

test("keeps systems a release does not ship and refuses an untouched release", async () => {
  const root = scratch();
  const stateDir = join(root, "state");
  await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (s) => `sql-pipe ${s}`), out: join(root, "o1"), stateDir });
  // A later release that only ships Linux keeps the two macOS entries on the previous version.
  const partial = fixture(root, sqlPipe, "0.28.0", (s) => `sql-pipe ${s}`);
  for (const system of ["x86_64-darwin", "aarch64-darwin"]) rmSync(join(partial, sqlPipe.channels.nix.assets[system]));
  const sums = readFileSync(join(partial, "sha256sums.txt"), "utf8").split("\n").filter((l) => !/macos/.test(l));
  writeFileSync(join(partial, "sha256sums.txt"), `${sums.join("\n").trimEnd()}\n`);
  await publish({ catalog: sqlPipe, version: "0.28.0", sourceDir: partial, out: join(root, "o2"), stateDir: join(root, "o1.state"), systems: "x86_64-linux,aarch64-linux", testSubset: true });
  const versions = JSON.parse(readFileSync(join(root, "o2", versionsPath("sql-pipe")), "utf8"));
  assert.equal(versions["x86_64-linux"].version, "0.28.0");
  assert.equal(versions["x86_64-darwin"].version, "0.27.0");

  // Going back to an older release is refused before anything is written.
  await expectExit(
    publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (s) => `sql-pipe ${s}`), out: join(root, "o3"), stateDir: join(root, "o2.state") }),
    EXIT.version,
    /older than published/,
  );
  assert.equal(existsSync(join(root, "o3")), false);

  // Same version and hashes again: no output at all.
  const again = await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (s) => `sql-pipe ${s}`), out: join(root, "o5"), stateDir: join(root, "o1.state") });
  assert.equal(again.action, "noop");
  assert.equal(existsSync(join(root, "o5")), false);

  // --force rebuilds the file without inventing a new release.
  const forced = await publish({ catalog: sqlPipe, version: "0.27.0", sourceDir: fixture(root, sqlPipe, "0.27.0", (s) => `sql-pipe ${s}`), out: join(root, "o4"), stateDir: join(root, "o1.state"), force: true });
  assert.equal(forced.action, "rebuild");
  assert.match(readFileSync(join(root, "o4", ".complete"), "utf8"), /^rebuild 0\.27\.0\n$/);
});

test("refuses missing assets, wrong checksums and an output inside the state", async () => {
  const root = scratch();
  const base = { catalog: damas, version: "0.1.10", out: join(root, "out"), stateDir: join(root, "state") };

  const missing = fixture(root, damas, "0.1.10", (s) => `damas ${s}`);
  rmSync(join(missing, damas.channels.nix.assets["aarch64-darwin"]));
  await expectExit(publish({ ...base, sourceDir: missing }), EXIT.verify, /missing asset: damas-aarch64-macos/);
  assert.equal(existsSync(join(root, "out")), false);

  const tampered = fixture(root, damas, "0.1.10", (s) => `damas ${s}`);
  writeFileSync(join(tampered, "damas-x86_64-linux"), "changed");
  await expectExit(publish({ ...base, sourceDir: tampered }), EXIT.verify, /sha256 mismatch: damas-x86_64-linux/);

  const unlisted = fixture(root, damas, "0.1.10", (s) => `damas ${s}`);
  writeFileSync(join(unlisted, "sha256sums.txt"), "");
  await expectExit(publish({ ...base, sourceDir: unlisted }), EXIT.verify, /not listed in sha256sums\.txt/);

  await expectExit(
    publish({ ...base, sourceDir: fixture(root, damas, "0.1.10", (s) => `damas ${s}`), out: join(root, "state", "tmp") }),
    EXIT.tool,
    /inside the state directory/,
  );
});
