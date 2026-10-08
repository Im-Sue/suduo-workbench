/**
 * 房间相关、只在本机服务与浏览器之间的契约（远程需求服务不返回它们）。
 */
import type { AgentDto, AgentRunSummaryDto } from "@suduo/cloud-contracts";

/**
 * 本机服务的上游推送连接断过又连上后，发给浏览器的事件名（无数据）：
 * 浏览器对打开着的房间按 `after=<本地最大序号>` 补拉，并刷新房间列表。
 */
export const ROOM_RESYNC_SSE_EVENT_NAME = "room-resync";

/** `GET /api/v2/agents/self`：本机 Agent 的登记状态（本机服务专有，不经远程转发）。 */
export interface LocalAgentStateDto {
  /** ready = 已登记且在发心跳；unregistered = 还没登记（未登录或本机没开）；unavailable = 登记 / 心跳失败。 */
  status: "ready" | "unregistered" | "unavailable";
  /** Codex（默认登记的那个）。 */
  agent: AgentDto | null;
  /**
   * 本机登记了的全部 Agent（Codex 加上共享过的其他家，多 Agent S6）；旧本机服务不返回。
   * 每家各是一个可 @ 的 Agent。
   */
  agents?: AgentDto[];
  /** 不是 ready 时给用户看的原因。 */
  message: string | null;
  /** 本机正在为房间执行的任务（所有者视角）。 */
  activeRun: AgentRunSummaryDto | null;
  queuedRuns: number;
}
