import type { UpdateModelProviderRequest } from "@suduo/client-contracts";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../application/api-error.js";
import type { ModelProviderService } from "../../../application/model-provider-service.js";

export interface ModelProviderRouteDependencies {
  modelProvider: ModelProviderService;
}

/** 模型设置仅暴露 Codex 官方 Config/Model 控制面，不再保留自建 /test 探测。 */
export function registerModelProviderRoutes(
  server: FastifyInstance,
  dependencies: ModelProviderRouteDependencies,
): void {
  server.get("/api/v1/settings/model-provider", async () =>
    dependencies.modelProvider.get(),
  );

  server.put("/api/v1/settings/model-provider", async (request) =>
    dependencies.modelProvider.update(
      requireObject<UpdateModelProviderRequest>(request.body),
    ),
  );

  server.get("/api/v1/codex/models", async () => {
    // 一次 model/list 分页同时给出旧字段 models（id 列表）与新增的 items（会话级参数选择器用）。
    const items = await dependencies.modelProvider.listModelOptions();
    return {
      models: items.map((item) => item.id),
      items,
    };
  });
}

function requireObject<T>(value: unknown): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "请求体必须是 JSON object");
  }
  return value as T;
}
