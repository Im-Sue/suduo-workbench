import type { FastifyInstance } from "fastify";
import type { SchedulerService } from "../../../application/scheduler/scheduler-service.js";

export interface SchedulerRouteDependencies {
  /** 本机回合调度（多 Agent 协作 S8）；optional 保持旧 HTTP 测试工厂兼容。 */
  scheduler?: SchedulerService;
}

/** 运行面板：GET 快照；POST 先跑这个 / 取消（排队中的出队，运行中的中断）。 */
export function registerSchedulerRoutes(server: FastifyInstance, dependencies: SchedulerRouteDependencies): void {
  const scheduler = dependencies.scheduler;
  if (!scheduler) {
    return;
  }
  server.get("/api/v1/scheduler", async () => scheduler.snapshot());
  server.post<{ Params: { itemId: string } }>("/api/v1/scheduler/:itemId/promote", async (request) => scheduler.promote(request.params.itemId));
  server.post<{ Params: { itemId: string } }>("/api/v1/scheduler/:itemId/cancel", async (request) => scheduler.cancel(request.params.itemId));
}
