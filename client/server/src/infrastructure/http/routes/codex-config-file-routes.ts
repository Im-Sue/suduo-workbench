import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../application/api-error.js";
import { openWithSystemApp } from "../../platform/system-open.js";

export interface CodexConfigFileRouteDependencies {
  codexHome?: string;
  openCodexConfigFile?(absolutePath: string): Promise<void>;
}

/** 专用且固定目标的打开端点，绝不把浏览器传入路径交给系统打开器。 */
export function registerCodexConfigFileRoutes(
  server: FastifyInstance,
  dependencies: CodexConfigFileRouteDependencies,
): void {
  const codexHome =
    dependencies.codexHome ?? process.env["CODEX_HOME"] ?? resolve(process.cwd(), ".codex");
  const configFile = resolve(codexHome, "config.toml");
  const open = dependencies.openCodexConfigFile ?? ((path: string) => openWithSystemApp(path, "open"));

  server.post("/api/v1/codex/config-file/open", async (request) => {
    const body = request.body === undefined ? {} : requireObject(request.body);
    if (body["path"] !== undefined && body["path"] !== configFile) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "只能打开当前 CODEX_HOME 的 config.toml",
      );
    }
    try {
      if (!(await stat(configFile)).isFile()) {
        throw new Error("not a file");
      }
    } catch (cause) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        "Codex 配置文件不存在，无法打开",
        undefined,
        { cause },
      );
    }
    try {
      await open(configFile);
    } catch (cause) {
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "无法用系统编辑器打开 Codex 配置文件",
        undefined,
        { cause },
      );
    }
    return { opened: true, path: configFile };
  });
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "请求体必须是 JSON object");
  }
  return value as Record<string, unknown>;
}
