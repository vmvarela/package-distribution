import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseStanzas, verifySignatures, compareSites } from "../scripts/apt-compare.mjs";
import {
  EXIT,
  compareVersions,
  decideAction,
  downloadRelease,
  nextArchitectures,
  parseSha256Sums,
  parseVersion,
  publish,
  sha256,
} from "../scripts/apt-publish.mjs";

const catalog = JSON.parse(readFileSync(new URL("../catalog/sql-pipe.json", import.meta.url), "utf8"));
const ARCHES = ["amd64", "arm64", "armhf", "i386"];
const hasTool = (cmd, args) => spawnSync(cmd, args).error === undefined;
// APT_PUBLISH_TEST_REQUIRE_TOOLS=1 (set in validation) turns a missing tool into a failure instead of a skip.
const REQUIRE_TOOLS = process.env.APT_PUBLISH_TEST_REQUIRE_TOOLS === "1";
function toolGate(tools) {
  const missing = tools.filter((t) => spawnSync(t, ["--version"]).error !== undefined);
  return {
    skip: missing.length && !REQUIRE_TOOLS ? `needs ${missing.join(" and ")}` : false,
    check: () => assert.equal(missing.length, 0, `required tools missing: ${missing.join(", ")}`),
  };
}
const fullGate = toolGate(["dpkg-deb", "gpg"]);
const debGate = toolGate(["dpkg-deb"]);
const scratchDirs = [];
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "apt-publish-test-"));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });
const name = (arch, version) => catalog.channels.apt.assets[arch].replace("{version}", version);

function writeRelease(dir, version, contents = () => Buffer.from(`fake ${version}`)) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const arch of ARCHES) {
    const buf = contents(arch);
    writeFileSync(join(dir, name(arch, version)), buf);
    lines.push(`${sha256(buf)}  ${name(arch, version)}`);
  }
  writeFileSync(join(dir, catalog.checksums), `${lines.join("\n")}\n`);
  return dir;
}

function makeDeb(dir, version, arch, cat = catalog) {
  const file = cat.channels.apt.assets[arch].replace("{version}", version);
  const stage = join(dir, `stage-${cat.project}-${arch}-${version}`);
  mkdirSync(join(stage, "DEBIAN"), { recursive: true });
  writeFileSync(
    join(stage, "DEBIAN", "control"),
    `Package: ${cat.channels.apt.package}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: t <t@invalid>\nDescription: test package\n`,
  );
  writeFileSync(join(stage, "usr-marker"), version);
  const out = join(dir, file);
  execFileSync("dpkg-deb", ["--root-owner-group", "--build", stage, out], { stdio: "ignore" });
  return out;
}

function realRelease(dir, version) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const arch of ARCHES) {
    const file = makeDeb(dir, version, arch);
    lines.push(`${sha256(readFileSync(file))}  ${name(arch, version)}`);
  }
  writeFileSync(join(dir, catalog.checksums), `${lines.join("\n")}\n`);
  return dir;
}

// Like realRelease, but each file is named for the release while its control fields come from control(arch) = [version, arch].
function releaseWithControl(dir, version, control) {
  mkdirSync(join(dir, "build"), { recursive: true });
  const lines = [];
  for (const arch of ARCHES) {
    const [v, a] = control(arch);
    const file = join(dir, name(arch, version));
    renameSync(makeDeb(join(dir, "build"), v, a), file);
    lines.push(`${sha256(readFileSync(file))}  ${name(arch, version)}`);
  }
  writeFileSync(join(dir, catalog.checksums), `${lines.join("\n")}\n`);
  return dir;
}

const base = (root, extra = {}) => ({
  catalog,
  version: "0.27.0",
  sourceDir: join(root, "src"),
  out: join(root, "out"),
  stateDir: join(root, "state"),
  releaseDate: "2026-10-20",
  gpgKeyId: "test@invalid",
  ...extra,
});

// Mirrors the publication step: durable state keeps the retained pool and the new state.json.
function promote(root, site, state) {
  rmSync(state, { recursive: true, force: true });
  cpSync(join(root, `${site}.state`), state, { recursive: true });
}

async function expectExit(promise, code, pattern) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.exitCode, code, err.message);
    assert.match(err.message, pattern);
    return true;
  });
}

test("accepts only stable X.Y.Z versions", () => {
  assert.deepEqual(parseVersion("0.27.0"), [0, 27, 0]);
  assert.deepEqual(parseVersion("9007199254740991.0.0"), [Number.MAX_SAFE_INTEGER, 0, 0]);
  for (const bad of ["0.27.0-rc1", "v0.27.0", "../0.27.0", "1.2", "01.2.3", "1.2.3+build", "9007199254740992.0.0", "1.99999999999999999999.0"]) {
    assert.throws(() => parseVersion(bad), /stable X\.Y\.Z/, bad);
  }
});

test("compares versions numerically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.26.0", "0.27.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("parses checksum lists and rejects malformed or duplicate lines", () => {
  const h = "a".repeat(64);
  assert.equal(parseSha256Sums(`${h}  x.deb\n`).get("x.deb"), h);
  assert.throws(() => parseSha256Sums("nothex x.deb\n"), /malformed/);
  assert.throws(() => parseSha256Sums(`${h}  x.deb\n${h}  x.deb\n`), /duplicate/);
});

test("decides promote, no-op, downgrade and conflict", () => {
  const cand = (version, sha = "s1") => new Map(ARCHES.map((a) => [a, { version, sha256: sha }]));
  const state = {
    architectures: Object.fromEntries(ARCHES.map((a) => [a, [{ version: "0.26.0", sha256: "s0" }]])),
  };
  assert.equal(decideAction(null, cand("0.26.0")), "promote");
  assert.equal(decideAction(state, cand("0.27.0")), "promote");
  assert.throws(() => decideAction(state, cand("0.25.0")), (e) => e.exitCode === EXIT.version);
  const same = { architectures: Object.fromEntries(ARCHES.map((a) => [a, [{ version: "0.27.0", sha256: "s1" }]])) };
  assert.equal(decideAction(same, cand("0.27.0")), "noop");
  assert.throws(() => decideAction(same, cand("0.27.0", "other")), (e) => e.exitCode === EXIT.version);
});

test("retains current and previous version per architecture", () => {
  const cands = new Map([["amd64", { version: "0.28.0", sha256: "c", file: "x_0.28.0_amd64.deb" }]]);
  const state = {
    architectures: {
      amd64: [{ version: "0.27.0", sha256: "b", file: "x_0.27.0_amd64.deb" }, { version: "0.26.0", sha256: "a", file: "x_0.26.0_amd64.deb" }],
      arm64: [{ version: "0.27.0", sha256: "d", file: "x_0.27.0_arm64.deb" }],
    },
  };
  // arm64 has no candidate: it is carried forward unchanged, not rotated.
  assert.deepEqual(nextArchitectures(state, cands), {
    amd64: [{ version: "0.28.0", sha256: "c", file: "x_0.28.0_amd64.deb" }, { version: "0.27.0", sha256: "b", file: "x_0.27.0_amd64.deb" }],
    arm64: [{ version: "0.27.0", sha256: "d", file: "x_0.27.0_arm64.deb" }],
  });
});

test("fails on sha256 mismatch before writing anything", async () => {
  const root = scratch();
  const src = writeRelease(join(root, "src"), "0.27.0");
  writeFileSync(join(src, catalog.checksums), `${"0".repeat(64)}  ${name("amd64", "0.27.0")}\n`, { flag: "w" });
  await expectExit(publish(base(root, { catalog })), EXIT.verify, /missing|sha256 mismatch|not listed/);
  assert.equal(existsSync(join(root, "out")), false);
});

test("fails when a .deb is missing or not listed in the checksum file", async () => {
  const root = scratch();
  const src = writeRelease(join(root, "src"), "0.27.0");
  rmSync(join(src, name("arm64", "0.27.0")));
  await expectExit(publish(base(root)), EXIT.verify, /missing asset: sql-pipe_0.27.0_arm64.deb/);

  const root2 = scratch();
  const src2 = writeRelease(join(root2, "src"), "0.27.0");
  writeFileSync(join(src2, catalog.checksums), readFileSync(join(src2, catalog.checksums), "utf8").split("\n").slice(1).join("\n"));
  await expectExit(publish(base(root2)), EXIT.verify, /not listed/);
});

test("rejects bad versions, unknown architectures and partial sets without the test flag", async () => {
  const root = scratch();
  writeRelease(join(root, "src"), "0.27.0");
  await expectExit(publish(base(root, { version: "0.27.0-rc1" })), EXIT.tool, /stable X\.Y\.Z/);
  await expectExit(publish(base(root, { arches: "amd64" })), EXIT.tool, /--test-subset/);
  await expectExit(publish(base(root, { arches: "amd64,arm64,armhf,riscv" })), EXIT.tool, /not in the catalog/);
});

test("rejects duplicate architectures, even with the test flag", async () => {
  const root = scratch();
  writeRelease(join(root, "src"), "0.27.0");
  await expectExit(publish(base(root, { arches: "amd64,amd64,amd64,amd64" })), EXIT.tool, /duplicate/);
  await expectExit(publish(base(root, { arches: "amd64,amd64,arm64,armhf" })), EXIT.tool, /duplicate/);
  await expectExit(publish(base(root, { arches: "amd64,amd64", testSubset: true })), EXIT.tool, /duplicate/);
});

test("rejects impossible release dates", async () => {
  const root = scratch();
  writeRelease(join(root, "src"), "0.27.0");
  await expectExit(publish(base(root, { releaseDate: "2026-02-30" })), EXIT.tool, /real YYYY-MM-DD/);
  assert.equal(existsSync(join(root, "out")), false);
});

test("rejects retained state entries with unsafe versions or hashes before reading any source", async () => {
  const root = scratch();
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(state, "sql-pipe"));
  const write = (entry) =>
    writeFileSync(join(state, "sql-pipe", "state.json"), JSON.stringify({ schema_version: 1, package: "sql-pipe", architectures: { amd64: [{ file: "sql-pipe_0.26.0_amd64.deb", ...entry }] } }));
  write({ version: "../../escape", sha256: "a".repeat(64) });
  await expectExit(publish(base(root, { stateDir: state })), EXIT.tool, /stable X\.Y\.Z/);
  write({ version: "0.26.0", sha256: "not-a-hash" });
  await expectExit(publish(base(root, { stateDir: state })), EXIT.tool, /unexpected state file/);
});

test(
  "rejects .deb control metadata that does not match the release",
  { skip: debGate.skip },
  async () => {
    debGate.check();
    const root = scratch();
    // amd64 claims 0.26.0 under the 0.27.0 file name.
    const wrongVersion = releaseWithControl(join(root, "src"), "0.27.0", (arch) => [arch === "amd64" ? "0.26.0" : "0.27.0", arch]);
    await expectExit(publish(base(root, { sourceDir: wrongVersion })), EXIT.verify, /control is sql-pipe 0.26.0 amd64, expected sql-pipe 0.27.0 amd64/);
    // armhf file carries an arm64 control record.
    const wrongArch = releaseWithControl(join(root, "src2"), "0.27.0", (arch) => ["0.27.0", arch === "armhf" ? "arm64" : arch]);
    await expectExit(publish(base(root, { sourceDir: wrongArch, out: join(root, "out2") })), EXIT.verify, /control is sql-pipe 0.27.0 arm64, expected sql-pipe 0.27.0 armhf/);
    assert.equal(existsSync(join(root, "out")), false);
    assert.equal(existsSync(join(root, "out2")), false);
  },
);

test(
  "publishes a signed site, keeps two versions, and refuses downgrades",
  { skip: fullGate.skip },
  async () => {
    fullGate.check();
    const root = scratch();
    const oldHome = process.env.GNUPGHOME;
    process.env.GNUPGHOME = join(root, "gnupg");
    mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
    try {
      execFileSync("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "test@invalid", "default", "default", "never"], { stdio: "ignore" });

      const r1 = { ...base(root, { version: "0.26.0", sourceDir: realRelease(join(root, "r26"), "0.26.0"), out: join(root, "o26") }) };
      await publish(r1);
      const release26 = join(root, "o26", "dists", "stable", "Release");
      assert.match(readFileSync(release26, "utf8"), /^Date: Tue, 20 Oct 2026 00:00:00 GMT$/m);
      const packages = gunzipSync(readFileSync(join(root, "o26", "dists", "stable", "main", "binary-amd64", "Packages.gz"))).toString();
      assert.match(packages, /^Version: 0.26.0$/m);
      assert.match(packages, /^Filename: pool\/main\/s\/sql-pipe\/sql-pipe_0.26.0_amd64.deb$/m);
      execFileSync("gpg", ["--batch", "--verify", join(root, "o26", "dists", "stable", "Release.gpg"), release26], { stdio: "ignore" });
      assert.ok(existsSync(join(root, "o26", "key.asc")));
      assert.ok(existsSync(join(root, "o26", ".complete")));

      // Promote the first run the way the publication step would: site, pool and state.
      const state = join(root, "state");
      promote(root, "o26", state);

      const r27 = base(root, { version: "0.27.0", sourceDir: realRelease(join(root, "r27"), "0.27.0"), out: join(root, "o27"), stateDir: state });
      assert.equal((await publish(r27)).action, "promote");
      const pool = execFileSync("ls", [join(root, "o27", "pool", "main", "s", "sql-pipe")]).toString().trim().split("\n");
      assert.equal(pool.length, 8, "two versions for four architectures");

      await expectExit(publish({ ...base(root, { version: "0.25.0", sourceDir: realRelease(join(root, "r25"), "0.25.0"), out: join(root, "o25"), stateDir: state }) }), EXIT.version, /older/);

      promote(root, "o27", state);
      const again = base(root, { version: "0.27.0", sourceDir: join(root, "r27"), out: join(root, "o27b"), stateDir: state });
      assert.equal((await publish(again)).action, "noop");
      assert.equal(existsSync(join(root, "o27b")), false, "noop must not regenerate or sign a site");
      assert.equal(existsSync(join(root, "o27b.state")), false, "noop must not write candidate state");
    } finally {
      process.env.GNUPGHOME = oldHome;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// Stubs fetch for the GitHub release API and asset URLs; restores the original afterwards.
async function withFakeGitHub(release, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/releases/tags/")) return new Response(JSON.stringify(release));
    return new Response(Buffer.from("bytes"));
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
const tmpPublishDirs = () => readdirSync(process.env.TMPDIR || tmpdir()).filter((n) => n.startsWith("apt-publish-")).length;

test("github source refuses draft and prerelease releases", async () => {
  for (const flag of ["draft", "prerelease"]) {
    await withFakeGitHub({ [flag]: true, assets: [] }, async () => {
      await assert.rejects(downloadRelease({ repo: "o/r", version: "0.27.0", names: [] }), (e) => e.exitCode === EXIT.verify && /draft or prerelease/.test(e.message));
    });
  }
});

test("github source removes its temp dir when an asset is missing", async () => {
  const before = tmpPublishDirs();
  await withFakeGitHub({ assets: [] }, async () => {
    await assert.rejects(downloadRelease({ repo: "o/r", version: "0.27.0", names: ["sha256sums.txt"] }), /missing asset: sha256sums.txt/);
  });
  assert.equal(tmpPublishDirs(), before);
});

// Multi-package state: sql-pipe (four arches) and ghoten (amd64 and arm64 only) share one site and one state root.
const ghotenCatalog = JSON.parse(readFileSync(new URL("../catalog/ghoten.json", import.meta.url), "utf8"));
const fileFor = (cat, arch, version) => cat.channels.apt.assets[arch].replace("{version}", version);

function packageRelease(dir, cat, version) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const arch of Object.keys(cat.channels.apt.assets)) {
    const file = makeDeb(dir, version, arch, cat);
    lines.push(`${sha256(readFileSync(file))}  ${fileFor(cat, arch, version)}`);
  }
  writeFileSync(join(dir, cat.checksums), `${lines.join("\n")}\n`);
  return dir;
}

// Runs fn with an isolated keyring; the signing key is generated once per test root.
async function withGpg(root, fn) {
  const oldHome = process.env.GNUPGHOME;
  process.env.GNUPGHOME = join(root, "gnupg");
  mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
  try {
    execFileSync("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "test@invalid", "default", "default", "never"], { stdio: "ignore" });
    return await fn();
  } finally {
    process.env.GNUPGHOME = oldHome;
  }
}

// Publishes one package version from a fresh release. Returns the out dir (candidate state is out + ".state").
function publishPkg(root, cat, version, { stateDir, out, shadow = false } = {}) {
  const target = out ?? join(root, "out", `${cat.project}-${version}-${Math.random().toString(36).slice(2, 8)}`);
  return publish({
    catalog: cat,
    version,
    sourceDir: packageRelease(join(root, "src", `${cat.project}-${version}`), cat, version),
    out: target,
    stateDir: stateDir ?? join(root, "state"),
    releaseDate: "2026-10-20",
    gpgKeyId: "test@invalid",
    shadow,
  }).then((result) => ({ ...result, out: target }));
}

// Adopts a candidate as the durable state, as the publication step would.
function promoteOut(out, state) {
  rmSync(state, { recursive: true, force: true });
  cpSync(`${out}.state`, state, { recursive: true });
}

const packagesOf = (site, arch) =>
  parseStanzas(readFileSync(join(site, "dists", "stable", "main", `binary-${arch}`, "Packages"), "utf8")).map((p) => `${p.Package} ${p.Version}`);
const releaseArches = (site) => /^Architectures: (.*)$/m.exec(readFileSync(join(site, "dists", "stable", "Release"), "utf8"))[1];

test("multi-package: each publish keeps the other package from state", { skip: fullGate.skip }, async () => {
  fullGate.check();
  const root = scratch();
  await withGpg(root, async () => {
    const state = join(root, "state");
    const sp26 = await publishPkg(root, catalog, "0.26.0");
    promoteOut(sp26.out, state);
    const gh = await publishPkg(root, ghotenCatalog, "1.13.1");
    assert.deepEqual(packagesOf(gh.out, "amd64").sort(), ["ghoten 1.13.1", "sql-pipe 0.26.0"]);
    assert.deepEqual(packagesOf(gh.out, "armhf"), ["sql-pipe 0.26.0"], "ghoten has no armhf entry");
    assert.equal(releaseArches(gh.out), "amd64 arm64 armhf i386");
    promoteOut(gh.out, state);

    const sp27 = await publishPkg(root, catalog, "0.27.0");
    assert.deepEqual(packagesOf(sp27.out, "arm64").sort(), ["ghoten 1.13.1", "sql-pipe 0.26.0", "sql-pipe 0.27.0"]);
    assert.ok(existsSync(join(sp27.out, "pool", "main", "g", "ghoten", "ghoten_1.13.1_arm64.deb")), "ghoten pool file carried");
    promoteOut(sp27.out, state);

    const gh2 = await publishPkg(root, ghotenCatalog, "1.14.0");
    assert.deepEqual(packagesOf(gh2.out, "amd64").sort(), ["ghoten 1.13.1", "ghoten 1.14.0", "sql-pipe 0.26.0", "sql-pipe 0.27.0"]);
    assert.deepEqual(packagesOf(gh2.out, "i386").sort(), ["sql-pipe 0.26.0", "sql-pipe 0.27.0"]);
  });
});

test("retention keeps exactly current and previous per package and architecture", { skip: fullGate.skip }, async () => {
  fullGate.check();
  const root = scratch();
  await withGpg(root, async () => {
    const state = join(root, "state");
    for (const v of ["0.26.0", "0.27.0", "0.28.0"]) promoteOut((await publishPkg(root, catalog, v, { stateDir: state })).out, state);
    for (const v of ["1.13.1", "1.13.2", "1.13.3"]) promoteOut((await publishPkg(root, ghotenCatalog, v, { stateDir: state })).out, state);

    const sp = JSON.parse(readFileSync(join(state, "sql-pipe", "state.json"), "utf8"));
    const gh = JSON.parse(readFileSync(join(state, "ghoten", "state.json"), "utf8"));
    for (const arch of ["amd64", "arm64", "armhf", "i386"]) assert.deepEqual(sp.architectures[arch].map((e) => e.version), ["0.28.0", "0.27.0"], arch);
    for (const arch of ["amd64", "arm64"]) assert.deepEqual(gh.architectures[arch].map((e) => e.version), ["1.13.3", "1.13.2"], arch);
    assert.equal(Object.keys(gh.architectures).length, 2);
    assert.equal(readdirSync(join(state, "sql-pipe", "pool")).length, 8, "two versions for four architectures");
    assert.equal(readdirSync(join(state, "ghoten", "pool")).length, 4, "two versions for two architectures");
  });
});

test("a retained pool file missing from state fails before anything is complete", { skip: fullGate.skip }, async () => {
  fullGate.check();
  const root = scratch();
  await withGpg(root, async () => {
    const state = join(root, "state");
    promoteOut((await publishPkg(root, catalog, "0.26.0", { stateDir: state })).out, state);
    promoteOut((await publishPkg(root, ghotenCatalog, "1.13.1", { stateDir: state })).out, state);
    rmSync(join(state, "ghoten", "pool", "ghoten_1.13.1_arm64.deb"));
    // sql-pipe is the triggered package; the missing ghoten file is carried forward and must still fail.
    const out = join(root, "out-missing");
    await expectExit(publishPkg(root, catalog, "0.27.0", { stateDir: state, out }), EXIT.verify, /retained package missing from state: ghoten_1.13.1_arm64.deb/);
    assert.equal(existsSync(join(out, ".complete")), false);
  });
});

test("shadow mode writes only to out and its candidate state, never to the state root", { skip: fullGate.skip }, async () => {
  fullGate.check();
  const root = scratch();
  await withGpg(root, async () => {
    const state = join(root, "state");
    promoteOut((await publishPkg(root, catalog, "0.26.0", { stateDir: state })).out, state);
    const before = execFileSync("find", [state, "-type", "f", "-exec", "shasum", "-a", "256", "{}", ";"]).toString();
    const out = join(root, "shadow-out");
    const r = await publishPkg(root, catalog, "0.27.0", { stateDir: state, out, shadow: true });
    assert.equal(r.action, "promote");
    assert.match(readFileSync(join(out, ".complete"), "utf8"), /^shadow promote 0.27.0\n$/);
    assert.ok(existsSync(join(`${out}.state`, "sql-pipe", "state.json")));
    assert.equal(execFileSync("find", [state, "-type", "f", "-exec", "shasum", "-a", "256", "{}", ";"]).toString(), before, "state root untouched");
    await expectExit(publish(base(root, { shadow: true, out: join(state, "inside"), stateDir: state })), EXIT.tool, /inside the state directory/);
  });
});

test("compare reports a missing package and a changed hash, and verifies the signature", { skip: fullGate.skip }, async () => {
  fullGate.check();
  const root = scratch();
  await withGpg(root, async () => {
    const state = join(root, "state");
    const live = (await publishPkg(root, catalog, "0.26.0", { stateDir: state })).out;
    promoteOut(live, state);
    const withGhoten = (await publishPkg(root, ghotenCatalog, "1.13.1", { stateDir: state })).out;

    const missing = await compareSites(live, withGhoten);
    assert.ok(missing.includes("amd64: missing in candidate: ghoten 1.13.1"), missing.join("\n"));
    const extra = await compareSites(withGhoten, live);
    assert.ok(extra.includes("amd64: only in candidate: ghoten 1.13.1"), extra.join("\n"));
    assert.deepEqual(await verifySignatures(withGhoten, join(live, "key.asc")), []);

    // A candidate whose index names a different hash for the same .deb is a difference, not a match.
    const tampered = join(root, "tampered");
    cpSync(live, tampered, { recursive: true });
    const packages = join(tampered, "dists", "stable", "main", "binary-amd64", "Packages");
    writeFileSync(packages, readFileSync(packages, "utf8").replace(/^SHA256: [0-9a-f]{64}$/m, `SHA256: ${"0".repeat(64)}`));
    assert.ok((await compareSites(tampered, live)).some((d) => /SHA256 changed/.test(d)));
    assert.equal(spawnSync("node", [new URL("../scripts/apt-compare.mjs", import.meta.url).pathname, "--candidate", tampered, "--live", live]).status, 3);
    assert.equal(spawnSync("node", [new URL("../scripts/apt-compare.mjs", import.meta.url).pathname, "--candidate", live, "--live", live]).status, 0);

    // A forged release signature is rejected by the live key.
    const forged = join(root, "forged");
    cpSync(live, forged, { recursive: true });
    writeFileSync(join(forged, "dists", "stable", "Release"), readFileSync(join(forged, "dists", "stable", "Release"), "utf8") + "Forged: yes\n");
    assert.ok((await verifySignatures(forged, join(live, "key.asc"))).length > 0);
  });
});

test("ghoten architecture subset is enforced at publish time", async () => {
  const root = scratch();
  writeRelease(join(root, "src"), "0.27.0");
  const gh = { catalog: ghotenCatalog, version: "1.13.1", sourceDir: join(root, "src"), out: join(root, "o"), stateDir: join(root, "s"), releaseDate: "2026-10-20", gpgKeyId: "test@invalid" };
  await expectExit(publish({ ...gh, arches: "amd64,arm64,armhf" }), EXIT.tool, /not in the catalog/);
  await expectExit(publish({ ...gh, arches: "amd64" }), EXIT.tool, /--test-subset/);
  assert.equal(existsSync(join(root, "o")), false);
});
