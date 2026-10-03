import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allAssets } from "./assets.mjs";

export const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const cacheDir = resolve(projectRoot, ".cache", "dist-win");

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function ensureAssets({ offline = false } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const results = [];
  for (const asset of allAssets()) {
    const path = resolve(cacheDir, asset.fileName);
    const partialPath = path + ".partial";
    const cached = existsSync(path) && (await sha256(path)) === asset.sha256;
    if (!cached) {
      rmSync(path, { force: true });
      if (offline) {
        throw new Error(
          `离线模式缺少或校验失败: ${asset.fileName}\n` +
            `请先执行 pnpm dist:win:fetch 填充 ${cacheDir}`,
        );
      }
      const download = spawnSync(
        "curl",
        [
          "-fL",
          "--retry",
          "5",
          "--retry-all-errors",
          "--continue-at",
          "-",
          "--output",
          partialPath,
          asset.url,
        ],
        { stdio: "inherit" },
      );
      if (download.status !== 0) {
        throw new Error(`下载失败: ${asset.fileName}`);
      }
      const actual = await sha256(partialPath);
      if (actual !== asset.sha256) {
        rmSync(partialPath, { force: true });
        throw new Error(
          `${asset.fileName} SHA256 不匹配: expected=${asset.sha256} actual=${actual}`,
        );
      }
      renameSync(partialPath, path);
    }
    results.push({
      fileName: asset.fileName,
      path,
      sha256: asset.sha256,
      cacheHit: cached,
    });
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await ensureAssets({
    offline:
      process.argv.includes("--offline") ||
      process.env["SUDUO_DIST_OFFLINE"] === "1",
  });
  process.stdout.write(
    JSON.stringify({ status: "ready", cacheDir, assets: results }, null, 2) +
      "\n",
  );
}
