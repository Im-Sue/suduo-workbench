import type { FastifyInstance } from "fastify";
import type { TrialDto, TrialPrecheckDto, TrialRepoStateDto, TrialTarget } from "@suduo/client-contracts";
import type { TrialService } from "../../../application/collab/trial-service.js";
import { ApiError } from "../../../application/api-error.js";

export interface TrialsRouteDependencies {
  /** 并行试做（多 Agent 协作 S10）；optional 保持旧 HTTP 测试工厂兼容。 */
  trials?: TrialService;
}

/**
 * 并行试做（需求 4.5）：发起前检查（是不是 git 仓库、有没有未提交改动、记下的准备命令）、发起、比较、
 * 采用（合并或保留分支）、确认后清理（R11，界面先列出要删的路径与分支）。
 */
export function registerTrialsRoutes(server: FastifyInstance, dependencies: TrialsRouteDependencies): void {
  const trials = dependencies.trials;
  if (!trials) {
    return;
  }
  server.get<{ Querystring: { remoteRequirementId?: string; remoteProjectId?: string } }>(
    "/api/v1/trials/precheck",
    async (request): Promise<TrialPrecheckDto> => trials.precheck(targetOf(request.query)),
  );
  server.post<{ Body: Record<string, unknown> }>("/api/v1/trials", async (request, reply): Promise<TrialDto> => {
    const body = request.body ?? {};
    const target = targetOf(body["target"] as Record<string, unknown> | undefined);
    const trial = await trials.start(
      {
        target,
        agents: Array.isArray(body["agents"]) ? (body["agents"] as never) : [],
        task: typeof body["task"] === "string" ? body["task"] : "",
        ...(typeof body["setupCommand"] === "string" ? { setupCommand: body["setupCommand"] } : {}),
      },
      request.locale,
    );
    return reply.code(201).send(trial);
  });
  server.get<{ Params: { trialId: string } }>("/api/v1/trials/:trialId", async (request) => trials.get(request.params.trialId));
  server.get<{ Params: { trialId: string } }>("/api/v1/trials/:trialId/repo", async (request): Promise<TrialRepoStateDto> => trials.repoState(request.params.trialId));
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/trial", async (request) => ({ trialId: trials.bySession(request.params.sessionId) }));
  server.post<{ Params: { trialId: string }; Body: { entryId?: unknown; mode?: unknown } }>("/api/v1/trials/:trialId/adopt", async (request) => {
    const entryId = request.body?.entryId;
    const mode = request.body?.mode;
    if (typeof entryId !== "string" || (mode !== "merge" && mode !== "keep-branch")) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.trialAdoptInvalid);
    }
    return trials.adopt(request.params.trialId, entryId, mode, request.locale);
  });
  server.post<{ Params: { trialId: string }; Body: { entryIds?: unknown; forceBranches?: unknown } }>("/api/v1/trials/:trialId/cleanup", async (request) => {
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
    const entryIds = strings(request.body?.entryIds);
    if (entryIds.length === 0) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.trialCleanupEmpty);
    return trials.cleanup(request.params.trialId, entryIds, request.locale, strings(request.body?.forceBranches));
  });
}

function targetOf(value: Record<string, unknown> | undefined): TrialTarget {
  if (typeof value?.["remoteRequirementId"] === "string" && value["remoteRequirementId"] !== "") return { remoteRequirementId: value["remoteRequirementId"] };
  if (typeof value?.["remoteProjectId"] === "string" && value["remoteProjectId"] !== "") return { remoteProjectId: value["remoteProjectId"] };
  throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.trialTargetMissing);
}
