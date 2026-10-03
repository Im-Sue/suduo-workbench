import type { FastifyInstance } from "fastify";
import type { RequirementsV2Service } from "../../../application/requirements-v2-service.js";

export interface RequirementsSettingsRouteDependencies {
  requirementsV2?: RequirementsV2Service;
}

/** 未保存地址的公开健康检查；实际保存仍由既有 PUT 路由负责。 */
export function registerRequirementsSettingsRoutes(
  server: FastifyInstance,
  dependencies: RequirementsSettingsRouteDependencies,
): void {
  const service = dependencies.requirementsV2;
  if (!service) {
    return;
  }
  server.post("/api/v2/requirements/settings/test", async (request) =>
    service.testSettings(request.body as { baseUrl?: unknown }),
  );
}
