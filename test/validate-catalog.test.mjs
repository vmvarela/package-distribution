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
