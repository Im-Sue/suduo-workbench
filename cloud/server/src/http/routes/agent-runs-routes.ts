import {
  REQUIREMENTS_V2_ROOM_SCHEMAS,
  type AgentRunProgressRequest,
  type CompleteAgentRunRequest,
  type FinishAgentRunRequest,
  type ListAgentRunsQuery,
} from "@suduo/cloud-contracts";
import type { FastifyInstance } from "fastify";
import type { RoomsModule } from "../../application/rooms/module.js";
import { actorId, emit, idSchema } from "../http-helpers.js";

const SCHEMAS = REQUIREMENTS_V2_ROOM_SCHEMAS;

/** 执行过程（本机截到 1.5MB）连同回答一起回写，放宽到 8MiB。 */
const RUN_WRITE_BODY_LIMIT = 8 * 1024 * 1024;

/** Agent 任务（模块「Agent」）：接收器拉取、所有者本机回写、触发人停止 / 重试。授权不符一律 404。 */
export function registerAgentRunRoutes(server: FastifyInstance, module: RoomsModule): void {
  const { realtime } = module;
  const runParams = idSchema("runId");

  server.get<{ Querystring: ListAgentRunsQuery }>(
    "/v2/agent-runs",
    { schema: { querystring: SCHEMAS.listAgentRuns } },
    async (request) => module.runs.list(request.query),
  );

  server.get<{ Params: { runId: string } }>(
    "/v2/agent-runs/:runId",
    { schema: { params: runParams } },
    async (request) => module.runs.detail(request.params.runId),
  );

  server.post<{ Params: { runId: string } }>(
    "/v2/agent-runs/:runId/start",
    { schema: { params: runParams } },
    async (request) => emit(realtime, await module.runs.start(actorId(request), request.params.runId)),
  );

  server.post<{ Params: { runId: string }; Body: AgentRunProgressRequest }>(
    "/v2/agent-runs/:runId/progress",
    { bodyLimit: RUN_WRITE_BODY_LIMIT, schema: { params: runParams, body: SCHEMAS.agentRunProgress } },
    async (request) =>
      emit(realtime, await module.runs.progress(actorId(request), request.params.runId, request.body)),
  );

  server.post<{ Params: { runId: string }; Body: CompleteAgentRunRequest }>(
    "/v2/agent-runs/:runId/complete",
    { bodyLimit: RUN_WRITE_BODY_LIMIT, schema: { params: runParams, body: SCHEMAS.completeAgentRun } },
    async (request) =>
      emit(realtime, await module.runs.complete(actorId(request), request.params.runId, request.body)),
  );

  server.post<{ Params: { runId: string }; Body: FinishAgentRunRequest }>(
    "/v2/agent-runs/:runId/finish",
    { bodyLimit: RUN_WRITE_BODY_LIMIT, schema: { params: runParams, body: SCHEMAS.finishAgentRun } },
    async (request) =>
      emit(realtime, await module.runs.finish(actorId(request), request.params.runId, request.body)),
  );

  server.post<{ Params: { runId: string } }>(
    "/v2/agent-runs/:runId/stop",
    { schema: { params: runParams } },
    async (request) => emit(realtime, await module.runs.stop(actorId(request), request.params.runId)),
  );

  server.post<{ Params: { runId: string } }>(
    "/v2/agent-runs/:runId/retry",
    { schema: { params: runParams } },
    async (request) => emit(realtime, await module.runs.retry(actorId(request), request.params.runId)),
  );
}
