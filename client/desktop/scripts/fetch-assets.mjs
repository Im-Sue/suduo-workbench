// Downloads the pinned assets for a desktop target into client/.cache/desktop and verifies them against the pinned
// integrity. Cached files that still verify are reused, so rebuilding is offline once the cache is warm.
//   node desktop/scripts/fetch-assets.mjs [--target darwin-arm64|darwin-x64|win32-x64] [--offline]
// Uses curl (honours HTTPS_PROXY), like the retired Windows installer did.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { targetFor } from "./assets.mjs";

export const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const cacheDir = join(clientRoot, ".cache", "desktop");

export async function verifyIntegrity(path, integrity) {
  const separator = integrity.indexOf("-");
  const algorithm = integrity.slice(0, separator);
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `${algorithm}-${hash.digest("base64")}` === integrity;
}

/** Returns local paths of the target's node, codex and betterSqlite3 archives. */
export async function ensureAssets(target, { offline = false } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const result = {};
  for (const key of ["node", "codex", "betterSqlite3"]) {
    const asset = target[key];
    const path = join(cacheDir, asset.fileName);
    if (existsSync(path) && (await verifyIntegrity(path, asset.integrity))) {
      result[key] = path;
      continue;
    }
    rmSync(path, { force: true });
    if (offline) throw new Error(`Offline build is missing ${asset.fileName} in ${cacheDir}; run without --offline once.`);
    const partial = path + ".partial";
    console.log(`Downloading ${asset.fileName}…`);
    const download = spawnSync(
      "curl",
      ["-fL", "--retry", "5", "--retry-all-errors", "--continue-at", "-", "--output", partial, asset.url],
      { stdio: "inherit" },
    );
    if (download.status !== 0) throw new Error(`Download failed: ${asset.url}`);
    if (!(await verifyIntegrity(partial, asset.integrity))) {
      rmSync(partial, { force: true });
      throw new Error(`${asset.fileName} does not match the pinned integrity ${asset.integrity}`);
    }
    renameSync(partial, path);
    result[key] = path;
  }
  return result;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, arch] = (option("--target") ?? `${process.platform}-${process.arch}`).split("-");
  const paths = await ensureAssets(targetFor(platform, arch), { offline: process.argv.includes("--offline") });
  console.log(JSON.stringify({ cacheDir, ...paths }, null, 2));
}
