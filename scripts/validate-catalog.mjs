// Validates catalog/<project>.json files (schema_version 1). Standard library only.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const APT_ARCHES = ["amd64", "arm64", "armhf", "i386"];
export const RPM_ARCHES = ["x86_64", "aarch64"];
export const APK_ARCHES = ["x86_64", "aarch64"];
// Each channel validates against its own architecture vocabulary; `apt` stays required for every catalog today.
const CHANNELS = { apt: APT_ARCHES, rpm: RPM_ARCHES, apk: APK_ARCHES };
const SIMPLE_NAME = /^[A-Za-z0-9._-]+$/;
const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function checkKeys(obj, allowed, path, errors, optional = []) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key) && !optional.includes(key)) errors.push(`${path}: unknown key "${key}"`);
  }
  for (const key of allowed) {
    if (!(key in obj)) errors.push(`${path}: missing key "${key}"`);
  }
}

export function validateCatalog(catalog) {
  const errors = [];
  if (!isPlainObject(catalog)) return ["catalog: must be an object"];
  checkKeys(catalog, ["schema_version", "project", "repo", "checksums", "channels"], "catalog", errors);
  if (catalog.schema_version !== 1) errors.push("catalog.schema_version: must be 1");
  if (typeof catalog.project !== "string" || !SIMPLE_NAME.test(catalog.project)) errors.push("catalog.project: must be a simple name");
  if (typeof catalog.repo !== "string" || !OWNER_REPO.test(catalog.repo)) errors.push("catalog.repo: must be owner/name");
  if (typeof catalog.checksums !== "string" || !SIMPLE_NAME.test(catalog.checksums)) errors.push("catalog.checksums: must be a simple file name");
  if (!isPlainObject(catalog.channels)) {
    errors.push("catalog.channels: must be an object");
    return errors;
  }
  const allowedChannels = Object.keys(CHANNELS);
  for (const name of Object.keys(catalog.channels)) {
    if (!allowedChannels.includes(name)) errors.push(`catalog.channels: unknown channel "${name}"`);
  }
  if (!("apt" in catalog.channels)) errors.push('catalog.channels: missing channel "apt"');
  for (const [name, arches] of Object.entries(CHANNELS)) {
    if (name in catalog.channels) validateChannel(catalog.channels[name], `catalog.channels.${name}`, arches, errors);
  }
  return errors;
}

function validateChannel(channel, p, archList, errors) {
  if (!isPlainObject(channel)) return errors.push(`${p}: must be an object`);
  // architectures is an optional explicit subset for this channel; absent means every architecture of the channel.
  checkKeys(channel, ["repo", "package", "assets"], p, errors, ["architectures"]);
  if (typeof channel.repo !== "string" || !OWNER_REPO.test(channel.repo)) errors.push(`${p}.repo: must be owner/name`);
  if (typeof channel.package !== "string" || !SIMPLE_NAME.test(channel.package)) errors.push(`${p}.package: must be a simple name`);
  if (!isPlainObject(channel.assets)) return errors.push(`${p}.assets: must be an object`);
  let arches = archList;
  if ("architectures" in channel) {
    const subset = channel.architectures;
    if (!Array.isArray(subset) || subset.length === 0) {
      errors.push(`${p}.architectures: must be a non-empty array`);
    } else {
      for (const arch of subset) {
        if (!archList.includes(arch)) errors.push(`${p}.architectures: unknown architecture "${arch}"`);
      }
      if (new Set(subset).size !== subset.length) errors.push(`${p}.architectures: duplicate architecture`);
      if (subset.every((arch) => archList.includes(arch))) arches = subset;
    }
  }
  for (const arch of Object.keys(channel.assets)) {
    if (!arches.includes(arch)) errors.push(`${p}.assets: unknown architecture "${arch}"`);
  }
  for (const arch of arches) {
    const template = channel.assets[arch];
    if (typeof template !== "string") {
      errors.push(`${p}.assets.${arch}: required string`);
      continue;
    }
    if (!template.includes("{version}")) errors.push(`${p}.assets.${arch}: must contain {version}`);
    if (!SIMPLE_NAME.test(template.replaceAll("{version}", "0"))) errors.push(`${p}.assets.${arch}: must be a simple file name`);
  }
}

// CLI: node scripts/validate-catalog.mjs catalog/*.json
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = false;
  for (const file of process.argv.slice(2)) {
    const errors = validateCatalog(JSON.parse(readFileSync(file, "utf8")));
    for (const e of errors) {
      console.error(`${file}: ${e}`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
