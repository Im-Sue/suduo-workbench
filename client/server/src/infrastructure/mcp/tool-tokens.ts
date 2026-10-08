import { createHash, randomBytes } from "node:crypto";

/**
 * 令牌授予的东西：哪个会话、这个线程挂了哪些 SuDuo 工具（内部名）。工具清单在建线程时定下
 * （与 dynamicTools 一样），不在 tools/list 时现查——Agent 建线程时就会来取清单，那时会话的
 * 需求关联还没写入（S2 端到端实测）。
 */
export interface ToolGrant {
  sessionId: string;
  toolNames: readonly string[];
  /** 给这个 Agent 配的工具超时（秒）：写工具据此在超时前转草稿。 */
  toolTimeoutSec: number;
}

/**
 * SuDuo 本机 MCP 工具服务的会话令牌（ADR-0015）：令牌即身份，映射到一个会话与它的工具清单。
 * 只在内存里、只存哈希：本机服务重启时 Agent 进程跟着重启，线程续接时会重签并重新注入，
 * 所以不需要落库。每个会话同一时刻只有一个有效令牌，重签即作废旧的。
 */
export class ToolTokenRegistry {
  private readonly byHash = new Map<string, ToolGrant>();
  private readonly bySession = new Map<string, string>();

  /** 给会话签一个新令牌，作废它之前的令牌；返回令牌原文（只交给 Agent，不落盘）。 */
  issue(sessionId: string, toolNames: readonly string[], toolTimeoutSec: number): string {
    this.revoke(sessionId);
    const token = randomBytes(32).toString("base64url");
    const hash = hashToken(token);
    this.byHash.set(hash, { sessionId, toolNames: [...toolNames], toolTimeoutSec });
    this.bySession.set(sessionId, hash);
    return token;
  }

  /** 令牌授予的会话与工具；无效或已作废返回 null。 */
  resolve(token: string): ToolGrant | null {
    return this.byHash.get(hashToken(token)) ?? null;
  }

  revoke(sessionId: string): void {
    const hash = this.bySession.get(sessionId);
    if (hash !== undefined) {
      this.byHash.delete(hash);
      this.bySession.delete(sessionId);
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
