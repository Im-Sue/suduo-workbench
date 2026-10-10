import type { FastifyInstance } from "fastify";
import type { SharedDraftDto } from "@suduo/client-contracts";
import type {
  AiActivityDto,
  ListAiActivityResponse,
  ListProjectAiRulesVersionsResponse,
  ListSharedItemsResponse,
  ProjectAiRulesDto,
  ProjectAiRulesVersionDetailDto,
  RecordAiActivityRequest,
  SaveProjectAiRulesResponse,
  SharedItemDetailDto,
} from "@suduo/cloud-contracts";
import type { SharedDraftService } from "../../../application/collab/shared-draft-service.js";
import type { ProjectRulesService } from "../../../application/collab/project-rules-service.js";
import type { AiActivityReporter } from "../../../application/collab/ai-activity-reporter.js";
import { ApiError } from "../../../application/api-error.js";

/** 草稿内容（会话快照最大 1.5 MB）留够余量。 */
const DRAFT_BODY_LIMIT = 4 * 1024 * 1024;

export interface SharedDraftsRouteDependencies {
  /** 共享对象草稿（多 Agent 协作 S11）；optional 保持旧 HTTP 测试工厂兼容。 */
  sharedDrafts?: SharedDraftService;
  /** 会话用的项目 AI 规范版本与一键应用新版本（S11）。 */
  sessionAiRules?: ProjectRulesService;
  /** 协作记录上报的单会话开关（S11，P2-D1）。 */
  aiActivity?: AiActivityReporter;
  /** 团队服务器上的共享对象、项目 AI 规范、协作记录（代理云端 ai_collab_v1）。 */
  aiCollabRemote?: {
    listSharedItems(requirementId: string): Promise<ListSharedItemsResponse>;
    getSharedItem(itemId: string): Promise<SharedItemDetailDto>;
    retractSharedItem(itemId: string): Promise<SharedItemDetailDto>;
    getProjectAiRules(projectId: string): Promise<ProjectAiRulesDto>;
    listProjectAiRulesVersions(projectId: string): Promise<ListProjectAiRulesVersionsResponse>;
    getProjectAiRulesVersion(projectId: string, version: number): Promise<ProjectAiRulesVersionDetailDto>;
    saveProjectAiRules(projectId: string, content: string, baseVersion?: number): Promise<SaveProjectAiRulesResponse>;
    recordAiActivity(requirementId: string, input: RecordAiActivityRequest): Promise<AiActivityDto>;
    listAiActivity(requirementId: string): Promise<ListAiActivityResponse>;
  };
}

/**
 * 共享对象（需求 4.7 / 4.13）：本机草稿的生成、编辑、丢弃、发布到需求（发布前对话框里预览与疑似密钥提示，由人决定）；
 * 团队服务器上的共享对象、项目 AI 规范、协作记录经本机代理。
 */
export function registerSharedDraftsRoutes(server: FastifyInstance, dependencies: SharedDraftsRouteDependencies): void {
  const drafts = dependencies.sharedDrafts;
  if (drafts) {
    server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/shared-drafts", async (request) => ({
      items: drafts.listBySession(request.params.sessionId),
    }));
    server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/rounds", async (request) => ({ items: drafts.roundSummaries(request.params.sessionId) }));
    server.post<{ Params: { sessionId: string }; Body: { rounds?: unknown } }>("/api/v1/sessions/:sessionId/snapshot", async (request, reply) => {
      const rounds = Array.isArray(request.body?.rounds) ? request.body.rounds.filter((value): value is number => Number.isSafeInteger(value) && value >= 1) : [];
      const draft = drafts.createSnapshot(request.params.sessionId, rounds, request.locale);
      return reply.code(201).send(draft);
    });
    server.post<{ Params: { reviewId: string } }>("/api/v1/reviews/:reviewId/draft", async (request, reply) =>
      reply.code(201).send(drafts.createReviewDraft(request.params.reviewId, request.locale)),
    );
    server.get<{ Params: { draftId: string } }>("/api/v1/shared-drafts/:draftId", async (request): Promise<SharedDraftDto> => drafts.get(request.params.draftId));
    server.put<{ Params: { draftId: string }; Body: { title?: unknown; content?: unknown; expectedUpdatedAt?: unknown } }>(
      "/api/v1/shared-drafts/:draftId",
      { bodyLimit: DRAFT_BODY_LIMIT },
      async (request): Promise<SharedDraftDto> => {
        const body = request.body ?? {};
        return drafts.update(
          request.params.draftId,
          {
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.content === undefined ? {} : { content: body.content }),
          },
          stamp(body.expectedUpdatedAt),
        );
      },
    );
    server.post<{ Params: { draftId: string }; Body: { expectedUpdatedAt?: unknown } }>(
      "/api/v1/shared-drafts/:draftId/publish",
      async (request): Promise<SharedDraftDto> => drafts.publish(request.params.draftId, stamp(request.body?.expectedUpdatedAt)),
    );
    // 手写交接包（R13：Agent 没有 handoff_submit 时的退路）。
    server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/handoff", async (request, reply) =>
      reply.code(201).send(drafts.createManualHandoff(request.params.sessionId, request.locale)),
    );
    server.post<{ Params: { draftId: string } }>("/api/v1/shared-drafts/:draftId/discard", async (request): Promise<SharedDraftDto> => drafts.discard(request.params.draftId));
  }

  const rules = dependencies.sessionAiRules;
  if (rules) {
    server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/ai-rules", async (request) => rules.status(request.params.sessionId));
    server.post<{ Params: { sessionId: string }; Body: { version?: unknown } }>("/api/v1/sessions/:sessionId/ai-rules/apply", async (request) => {
      const version = request.body?.version;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.rulesVersionInvalid);
      }
      return rules.apply(request.params.sessionId, version, request.locale);
    });
  }

  const activity = dependencies.aiActivity;
  if (activity) {
    server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/ai-activity-reporting", async (request) => ({
      enabled: activity.isReporting(request.params.sessionId),
    }));
    server.put<{ Params: { sessionId: string }; Body: { enabled?: unknown } }>("/api/v1/sessions/:sessionId/ai-activity-reporting", async (request) => {
      if (typeof request.body?.enabled !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.reportingInvalid);
      activity.setReporting(request.params.sessionId, request.body.enabled);
      return { enabled: activity.isReporting(request.params.sessionId) };
    });
  }

  const remote = dependencies.aiCollabRemote;
  if (!remote) return;
  server.get<{ Params: { requirementId: string } }>("/api/v2/requirements/:requirementId/shared-items", async (request) =>
    remote.listSharedItems(request.params.requirementId),
  );
  server.get<{ Params: { itemId: string } }>("/api/v2/shared-items/:itemId", async (request) => remote.getSharedItem(request.params.itemId));
  server.post<{ Params: { itemId: string } }>("/api/v2/shared-items/:itemId/retract", async (request) => remote.retractSharedItem(request.params.itemId));
  server.get<{ Params: { requirementId: string } }>("/api/v2/requirements/:requirementId/ai-activity", async (request) =>
    remote.listAiActivity(request.params.requirementId),
  );
  server.get<{ Params: { projectId: string } }>("/api/v2/projects/:projectId/ai-rules", async (request) => remote.getProjectAiRules(request.params.projectId));
  server.get<{ Params: { projectId: string } }>("/api/v2/projects/:projectId/ai-rules/versions", async (request) =>
    remote.listProjectAiRulesVersions(request.params.projectId),
  );
  server.get<{ Params: { projectId: string; version: string } }>("/api/v2/projects/:projectId/ai-rules/versions/:version", async (request) => {
    const version = Number(request.params.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.rulesVersionInvalid);
    return remote.getProjectAiRulesVersion(request.params.projectId, version);
  });
  server.put<{ Params: { projectId: string }; Body: { content?: unknown; baseVersion?: unknown } }>("/api/v2/projects/:projectId/ai-rules", async (request) => {
    const content = request.body?.content;
    if (typeof content !== "string") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.rulesContentMissing);
    const baseVersion = request.body?.baseVersion;
    return remote.saveProjectAiRules(request.params.projectId, content, Number.isSafeInteger(baseVersion) && (baseVersion as number) >= 0 ? (baseVersion as number) : undefined);
  });
}

function stamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}
