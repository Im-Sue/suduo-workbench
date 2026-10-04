export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type EventSource = string;

export interface ThreadRef {
  runtimeId: string;
  runtimeKind: "codex" | "orchestrator" | string;
  threadId: string;
}

export interface TurnRef {
  threadId: string;
  turnId: string;
}

export type KnownEventType =
  | "thread.attached"
  | "thread.started"
  | "thread.status-changed"
  | "message.submitted"
  | "message.delta"
  | "item.started"
  | "item.completed"
  | "command.output-delta"
  | "file.patch-updated"
  | "turn.started"
  | "turn.completed"
  | "turn.interrupted"
  | "turn.start-failed"
  | "approval.requested"
  | "approval.resolved"
  | "approval.orphaned"
  | "approval.delivery-failed"
  | "workspace.changed"
  | "runtime.warning"
  | "runtime.error"
  | "runtime.recovery-required"
  | "runtime.unknown"
  /** turn/plan/updated：本回合计划的完整快照（取最新即可）。 */
  | "plan.updated"
  /** item/plan/delta（Codex 标注实验性）：计划条目的流式增量，拼接结果不保证等于最终条目。 */
  | "plan.delta"
  /** item/reasoning/summaryTextDelta：推理摘要的流式增量。 */
  | "reasoning.summary-delta"
  /** item/reasoning/summaryPartAdded：推理摘要开始新的一段。 */
  | "reasoning.summary-part-added"
  /** item/reasoning/textDelta：原始推理正文增量（仅部分模型提供）。 */
  | "reasoning.text-delta"
  /** thread/tokenUsage/updated：线程累计与最近一次请求的 token 用量。 */
  | "usage.updated"
  /** item/mcpToolCall/progress：MCP 工具调用的过程进度。 */
  | "tool.progress"
  /** thread/settings/updated：线程当前生效的模型、推理强度、审批与沙箱设置。 */
  | "thread.settings-updated"
  /** model/rerouted：本回合被服务端改派到另一个模型。 */
  | "model.rerouted";

/**
 * 历史回填（`/events/backfill`）不返回的过程性事件。它们照常入账，SSE 实时与断线重放
 * 仍逐条交付；但回放历史时最终状态由对应条目的 `item.completed` 完整内容重建
 * （agentMessage.text、commandExecution 输出、reasoning.summary、plan.text、mcpToolCall 结果），
 * 逐字增量只会把历史页撑满。
 */
export const BACKFILL_OMITTED_EVENT_TYPES = [
  "message.delta",
  "command.output-delta",
  "plan.delta",
  "reasoning.summary-delta",
  "reasoning.summary-part-added",
  "reasoning.text-delta",
  "tool.progress",
] as const satisfies readonly KnownEventType[];

/**
 * 只关心最新值的快照事件：每条都是完整快照，回填时只返回请求区间内的最后一条，
 * 历史回放仍能重建出最终值。
 */
export const BACKFILL_LATEST_ONLY_EVENT_TYPES = [
  "usage.updated",
] as const satisfies readonly KnownEventType[];

/** Codex `TurnPlanStepStatus`，原样透传。 */
export type PlanStepStatus = "pending" | "inProgress" | "completed";

/** `plan.updated` 的 payload（另带原生 threadId / turnId 与 extensions.codex）。 */
export interface PlanUpdatedPayload {
  explanation: string | null;
  plan: Array<{ step: string; status: PlanStepStatus }>;
}

/** `plan.delta` 的 payload。 */
export interface PlanDeltaPayload {
  itemId: string | null;
  delta: string;
}

/** `reasoning.summary-delta` 的 payload。 */
export interface ReasoningSummaryDeltaPayload {
  itemId: string | null;
  delta: string;
  summaryIndex: number | null;
}

/** `reasoning.summary-part-added` 的 payload。 */
export interface ReasoningSummaryPartAddedPayload {
  itemId: string | null;
  summaryIndex: number | null;
}

/** `reasoning.text-delta` 的 payload。 */
export interface ReasoningTextDeltaPayload {
  itemId: string | null;
  delta: string;
  contentIndex: number | null;
}

/** Codex `TokenUsageBreakdown`。 */
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** Codex `ThreadTokenUsage`：total 为线程累计，last 为最近一次模型请求。 */
export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

/** `usage.updated` 的 payload；tokenUsage 原样透传 Codex 结构，缺失时为 null。 */
export interface UsageUpdatedPayload {
  tokenUsage: ThreadTokenUsage | null;
}

/** `tool.progress` 的 payload。 */
export interface ToolProgressPayload {
  itemId: string | null;
  message: string;
}

/**
 * SuDuo 写进账本的会话提示（`runtime.warning`，及 `runtime.recovery-required` 里断线重建那条）的种类，
 * 前端按它用看的人的语言渲染（中英双语技术设计 §4.3）：
 * - `thread-rebuilt`：会话的历史线程续不上，已自动重建线程。
 * - `unsupported-request`：Codex 发来 SuDuo 还不支持的请求，已跳过或替你拒绝；`params.method` 是请求方法名。
 * - `connection-rebuilt`：与 Codex 的连接断开并已重建（`runtime.recovery-required`）。
 * - `room-run-events-truncated`：共享 Agent 任务的执行过程太长，中间省略了 `params.omitted` 条记录。
 */
export type RuntimeNoticeCode =
  | "thread-rebuilt"
  | "unsupported-request"
  | "connection-rebuilt"
  | "room-run-events-truncated";

/**
 * 带 code 的会话提示 payload：`message` 是英文兜底，给认不出 code 的旧客户端看。
 * 旧事件没有 code（文字是当时写下的中文），前端照原文显示。
 */
export interface RuntimeNoticePayload {
  code: RuntimeNoticeCode;
  message: string;
  params?: Record<string, string | number>;
}

export interface EventEnvelope<
  TType extends string = KnownEventType,
  TPayload extends JsonValue = JsonValue,
> {
  schemaVersion: 1;
  seq: number;
  eventId: string;
  sessionId: string;
  source: EventSource;
  type: TType;
  payload: TPayload;
  threadRef: ThreadRef | null;
  turnRef: TurnRef | null;
  ts: number;
}

export interface RuntimeEvent<
  TType extends string = string,
  TPayload extends JsonValue = JsonValue,
> {
  source: EventSource;
  type: TType;
  payload: TPayload;
  threadRef: ThreadRef | null;
  turnRef: TurnRef | null;
  ts: number;
  dedupeKey?: string;
  sessionHint?: string;
}

export type RuntimeEventDraft<
  TType extends string = string,
  TPayload extends JsonValue = JsonValue,
> = RuntimeEvent<TType, TPayload>;
