import {
  REQUIREMENTS_V2_SCHEMAS,
  type PublishSharedItemRequest,
  type RecordAiActivityRequest,
  type SaveProjectAiRulesRequest,
} from "@suduo/cloud-contracts";
import type { FastifyInstance } from "fastify";
import type { AiCollabService } from "../../application/ai-collab-service.js";
import type { RequirementsEventHub } from "../../application/event-hub.js";
import { actorId, idSchema } from "../http-helpers.js";

/** 会话快照最大 1.5 MB（规整后的 JSON）：请求体放宽到 3 MB，超出内容上限的由服务层按大小报参数错。 */
const PUBLISH_BODY_LIMIT = 3 * 1024 * 1024;

/**
 * 多 Agent 协作的团队共享部分（需求「多 Agent 协作机制」4.7 / 4.8 / 4.13）：需求共享对象（交接包、评审报告、
 * 会话快照）的发布、列表、读取、撤回；项目 AI 规范的读取、保存与历史版本；协作记录的上报与列表。全部需登录；
 * 变化在事务提交后推 SSE（不带正文）。
 */
export function registerAiCollabRoutes(server: FastifyInstance, service: AiCollabService, events: RequirementsEventHub): void {
  server.post<{ Params: { requirementId: string }; Body: PublishSharedItemRequest }>(
    "/v2/requirements/:requirementId/shared-items",
    { bodyLimit: PUBLISH_BODY_LIMIT, schema: { params: idSchema("requirementId"), body: REQUIREMENTS_V2_SCHEMAS.publishSharedItem } },
    async (request, reply) => {
      const { item, projectId } = await service.publish(actorId(request), request.params.requirementId, request.body);
      events.publish({ type: "shared_item.changed", projectId, requirementId: item.requirementId });
      return reply.code(201).send(item);
    },
  );

  server.get<{ Params: { requirementId: string } }>(
    "/v2/requirements/:requirementId/shared-items",
    { schema: { params: idSchema("requirementId") } },
    async (request) => service.list(request.params.requirementId),
  );

  // 读一个（带内容）：读的人不是发布人时记「读过」。
  server.get<{ Params: { itemId: string } }>(
    "/v2/shared-items/:itemId",
    { schema: { params: idSchema("itemId") } },
    async (request) => service.read(request.params.itemId, actorId(request)),
  );

  server.post<{ Params: { itemId: string } }>(
    "/v2/shared-items/:itemId/retract",
    { schema: { params: idSchema("itemId") } },
    async (request) => {
      const { item, changed, projectId } = await service.retract(request.params.itemId, actorId(request));
      if (changed) events.publish({ type: "shared_item.changed", projectId, requirementId: item.requirementId });
      return item;
    },
  );

  server.get<{ Params: { projectId: string } }>(
    "/v2/projects/:projectId/ai-rules",
    { schema: { params: idSchema("projectId") } },
    async (request) => service.rules(request.params.projectId),
  );

  server.get<{ Params: { projectId: string } }>(
    "/v2/projects/:projectId/ai-rules/versions",
    { schema: { params: idSchema("projectId") } },
    async (request) => service.ruleVersions(request.params.projectId),
  );

  server.get<{ Params: { projectId: string; version: number } }>(
    "/v2/projects/:projectId/ai-rules/versions/:version",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["projectId", "version"],
          properties: { projectId: { type: "string", format: "uuid" }, version: { type: "integer", minimum: 1, maximum: 2_147_483_647 } },
        },
      },
    },
    async (request) => service.ruleVersion(request.params.projectId, request.params.version),
  );

  server.put<{ Params: { projectId: string }; Body: SaveProjectAiRulesRequest }>(
    "/v2/projects/:projectId/ai-rules",
    { schema: { params: idSchema("projectId"), body: REQUIREMENTS_V2_SCHEMAS.saveProjectAiRules } },
    async (request) => {
      const { rules, changed } = await service.saveRules(request.params.projectId, actorId(request), request.body.content, request.body.baseVersion);
      if (changed) events.publish({ type: "ai_rules.changed", projectId: request.params.projectId });
      return rules;
    },
  );

  server.post<{ Params: { requirementId: string }; Body: RecordAiActivityRequest }>(
    "/v2/requirements/:requirementId/ai-activity",
    { schema: { params: idSchema("requirementId"), body: REQUIREMENTS_V2_SCHEMAS.recordAiActivity } },
    async (request) => {
      const { activity, projectId, changed } = await service.record(actorId(request), request.params.requirementId, request.body);
      // 补发的旧状态没改动任何东西：不推。
      if (changed) events.publish({ type: "ai_activity.changed", projectId, requirementId: activity.requirementId });
      return activity;
    },
  );

  server.get<{ Params: { requirementId: string } }>(
    "/v2/requirements/:requirementId/ai-activity",
    { schema: { params: idSchema("requirementId") } },
    async (request) => service.activity(request.params.requirementId),
  );
}
