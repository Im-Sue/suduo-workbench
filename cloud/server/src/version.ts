import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 镜像构建时写在服务目录下、记录产品版本的文件名（见 server/Dockerfile）。 */
export const VERSION_FILE_NAME = "SUDUO_VERSION";

/**
 * 产品版本（与 cloud/package.json 一致，两端共用一个版本号），用于健康检查与运维脚本比对。
 * 依次取：环境变量 SUDUO_VERSION → 镜像里的 SUDUO_VERSION 文件 → 源码运行时的 cloud/package.json → "dev"。
 */
export function resolveServiceVersion(
  environment: NodeJS.ProcessEnv = process.env,
  serverRoot: string = resolve(import.meta.dirname, ".."),
): string {
  const fromEnvironment = environment["SUDUO_VERSION"]?.trim();
  if (fromEnvironment) {
    return fromEnvironment;
  }
  const fromFile = readText(resolve(serverRoot, VERSION_FILE_NAME))?.trim();
  if (fromFile) {
    return fromFile;
  }
  const workspacePackage = readText(resolve(serverRoot, "..", "package.json"));
  if (workspacePackage !== undefined) {
    try {
      const parsed = JSON.parse(workspacePackage) as { name?: unknown; version?: unknown };
      if (parsed.name === "suduo-cloud" && typeof parsed.version === "string" && parsed.version !== "") {
        return parsed.version;
      }
    } catch {
      // 不是合法 JSON：当作没有版本信息。
    }
  }
  return "dev";
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
