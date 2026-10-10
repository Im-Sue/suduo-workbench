/**
 * 这家 Agent 现在用不了：本机没装，或者还没登录（ADR-0016：登录由用户在 Agent 自己的流程里完成）。
 * 开会话时据此给出明确原因与修复入口（前置条件不满足，不是守卫）。
 */
export class AgentNotReadyError extends Error {
  constructor(
    readonly agentId: string,
    readonly agentName: string,
    readonly reason: "not_installed" | "auth_required",
    /** Agent 自己的报错（只进日志与详情，界面按 reason 说）。 */
    readonly detail: string,
  ) {
    super(`${agentName} is not ready (${reason})${detail === "" ? "" : ": " + detail}`);
    this.name = "AgentNotReadyError";
  }
}
