import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, decideAction, nextArchitectures } from "../scripts/apt-publish.mjs";
import { defaultBaseUrl, publish, repoFile, selectArches } from "../scripts/rpm-publish.mjs";
import { validateCatalog } from "../scripts/validate-catalog.mjs";

const sqlPipe = JSON.parse(readFileSync(new URL("../catalog/sql-pipe.json", import.meta.url), "utf8"));
const damas = JSON.parse(readFileSync(new URL("../catalog/damas.json", import.meta.url), "utf8"));
// Real release assets, downloaded and pinned by scripts/fetch-e2e-rpms.sh (no synthetic RPM toolchain needed).
const FIXTURES = process.env.RPM_E2E_RPMS || join(process.env.TMPDIR || tmpdir(), "rpm-test");
const REQUIRE_TOOLS = process.env.RPM_PUBLISH_TEST_REQUIRE_TOOLS === "1";
const missing = ["rpm", "createrepo_c", "gpg"].filter((t) => spawnSync(t, ["--version"]).error !== undefined);
const fixturesReady = existsSync(join(FIXTURES, "sql-pipe", "sha256sums.txt")) && existsSync(join(FIXTURES, "damas", "sha256sums.txt"));
const skip = () => {
  const reason = [missing.length && `needs ${missing.join(" and ")}`, !fixturesReady && `needs fixtures in ${FIXTURES}`].filter(Boolean).join("; ");
  return reason && !REQUIRE_TOOLS ? reason : false;
};

const scratchDirs = [];
const scratch = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "rpm-publish-test-"));
  scratchDirs.push(dir);
  return dir;
};
after(() => { for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true }); });
const expectExit = (promise, code, pattern) => assert.rejects(promise, (e) => e.exitCode === code && (!pattern || pattern.test(e.message)));

test("catalogs declare an rpm channel with both architectures", () => {
  for (const catalog of [sqlPipe, damas]) {
    assert.deepEqual(validateCatalog(catalog), []);
    assert.deepEqual(Object.keys(catalog.channels.rpm.assets).sort(), ["aarch64", "x86_64"]);
  }
});

test("rejects rpm architectures outside the channel vocabulary", () => {
  const c = structuredClone(sqlPipe);
  c.channels.rpm.assets.armv7hl = "sql-pipe-{version}-1.armv7hl.rpm";
  assert.match(validateCatalog(c).join("\n"), /channels\.rpm\.assets: unknown architecture "armv7hl"/);

  const subset = structuredClone(damas);
  subset.channels.rpm.architectures = ["x86_64"];
  assert.match(validateCatalog(subset).join("\n"), /channels\.rpm\.assets: unknown architecture "aarch64"/);

  const unknownChannel = structuredClone(sqlPipe);
  unknownChannel.channels.brew = { repo: "vmvarela/homebrew-tap", package: "sql-pipe", assets: {} };
  assert.match(validateCatalog(unknownChannel).join("\n"), /unknown channel "brew"/);
});

test("architectures are selected from the rpm channel only", () => {
  assert.deepEqual(selectArches(sqlPipe, undefined, false), ["x86_64", "aarch64"]);
  assert.deepEqual(selectArches(sqlPipe, "x86_64", true), ["x86_64"]);
  assert.throws(() => selectArches(sqlPipe, "x86_64", false), /partial architectures are test-only/);
  assert.throws(() => selectArches(sqlPipe, "amd64", true), /"amd64" is not in the catalog/);
  assert.throws(() => selectArches(sqlPipe, "x86_64,x86_64", true), /duplicate architecture/);
});

test("the repo file requires both signature checks", () => {
  assert.equal(defaultBaseUrl("vmvarela/rpm-packages"), "https://vmvarela.github.io/rpm-packages");
  const repo = repoFile({ baseUrl: "https://vmvarela.github.io/rpm-packages" });
  assert.match(repo, /^gpgcheck=1$/m);
  assert.match(repo, /^repo_gpgcheck=1$/m);
  // Without it dnf5 only warns about a missing repomd signature, so the shipped file must carry it.
  assert.match(repo, /^skip_if_unavailable=0$/m);
  assert.match(repo, /^baseurl=https:\/\/vmvarela\.github\.io\/rpm-packages\/packages\/\$basearch$/m);
  assert.match(repo, /^gpgkey=https:\/\/vmvarela\.github\.io\/rpm-packages\/RPM-GPG-KEY-vmvarela$/m);
});

test("retention and downgrade rules apply to rpm architecture names", () => {
  const state = { architectures: { x86_64: [{ version: "0.27.0", sha256: "a".repeat(64), file: "sql-pipe-0.27.0-1.x86_64.rpm" }] } };
  assert.equal(decideAction(state, new Map([["x86_64", { version: "0.27.0", sha256: "a".repeat(64) }]])), "noop");
  assert.throws(() => decideAction(state, new Map([["x86_64", { version: "0.26.0", sha256: "a".repeat(64) }]])), (e) => e.exitCode === EXIT.version && /older than published/.test(e.message));
  assert.throws(() => decideAction(state, new Map([["x86_64", { version: "0.27.0", sha256: "b".repeat(64) }]])), (e) => e.exitCode === EXIT.version && /different content/.test(e.message));

  const next = nextArchitectures(state, new Map([["aarch64", { version: "0.28.0", sha256: "c".repeat(64), file: "sql-pipe-0.28.0-1.aarch64.rpm" }]]));
  assert.equal(next.aarch64[0].version, "0.28.0");
  assert.equal(next.x86_64[0].version, "0.27.0", "an architecture without a candidate is carried forward");
});

function makeKey(home) {
  process.env.GNUPGHOME = home;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  execFileSync("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "test@invalid", "default", "default", "never"], { stdio: "ignore" });
  const colon = execFileSync("gpg", ["--with-colons", "--list-secret-keys"], { encoding: "utf8" });
  return colon.split("\n").find((line) => line.startsWith("fpr:")).split(":")[9];
}

const sumsPath = (name) => join(FIXTURES, name, "sha256sums.txt");
const hashOf = (fixture, file) => {
  const line = readFileSync(sumsPath(fixture), "utf8").split("\n").find((l) => l.trim().endsWith(`  ${file}`));
  return line.split(/\s+/)[0];
};

test(
  "publishes signed packages and metadata and carries other packages forward",
  { skip: skip() },
  async () => {
    const root = scratch();
    const oldHome = process.env.GNUPGHOME;
    try {
      const keyId = makeKey(join(root, "gnupg"));
      const base = { gpgKeyId: keyId, baseUrl: "https://vmvarela.github.io/rpm-packages" };

      await publish({ ...base, catalog: sqlPipe, version: "0.27.0", sourceDir: join(FIXTURES, "sql-pipe"), out: join(root, "o1"), stateDir: join(root, "state") });
      assert.match(readFileSync(join(root, "o1", ".complete"), "utf8"), /^promote 0\.27\.0\n$/);
      execFileSync("rpm", ["--dbpath", join(root, "rpmdb"), "--import", join(root, "o1", "RPM-GPG-KEY-vmvarela")]);
      for (const arch of ["x86_64", "aarch64"]) {
        const file = join(root, "o1", "packages", arch, `sql-pipe-0.27.0-1.${arch}.rpm`);
        assert.ok(existsSync(file), file);
        const sig = execFileSync("rpmkeys", ["--dbpath", join(root, "rpmdb"), "--checksig", file], { encoding: "utf8" });
        assert.match(sig, /signatures OK/, `package signature in ${file}`);
        execFileSync("gpg", ["--batch", "--verify", join(root, "o1", "packages", arch, "repodata", "repomd.xml.asc"), join(root, "o1", "packages", arch, "repodata", "repomd.xml")], { stdio: "ignore" });
      }
      const state = JSON.parse(readFileSync(join(root, "o1.state", "sql-pipe", "state.json"), "utf8"));
      assert.equal(state.architectures.x86_64[0].version, "0.27.0");
      assert.equal(state.architectures.x86_64[0].sha256, hashOf("sql-pipe", "sql-pipe-0.27.0-1.x86_64.rpm"));

      await publish({ ...base, catalog: damas, version: "0.1.10", sourceDir: join(FIXTURES, "damas"), out: join(root, "o2"), stateDir: join(root, "o1.state") });
      const list = execFileSync("ls", [join(root, "o2", "packages", "x86_64")], { encoding: "utf8" });
      assert.match(list, /sql-pipe-0\.27\.0-1\.x86_64\.rpm/, "the triggered package does not drop the others");
      assert.match(list, /damas-0\.1\.10-1\.x86_64\.rpm/);
      assert.ok(existsSync(join(root, "o2.state", "sql-pipe", "state.json")), "candidate state keeps every package");
      assert.ok(existsSync(join(root, "o2.state", "damas", "state.json")));

      // Forced rebuild of the same release: a noop that still signs and writes site and candidate state.
      const forced = await publish({ ...base, catalog: damas, version: "0.1.10", sourceDir: join(FIXTURES, "damas"), out: join(root, "forced"), stateDir: join(root, "o2.state"), force: true });
      assert.equal(forced.action, "noop");
      assert.match(readFileSync(join(root, "forced", ".complete"), "utf8"), /^noop 0\.1\.10\n$/);
      assert.ok(existsSync(join(root, "forced.state", "damas", "state.json")), "forced rebuild keeps the candidate state");
      const forcedRpm = join(root, "forced", "packages", "x86_64", "damas-0.1.10-1.x86_64.rpm");
      assert.match(execFileSync("rpmkeys", ["--dbpath", join(root, "rpmdb"), "--checksig", forcedRpm], { encoding: "utf8" }), /signatures OK/);

      // Output inside the state root is refused even without --shadow: it would poison every later read.
      await expectExit(
        publish({ ...base, catalog: damas, version: "0.1.10", sourceDir: join(FIXTURES, "damas"), out: join(root, "o2.state", "tmp"), stateDir: join(root, "o2.state") }),
        EXIT.tool,
        /inside the state directory/,
      );

      // Same release again: noop, no site and no candidate state.
      const again = await publish({ ...base, catalog: damas, version: "0.1.10", sourceDir: join(FIXTURES, "damas"), out: join(root, "o3"), stateDir: join(root, "o2.state") });
      assert.equal(again.action, "noop");
      assert.equal(existsSync(join(root, "o3")), false);

      // A newer version recorded in the state refuses the older release before touching anything.
      const forged = join(root, "forged");
      mkdirSync(join(forged, "damas", "pool"), { recursive: true });
      const current = JSON.parse(readFileSync(join(root, "o2.state", "damas", "state.json"), "utf8"));
      current.architectures.x86_64[0].version = "0.2.0";
      writeFileSync(join(forged, "damas", "state.json"), JSON.stringify(current));
      await expectExit(
        publish({ ...base, catalog: damas, version: "0.1.10", sourceDir: join(FIXTURES, "damas"), out: join(root, "o4"), stateDir: forged }),
        EXIT.version,
        /older than published/,
      );
      assert.equal(existsSync(join(root, "o4")), false);
    } finally {
      process.env.GNUPGHOME = oldHome;
    }
  },
);

test(
  "refuses missing assets, wrong checksums and mismatched metadata",
  { skip: skip() },
  async () => {
    const root = scratch();
    const oldHome = process.env.GNUPGHOME;
    try {
      const keyId = makeKey(join(root, "gnupg"));
      const base = { gpgKeyId: keyId, catalog: damas, version: "0.1.10", out: join(root, "out"), stateDir: join(root, "state") };

      const missingAsset = join(root, "missing");
      mkdirSync(join(missingAsset, "damas"), { recursive: true });
      execFileSync("cp", ["-R", `${join(FIXTURES, "damas")}/.`, join(missingAsset, "damas")]);
      rmSync(join(missingAsset, "damas", "damas-0.1.10-1.aarch64.rpm"));
      await expectExit(publish({ ...base, sourceDir: join(missingAsset, "damas") }), EXIT.verify, /missing asset: damas-0\.1\.10-1\.aarch64\.rpm/);
      assert.equal(existsSync(join(root, "out")), false);

      const tampered = join(root, "tampered");
      mkdirSync(join(tampered, "damas"), { recursive: true });
      execFileSync("cp", ["-R", `${join(FIXTURES, "damas")}/.`, join(tampered, "damas")]);
      writeFileSync(join(tampered, "damas", "damas-0.1.10-1.x86_64.rpm"), Buffer.concat([readFileSync(join(tampered, "damas", "damas-0.1.10-1.x86_64.rpm")), Buffer.from("x")]));
      await expectExit(publish({ ...base, sourceDir: join(tampered, "damas") }), EXIT.verify, /sha256 mismatch/);

      const swapped = join(root, "swapped");
      mkdirSync(join(swapped, "damas"), { recursive: true });
      execFileSync("cp", ["-R", `${join(FIXTURES, "damas")}/.`, join(swapped, "damas")]);
      // Copy the x86_64 package over the aarch64 name and give it the x86_64 checksum: the hash gate passes
      // and the metadata gate is the one that refuses.
      execFileSync("cp", [join(swapped, "damas", "damas-0.1.10-1.x86_64.rpm"), join(swapped, "damas", "damas-0.1.10-1.aarch64.rpm")]);
      const x86Hash = hashOf("damas", "damas-0.1.10-1.x86_64.rpm");
      const lines = readFileSync(sumsPath("damas"), "utf8").trimEnd().split("\n");
      writeFileSync(join(swapped, "damas", "sha256sums.txt"), `${lines.map((l) => (l.trim().endsWith("damas-0.1.10-1.aarch64.rpm") ? `${x86Hash}  damas-0.1.10-1.aarch64.rpm` : l)).join("\n")}\n`);
      await expectExit(publish({ ...base, sourceDir: join(swapped, "damas") }), EXIT.verify, /metadata is damas 0\.1\.10 x86_64, expected damas 0\.1\.10 aarch64/);

      // A missing signing key is a failure, never an unsigned site.
      await expectExit(publish({ ...base, gpgKeyId: "", sourceDir: join(FIXTURES, "damas") }), EXIT.tool, /GPG_KEY_ID is required/);
    } finally {
      process.env.GNUPGHOME = oldHome;
    }
  },
);
