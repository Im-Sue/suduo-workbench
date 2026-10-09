/**
 * 多 Agent 协作（ADR-0017，技术设计 7.3）：本机调度、委派等的契约。
 */

/** 回合从哪来：主会话的用户消息、委派、房间任务、评审、试做。 */
export type SchedulerSource = "user" | "delegate" | "room" | "review" | "trial";

/** 运行面板上的一项（本机运行中或排队中的回合）。 */
export interface SchedulerItemDto {
  id: string;
  sessionId: string;
  sessionTitle: string;
  agentId: string;
  agentName: string;
  source: SchedulerSource;
  /** 会话标题、委派任务等说明。 */
  label: string;
  state: "running" | "queued";
  /** 排队中的位置（第 1 位 = 下一个）；运行中为 null。 */
  position: number | null;
  enqueuedAt: number;
  startedAt: number | null;
}

/** GET /api/v1/scheduler：本机运行中与排队中的回合（需求 4.11「运行面板」）。 */
export interface SchedulerSnapshotDto {
  running: SchedulerItemDto[];
  queued: SchedulerItemDto[];
  limits: { global: number; perAgent: Record<string, number> };
}

/** 委派的状态（需求 4.3：排队中 / 运行中 / 已完成 / 失败 / 已取消；本机服务重启打断的为已中断）。 */
export type DelegationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** 委派交回的结果：子会话的最终回答、改动的文件与增删行数、子会话句柄（需要细节再读）。 */
export interface DelegationResultDto {
  finalMessage: string | null;
  changedFiles: Array<{ path: string; kind: "add" | "delete" | "update" }>;
  additions: number;
  deletions: number;
}

/** 一次委派（发起会话里的委派卡片、运行面板、委派工具的回包都用它）。 */
export interface DelegationDto {
  id: string;
  parentSessionId: string;
  /** 子会话；被删了为 null（委派记录与结果照留）。 */
  childSessionId: string | null;
  childTitle: string | null;
  agentId: string;
  agentName: string;
  task: string;
  origin: "agent" | "user";
  status: DelegationStatus;
  autoHandback: boolean;
  /** 结果已经交给发起会话（等待工具拿到，或交回消息已发出）。 */
  delivered: boolean;
  /** 子会话里等你确认的操作数（卡片显示「等审批」）。 */
  pendingApprovals: number;
  result: DelegationResultDto | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** POST /api/v1/sessions/:id/delegations（用户在输入框 @ Agent 委派）。 */
export interface StartDelegationRequest {
  agentId: string;
  task: string;
  autoHandback?: boolean;
}

/** 评审的关注点（需求 4.4）：正确性 / 安全 / 测试 / 是否满足需求。 */
export type ReviewFocus = "correctness" | "security" | "tests" | "requirement";
export const REVIEW_FOCUSES: readonly ReviewFocus[] = ["correctness", "security", "tests", "requirement"];

export type ReviewSeverity = "high" | "medium" | "low" | "info";
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["high", "medium", "low", "info"];

/**
 * 评审状态：排队中 / 评审中 / 已提交（拿到结构化意见）/ 没拿到结构化意见（评审 Agent 没调用提交工具就结束，
 * 显示它的最终回答，R13）/ 失败 / 已取消 / 已中断（本机服务重启）。
 */
export type ReviewStatus = "queued" | "running" | "submitted" | "unstructured" | "failed" | "cancelled" | "interrupted";

/** 一条评审意见（评审 Agent 用「提交评审意见」工具交回）。 */
export interface ReviewFindingDto {
  /** 报告内的编号（f1、f2……），交回修改时按它选。 */
  id: string;
  severity: ReviewSeverity;
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  suggestion: string | null;
}

/** 一次交叉评审（被评会话里的评审卡片 / 面板、评审工具的回包都用它，多 Agent 协作 S9）。 */
export interface ReviewDto {
  id: string;
  /** 被评审的会话。 */
  targetSessionId: string;
  /** 只读评审会话；还没建好或被删了为 null（报告照留）。 */
  reviewerSessionId: string | null;
  /** 评审会话被删了（区别于还没建好）。 */
  reviewerDeleted: boolean;
  agentId: string;
  agentName: string;
  origin: "agent" | "user";
  focus: ReviewFocus[];
  /** 发起时补充的说明（可空）。 */
  note: string | null;
  status: ReviewStatus;
  findings: ReviewFindingDto[];
  summary: string | null;
  /** 没拿到结构化意见时，评审 Agent 的最终回答原文。 */
  finalMessage: string | null;
  /** 已经交回原 Agent 修改的意见编号。 */
  appliedFindingIds: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** POST /api/v1/sessions/:id/reviews：请另一个 Agent 评审这个会话的改动。 */
export interface StartReviewRequest {
  agentId: string;
  focus?: ReviewFocus[];
  note?: string;
}

/** POST /api/v1/reviews/:id/apply：把选中的意见交给原 Agent 修改。 */
export interface ApplyReviewRequest {
  findingIds: string[];
}
