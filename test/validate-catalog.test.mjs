import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCatalog } from "../scripts/validate-catalog.mjs";

const valid = JSON.parse(readFileSync(new URL("../catalog/sql-pipe.json", import.meta.url), "utf8"));
const clone = () => structuredClone(valid);

test("sql-pipe catalog is valid", () => {
  assert.deepEqual(validateCatalog(valid), []);
});

test("rejects unknown top-level and channel keys", () => {
  const c = clone();
  c.extra = 1;
  c.channels.apt.extra = 1;
  assert.match(validateCatalog(c).join("\n"), /unknown key "extra"/);
});

test("requires all four apt architectures", () => {
  const c = clone();
  delete c.channels.apt.assets.i386;
  assert.match(validateCatalog(c).join("\n"), /assets\.i386: required string/);
});

test("rejects unknown architecture and path-like names", () => {
  const c = clone();
  c.channels.apt.assets.mips = "x_{version}.deb";
  c.channels.apt.assets.amd64 = "../sql-pipe_{version}.deb";
  const out = validateCatalog(c).join("\n");
  assert.match(out, /unknown architecture "mips"/);
  assert.match(out, /amd64: must be a simple file name/);
});

test("rejects wrong schema version and missing version placeholder", () => {
  const c = clone();
  c.schema_version = 2;
  c.channels.apt.assets.arm64 = "sql-pipe.deb";
  const out = validateCatalog(c).join("\n");
  assert.match(out, /schema_version: must be 1/);
  assert.match(out, /arm64: must contain \{version\}/);
});

const ghoten = JSON.parse(readFileSync(new URL("../catalog/ghoten.json", import.meta.url), "utf8"));
const cloneGhoten = () => structuredClone(ghoten);

test("ghoten catalog is valid with an explicit amd64 and arm64 subset", () => {
  assert.deepEqual(validateCatalog(ghoten), []);
  assert.deepEqual(ghoten.channels.apt.architectures, ["amd64", "arm64"]);
});

test("architecture subset must be non-empty, known and unique", () => {
  const empty = cloneGhoten();
  empty.channels.apt.architectures = [];
  assert.match(validateCatalog(empty).join("\n"), /architectures: must be a non-empty array/);

  const unknown = cloneGhoten();
  unknown.channels.apt.architectures = ["amd64", "riscv64"];
  assert.match(validateCatalog(unknown).join("\n"), /unknown architecture "riscv64"/);

  const dup = cloneGhoten();
  dup.channels.apt.architectures = ["amd64", "amd64"];
  assert.match(validateCatalog(dup).join("\n"), /duplicate architecture/);
});

test("assets must match the architecture subset exactly", () => {
  const extra = cloneGhoten();
  extra.channels.apt.assets.armhf = "ghoten_{version}_armhf.deb";
  assert.match(validateCatalog(extra).join("\n"), /assets: unknown architecture "armhf"/);

  const missing = cloneGhoten();
  delete missing.channels.apt.assets.arm64;
  assert.match(validateCatalog(missing).join("\n"), /assets\.arm64: required string/);
});

test("sql-pipe stays strict: a subset is not implied", () => {
  const c = clone();
  c.channels.apt.architectures = ["amd64"];
  assert.match(validateCatalog(c).join("\n"), /assets: unknown architecture "arm64"/);
});
