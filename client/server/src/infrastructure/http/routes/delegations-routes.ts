import type { FastifyInstance } from "fastify";
import type { DelegationDto } from "@suduo/client-contracts";
import type { DelegationService } from "../../../application/collab/delegation-service.js";
import { ApiError } from "../../../application/api-error.js";

export interface DelegationsRouteDependencies {
  /** 委派（多 Agent 协作 S8）；optional 保持旧 HTTP 测试工厂兼容。 */
  delegations?: DelegationService;
}

/**
 * 委派（需求 4.3）：用户在输入框 @ Agent 发起、发起会话里的委派卡片（停止、让原 Agent 继续、补充消息），
 * 以及停止级联（停止发起回合时一并取消它的委派）。
 */
export function registerDelegationsRoutes(server: FastifyInstance, dependencies: DelegationsRouteDependencies): void {
  const delegations = dependencies.delegations;
  if (!delegations) {
    return;
  }
  server.get<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/delegations", async (request) => ({
    items: delegations.listByParent(request.params.sessionId),
  }));
  server.post<{ Params: { sessionId: string }; Body: { agentId?: unknown; task?: unknown; autoHandback?: unknown } }>(
    "/api/v1/sessions/:sessionId/delegations",
    async (request, reply): Promise<DelegationDto> => {
      const body = request.body ?? {};
      if (typeof body.agentId !== "string" || body.agentId.trim() === "") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.delegation.reply.agentIdMissing);
      }
      if (typeof body.task !== "string" || body.task.trim() === "") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.delegation.reply.taskMissing);
      }
      const delegation = await delegations.start({
        parentSessionId: request.params.sessionId,
        agentId: body.agentId.trim(),
        task: body.task,
        autoHandback: body.autoHandback === true,
        origin: "user",
      });
      return reply.code(201).send(delegation);
    },
  );
  server.post<{ Params: { sessionId: string } }>("/api/v1/sessions/:sessionId/delegations/cancel-all", async (request) => ({
    items: await delegations.cancelAllForParent(request.params.sessionId),
  }));
  server.post<{ Params: { delegationId: string } }>("/api/v1/delegations/:delegationId/cancel", async (request) =>
    delegations.cancel(request.params.delegationId),
  );
  server.post<{ Params: { delegationId: string } }>("/api/v1/delegations/:delegationId/handback", async (request) =>
    delegations.handback(request.params.delegationId),
  );
  server.post<{ Params: { delegationId: string }; Body: { message?: unknown } }>("/api/v1/delegations/:delegationId/messages", async (request) => {
    const message = request.body?.message;
    if (typeof message !== "string" || message.trim() === "") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.delegation.reply.messageMissing);
    }
    return delegations.send(request.params.delegationId, message.trim());
  });
}
