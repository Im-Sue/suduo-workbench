export const FAILURE_KINDS = [
  "cancelled",
  "auth_expired",
  "not_configured",
  "version_conflict",
  "stale_state",
  "validation",
  "forbidden",
  "not_found",
  "upstream_unavailable",
  "runtime_failed",
  "transport_unknown",
  "unknown",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** 全局消息可直接表达的成功或通用提示语义。 */
export const MESSAGE_FEEDBACK_KINDS = ["info", "success", "warning", "error"] as const;
export type MessageFeedbackKind = (typeof MESSAGE_FEEDBACK_KINDS)[number];

export type EmptyStateKind = "empty" | "prerequisite";

/** 供 data-feedback-kind 使用，避免各出口自行发明属性语义。 */
export type FeedbackAttributeKind = FailureKind | MessageFeedbackKind | EmptyStateKind;

export const FEEDBACK_OUTLETS = [
  "silent",
  "global",
  "field",
  "region",
  "page",
  "boundary",
] as const;

export type FeedbackOutlet = (typeof FEEDBACK_OUTLETS)[number];

/** `silent` 没有 DOM 出口，其余值可写入 data-feedback-result。 */
export type FeedbackAttributeResult = Exclude<FeedbackOutlet, "silent">;

/** 调用位置由契约层定义，域页面只选择最贴近实际呈现位置的一项。 */
export const FEEDBACK_SURFACES = [
  "action",
  "field",
  "region",
  "page",
  "boundary",
  "realtime",
] as const;

export type FeedbackSurface = (typeof FEEDBACK_SURFACES)[number];

export interface Failure {
  kind: FailureKind;
  status: number | null;
  code: string | null;
  message: string;
  details: Record<string, unknown> | null;
  cause: unknown;
}

export interface FeedbackContext {
  surface: FeedbackSurface;
  id?: string;
  retry?: () => void;
  /** 全局提示的前半句（例「未能保存」），后接失败原因。 */
  title?: string;
}

export interface FeedbackRoute {
  outlet: FeedbackOutlet;
  durationMs: number;
  politeness: "polite" | "assertive" | "off";
}
