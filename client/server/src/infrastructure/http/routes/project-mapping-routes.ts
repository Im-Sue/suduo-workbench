import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../application/api-error.js";
import type { RequirementsV2Service } from "../../../application/requirements-v2-service.js";

export interface ProjectMappingRouteDependencies {
  requirementsV2?: RequirementsV2Service;
}

/** 仅把既有映射列表抽到 routes/；verify=1 是零副作用的目录状态复验。 */
export function registerProjectMappingRoutes(
  server: FastifyInstance,
  dependencies: ProjectMappingRouteDependencies,
): void {
  const service = dependencies.requirementsV2;
  if (!service) {
    return;
  }
  server.get<{ Querystring: { verify?: string | string[] } }>(
    "/api/v2/project-mappings",
    async (request) => {
      const query = request.query;
      if (Object.keys(query).some((key) => key !== "verify")) {
        throw new ApiError(400, "VALIDATION_ERROR", "不支持的 V2 查询参数");
      }
      if (query.verify === undefined) {
        return { items: await service.listMappings() };
      }
      if (query.verify !== "1") {
        throw new ApiError(400, "VALIDATION_ERROR", "verify 仅支持值 1");
      }
      return { items: await service.listMappings({ verify: true }) };
    },
  );
}
