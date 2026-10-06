import type { SystemActivityResponse } from "@suduo/client-contracts";
import type { FastifyInstance } from "fastify";

export interface SystemActivityRouteDependencies {
  /** optional 保持旧 HTTP 测试工厂兼容；没有时按「没有进行中的会话」回答。 */
  systemActivity?: { runningSessions(): number };
}

/** 桌面应用退出前确认用：本次启动以来仍在进行中的会话数（含房间任务会话）。只读，不触发空闲计时之外的任何副作用。 */
export function registerSystemActivityRoutes(
  server: FastifyInstance,
  dependencies: SystemActivityRouteDependencies,
): void {
  server.get("/api/v1/system/activity", async (_request, reply) => {
    const body: SystemActivityResponse = {
      runningSessions: dependencies.systemActivity?.runningSessions() ?? 0,
    };
    return reply.header("Cache-Control", "no-store").send(body);
  });
}
