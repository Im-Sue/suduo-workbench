import type { FastifyInstance } from "fastify";
import type { CodexAccountDto, CodexLoginStartDto, CodexLoginStatusDto } from "@suduo/client-contracts";
import type { CodexAccountService } from "../../../application/codex-account-service.js";

export interface CodexAccountRouteDependencies {
  /** 用 ChatGPT 账号登录 Codex（桌面应用 D2）；optional 保持旧 HTTP 测试工厂兼容。 */
  codexAccount?: CodexAccountService;
}

/** Codex 账号：查看登录方式、用 ChatGPT 账号登录（授权在系统浏览器里完成）、取消、退出登录（技术设计 7.1）。 */
export function registerCodexAccountRoutes(server: FastifyInstance, dependencies: CodexAccountRouteDependencies): void {
  const account = dependencies.codexAccount;
  if (!account) return;
  server.get("/api/v1/codex/account", async (): Promise<CodexAccountDto> => account.account());
  server.post("/api/v1/codex/account/login", async (): Promise<CodexLoginStartDto> => account.startLogin());
  server.get<{ Params: { loginId: string } }>("/api/v1/codex/account/login/:loginId", async (request): Promise<CodexLoginStatusDto> =>
    account.status(request.params.loginId),
  );
  server.post<{ Params: { loginId: string } }>("/api/v1/codex/account/login/:loginId/cancel", async (request): Promise<CodexLoginStatusDto> =>
    account.cancel(request.params.loginId),
  );
  server.post("/api/v1/codex/account/logout", async (): Promise<CodexAccountDto> => account.logout());
}
