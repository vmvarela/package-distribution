import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, decideAction, nextArchitectures } from "../scripts/apt-publish.mjs";
import { publish, selectArches, siteFileName } from "../scripts/apk-publish.mjs";
import { validateCatalog } from "../scripts/validate-catalog.mjs";

const sqlPipe = JSON.parse(readFileSync(new URL("../catalog/sql-pipe.json", import.meta.url), "utf8"));
const damas = JSON.parse(readFileSync(new URL("../catalog/damas.json", import.meta.url), "utf8"));
// Real release assets, downloaded and pinned by scripts/fetch-e2e-apks.sh (Alpine tooling is container-only on macOS).
const FIXTURES = process.env.APK_E2E_APKS || join(process.env.TMPDIR || tmpdir(), "apk-test");
const REQUIRE_TOOLS = process.env.APK_PUBLISH_TEST_REQUIRE_TOOLS === "1";
const missing = ["apk", "abuild-sign", "openssl", "tar"].filter((t) => spawnSync(t, ["--help"]).error !== undefined);
const fixturesReady = existsSync(join(FIXTURES, "sql-pipe", "sha256sums.txt")) && existsSync(join(FIXTURES, "damas", "sha256sums.txt"));
const skip = () => {
  const reason = [missing.length && `needs ${missing.join(" and ")}`, !fixturesReady && `needs fixtures in ${FIXTURES}`].filter(Boolean).join("; ");
  return reason && !REQUIRE_TOOLS ? reason : false;
};

const scratchDirs = [];
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "apk-publish-test-"));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });
const expectExit = (promise, code, pattern) => assert.rejects(promise, (e) => e.exitCode === code && (!pattern || pattern.test(e.message)));

test("catalogs declare an apk channel with both architectures", () => {
  for (const catalog of [sqlPipe, damas]) {
    assert.deepEqual(validateCatalog(catalog), []);
    assert.deepEqual(Object.keys(catalog.channels.apk.assets).sort(), ["aarch64", "x86_64"]);
  }
});

test("rejects apk architectures outside the channel vocabulary", () => {
  const c = structuredClone(sqlPipe);
  c.channels.apk.assets.armv7 = "sql-pipe_{version}_armv7.apk";
  assert.match(validateCatalog(c).join("\n"), /channels\.apk\.assets: unknown architecture "armv7"/);

  const subset = structuredClone(damas);
  subset.channels.apk.architectures = ["x86_64"];
  assert.match(validateCatalog(subset).join("\n"), /channels\.apk\.assets: unknown architecture "aarch64"/);
});

test("architectures are selected from the apk channel only", () => {
  assert.deepEqual(selectArches(sqlPipe, undefined, false), ["x86_64", "aarch64"]);
  assert.deepEqual(selectArches(sqlPipe, "aarch64", true), ["aarch64"]);
  assert.throws(() => selectArches(sqlPipe, "aarch64", false), /partial architectures are test-only/);
  assert.throws(() => selectArches(sqlPipe, "amd64", true), /"amd64" is not in the catalog/);
  assert.throws(() => selectArches(sqlPipe, "x86_64,x86_64", true), /duplicate architecture/);
});

test("the site serves packages under the name apk derives from the index", () => {
  // apk builds the URL from P: and V:, so any other file name would 404.
  assert.equal(siteFileName("sql-pipe", "0.27.0"), "sql-pipe-0.27.0.apk");
});

test("retention and downgrade rules apply to apk architecture names", () => {
  const state = { architectures: { x86_64: [{ version: "0.27.0", sha256: "a".repeat(64), file: "sql-pipe_0.27.0_x86_64.apk" }] } };
  assert.equal(decideAction(state, new Map([["x86_64", { version: "0.27.0", sha256: "a".repeat(64) }]])), "noop");
  assert.throws(() => decideAction(state, new Map([["x86_64", { version: "0.26.0", sha256: "a".repeat(64) }]])), (e) => e.exitCode === EXIT.version && /older than published/.test(e.message));
  assert.throws(() => decideAction(state, new Map([["x86_64", { version: "0.27.0", sha256: "b".repeat(64) }]])), (e) => e.exitCode === EXIT.version && /different content/.test(e.message));

  const next = nextArchitectures(state, new Map([["aarch64", { version: "0.28.0", sha256: "c".repeat(64), file: "sql-pipe_0.28.0_aarch64.apk" }]]));
  assert.equal(next.aarch64[0].version, "0.28.0");
  assert.equal(next.x86_64[0].version, "0.27.0", "an architecture without a candidate is carried forward");
});

function makeKey(dir) {
  const key = join(dir, "vmvarela.rsa");
  mkdirSync(dir, { recursive: true });
  execFileSync("openssl", ["genrsa", "-out", key, "2048"], { stdio: "ignore" });
  const publicKey = execFileSync("openssl", ["rsa", "-in", key, "-pubout"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { privateKey: readFileSync(key, "utf8"), publicKey };
}

const indexMembers = (file) => execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");

test(
  "publishes a signed index and carries other packages forward",
  { skip: skip() },
  async () => {
    const root = scratch();
    const { privateKey, publicKey } = makeKey(join(root, "keys"));
    const base = { privateKey, catalog: sqlPipe, version: "0.27.0", sourceDir: join(FIXTURES, "sql-pipe") };

    await publish({ ...base, out: join(root, "o1"), stateDir: join(root, "state") });
    assert.match(readFileSync(join(root, "o1", ".complete"), "utf8"), /^promote 0\.27\.0\n$/);
    assert.equal(readFileSync(join(root, "o1", "vmvarela.rsa.pub"), "utf8"), publicKey);
    for (const arch of ["x86_64", "aarch64"]) {
      const dir = join(root, "o1", arch);
      assert.ok(existsSync(join(dir, "sql-pipe-0.27.0.apk")), "the site uses the name apk derives, not the release name");
      assert.equal(indexMembers(join(dir, "APKINDEX.tar.gz"))[0], ".SIGN.RSA.vmvarela.rsa.pub");
    }
    const state = JSON.parse(readFileSync(join(root, "o1.state", "sql-pipe", "state.json"), "utf8"));
    assert.equal(state.architectures.x86_64[0].version, "0.27.0");
    assert.equal(state.architectures.x86_64[0].file, "sql-pipe_0.27.0_x86_64.apk", "the pool keeps the release asset name");

    const damasArgs = { privateKey, catalog: damas, version: "0.1.10", sourceDir: join(FIXTURES, "damas") };
    await publish({ ...damasArgs, out: join(root, "o2"), stateDir: join(root, "o1.state") });
    const list = readdirSync(join(root, "o2", "x86_64"));
    assert.ok(list.includes("sql-pipe-0.27.0.apk"), "the triggered package does not drop the others");
    assert.ok(list.includes("damas-0.1.10.apk"));
    assert.equal(indexMembers(join(root, "o2", "x86_64", "APKINDEX.tar.gz"))[0], ".SIGN.RSA.vmvarela.rsa.pub");
    assert.ok(existsSync(join(root, "o2.state", "sql-pipe", "state.json")), "candidate state keeps every package");
    assert.ok(existsSync(join(root, "o2.state", "damas", "state.json")));

    // Forced rebuild of the same release: a noop that still signs and writes site and candidate state.
    const forced = await publish({ ...damasArgs, out: join(root, "forced"), stateDir: join(root, "o2.state"), force: true });
    assert.equal(forced.action, "noop");
    assert.match(readFileSync(join(root, "forced", ".complete"), "utf8"), /^noop 0\.1\.10\n$/);
    assert.equal(indexMembers(join(root, "forced", "x86_64", "APKINDEX.tar.gz"))[0], ".SIGN.RSA.vmvarela.rsa.pub");
    assert.ok(existsSync(join(root, "forced.state", "damas", "state.json")));

    // Output inside the state root is refused even without --shadow: it would poison every later read.
    await expectExit(
      publish({ ...damasArgs, out: join(root, "o2.state", "tmp"), stateDir: join(root, "o2.state") }),
      EXIT.tool,
      /inside the state directory/,
    );

    // Same release again: noop, no site and no candidate state.
    const again = await publish({ ...damasArgs, out: join(root, "o3"), stateDir: join(root, "o2.state") });
    assert.equal(again.action, "noop");
    assert.equal(existsSync(join(root, "o3")), false);

    // A newer version recorded in the state refuses the older release before touching anything.
    const forged = join(root, "forged");
    mkdirSync(join(forged, "damas", "pool"), { recursive: true });
    const current = JSON.parse(readFileSync(join(root, "o2.state", "damas", "state.json"), "utf8"));
    current.architectures.x86_64[0].version = "0.2.0";
    writeFileSync(join(forged, "damas", "state.json"), JSON.stringify(current));
    await expectExit(publish({ ...damasArgs, out: join(root, "o4"), stateDir: forged }), EXIT.version, /older than published/);
    assert.equal(existsSync(join(root, "o4")), false);
  },
);

test(
  "refuses missing assets, wrong checksums and mismatched metadata",
  { skip: skip() },
  async () => {
    const root = scratch();
    const { privateKey } = makeKey(join(root, "keys"));
    const base = { privateKey, catalog: damas, version: "0.1.10", out: join(root, "out"), stateDir: join(root, "state") };
    const copy = (name) => {
      const dir = join(root, name, "damas");
      mkdirSync(dir, { recursive: true });
      execFileSync("cp", ["-R", `${join(FIXTURES, "damas")}/.`, dir]);
      return dir;
    };

    const missingAsset = copy("missing");
    rmSync(join(missingAsset, "damas_0.1.10_aarch64.apk"));
    await expectExit(publish({ ...base, sourceDir: missingAsset }), EXIT.verify, /missing asset: damas_0\.1\.10_aarch64\.apk/);
    assert.equal(existsSync(join(root, "out")), false);

    const tampered = copy("tampered");
    writeFileSync(join(tampered, "damas_0.1.10_x86_64.apk"), Buffer.concat([readFileSync(join(tampered, "damas_0.1.10_x86_64.apk")), Buffer.from("x")]));
    await expectExit(publish({ ...base, sourceDir: tampered }), EXIT.verify, /sha256 mismatch/);

    // The x86_64 package under the aarch64 name with its matching checksum: the hash gate passes and the
    // .PKGINFO gate is the one that refuses.
    const swapped = copy("swapped");
    execFileSync("cp", [join(swapped, "damas_0.1.10_x86_64.apk"), join(swapped, "damas_0.1.10_aarch64.apk")]);
    const x86Hash = readFileSync(join(FIXTURES, "damas", "sha256sums.txt"), "utf8").split("\n").find((l) => l.trim().endsWith("  damas_0.1.10_x86_64.apk")).split(/\s+/)[0];
    const lines = readFileSync(join(FIXTURES, "damas", "sha256sums.txt"), "utf8").trimEnd().split("\n");
    writeFileSync(join(swapped, "sha256sums.txt"), `${lines.map((l) => (l.trim().endsWith("damas_0.1.10_aarch64.apk") ? `${x86Hash}  damas_0.1.10_aarch64.apk` : l)).join("\n")}\n`);
    await expectExit(publish({ ...base, sourceDir: swapped }), EXIT.verify, /metadata is damas 0\.1\.10 x86_64, expected damas 0\.1\.10 aarch64/);

    // A missing signing key is a failure, never an unsigned site.
    await expectExit(publish({ ...base, privateKey: "", sourceDir: join(FIXTURES, "damas") }), EXIT.tool, /APK_SIGNING_KEY is required/);
  },
);
