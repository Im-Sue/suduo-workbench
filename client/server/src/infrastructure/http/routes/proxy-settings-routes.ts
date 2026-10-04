import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../application/api-error.js";
import type { ProxyConnectivityService } from "../../../application/proxy-connectivity-service.js";

export interface ProxySettingsRouteDependencies {
  proxyConnectivity: ProxyConnectivityService;
}

/** 只使用当前或草稿代理探测模型网关；不会写入设置。 */
export function registerProxySettingsRoutes(
  server: FastifyInstance,
  dependencies: ProxySettingsRouteDependencies,
): void {
  server.post("/api/v1/settings/proxy/test", async (request) =>
    dependencies.proxyConnectivity.test(
      request.body === undefined ? {} : requireObject(request.body),
      request.locale,
    ),
  );
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.bodyMustBeObject);
  }
  return value as Record<string, unknown>;
}
