import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../application/api-error.js";
import type { LocalDirectoryService } from "../../../application/local-directory-service.js";

export interface LocalDirectoryRouteDependencies {
  /** optional 保持旧 HTTP 测试工厂兼容。 */
  localDirectories?: LocalDirectoryService;
}

/**
 * 本机目录浏览（只读）。只挂在本机服务上，与其他路由一样受 LoopbackGuard 保护：
 * 非 loopback Host 的请求在 onRequest 阶段即被拒绝。
 */
export function registerLocalDirectoryRoutes(
  server: FastifyInstance,
  dependencies: LocalDirectoryRouteDependencies,
): void {
  const service = dependencies.localDirectories;
  if (!service) {
    return;
  }

  server.get("/api/v2/local/dirs", async (request) => {
    const query = localQuery(request.query, ["path", "hidden"]);
    const hidden = query["hidden"];
    if (hidden !== undefined && hidden !== "1" && hidden !== "0") {
      throw new ApiError(400, "VALIDATION_ERROR", "hidden 仅支持 1 或 0");
    }
    const path = query["path"];
    return service.list({
      ...(path === undefined ? {} : { path }),
      hidden: hidden === "1",
    });
  });

  server.get("/api/v2/local/dirs/inspect", async (request) => {
    const query = localQuery(request.query, ["path"]);
    const path = query["path"];
    if (path === undefined) {
      throw new ApiError(400, "LOCAL_PATH_INVALID", "请输入以根目录开头的完整路径", {
        path: null,
      });
    }
    return service.inspect({ path });
  });
}

function localQuery(
  value: unknown,
  allowed: readonly string[],
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "VALIDATION_ERROR", `不支持的查询参数: ${key}`);
    }
    if (typeof item !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", `查询参数 ${key} 只能出现一次`);
    }
    result[key] = item;
  }
  return result;
}
