import {
  REQUIREMENTS_V2_ROOM_SCHEMAS,
  type AgentHeartbeatRequest,
  type CreateAgentShareRequestRequest,
  type OpenAgentShareRequest,
  type RegisterAgentRequest,
  type ResolveAgentShareRequestRequest,
} from "@suduo/cloud-contracts";
import type { FastifyInstance } from "fastify";
import type { RoomsModule } from "../../application/rooms/module.js";
import { actorId, emit, idSchema } from "../http-helpers.js";

const SCHEMAS = REQUIREMENTS_V2_ROOM_SCHEMAS;

/** Agent 登记 / 心跳、房间共享、申请共享（模块「Agent」）。授权不符一律 404。 */
export function registerAgentRoutes(server: FastifyInstance, module: RoomsModule): void {
  const { realtime } = module;

  server.get("/v2/agents", async () => module.agents.list());

  // 登记：同一所有者 + 设备重复登记返回同一个 Agent（新登记 201，合并 200）。
  server.post<{ Body: RegisterAgentRequest }>(
    "/v2/agents",
    { schema: { body: SCHEMAS.registerAgent } },
    async (request, reply) => {
      const result = emit(realtime, await module.agents.register(actorId(request), request.body));
      return reply.code(result.created ? 201 : 200).send(result.agent);
    },
  );

  server.post<{ Params: { agentId: string }; Body: AgentHeartbeatRequest }>(
    "/v2/agents/:agentId/heartbeat",
    { schema: { params: idSchema("agentId"), body: SCHEMAS.agentHeartbeat } },
    async (request) =>
      emit(realtime, await module.agents.heartbeat(actorId(request), request.params.agentId, request.body)),
  );

  server.get<{ Params: { roomId: string } }>(
    "/v2/rooms/:roomId/shares",
    { schema: { params: idSchema("roomId") } },
    async (request) => module.shares.list(request.params.roomId),
  );

  // 开启共享：已开着的再开 = 改时长，返回同一条。
  server.post<{ Params: { roomId: string }; Body: OpenAgentShareRequest }>(
    "/v2/rooms/:roomId/shares",
    { schema: { params: idSchema("roomId"), body: SCHEMAS.openAgentShare } },
    async (request) =>
      emit(realtime, await module.shares.open(actorId(request), request.params.roomId, request.body)),
  );

  server.post<{ Params: { shareId: string } }>(
    "/v2/agent-shares/:shareId/close",
    { schema: { params: idSchema("shareId") } },
    async (request) => emit(realtime, await module.shares.close(actorId(request), request.params.shareId)),
  );

  server.get<{ Params: { roomId: string } }>(
    "/v2/rooms/:roomId/share-requests",
    { schema: { params: idSchema("roomId") } },
    async (request) => module.shares.listRequests(request.params.roomId),
  );

  // 申请共享：重复申请合并为同一条待处理（新申请 201，合并 200）。
  server.post<{ Params: { roomId: string }; Body: CreateAgentShareRequestRequest }>(
    "/v2/rooms/:roomId/share-requests",
    { schema: { params: idSchema("roomId"), body: SCHEMAS.createAgentShareRequest } },
    async (request, reply) => {
      const result = emit(
        realtime,
        await module.shares.createRequest(actorId(request), request.params.roomId, request.body),
      );
      return reply.code(result.created ? 201 : 200).send(result.request);
    },
  );

  server.post<{ Params: { requestId: string }; Body: ResolveAgentShareRequestRequest }>(
    "/v2/share-requests/:requestId/resolve",
    { schema: { params: idSchema("requestId"), body: SCHEMAS.resolveAgentShareRequest } },
    async (request) =>
      emit(realtime, await module.shares.resolveRequest(actorId(request), request.params.requestId, request.body)),
  );
}
