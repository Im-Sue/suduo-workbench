/**
 * 多 Agent 协作（ADR-0017，技术设计 7.3）：本机调度、委派等的契约。
 */
import type { SharedItemContent, SharedItemKind } from "@suduo/cloud-contracts";

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

/**
 * 卡住提醒（多 Agent S12）：等你确认超过 10 分钟（approval），或回合在跑却 15 分钟没有动静（silent）。
 * since 是开始等的时间。只提醒，不自动停。
 */
export interface StallDto {
  reason: "approval" | "silent";
  since: number;
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
  /** 卡住提醒；没卡住为 null。 */
  stalled: StallDto | null;
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
  /** 卡住提醒（评审会话只读，实际只会是很久没动静）；没卡住为 null。 */
  stalled: StallDto | null;
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

/**
 * 并行试做（多 Agent 协作 S10，需求 4.5）一版的状态：准备中（建工作目录、跑准备命令）/ 准备失败 / 开会话失败 /
 * 排队中 / 运行中 / 做完 / 回合失败 / 已中断 / 工作目录已删除。
 */
export type TrialEntryState = "preparing" | "setup_failed" | "failed" | "queued" | "running" | "completed" | "turn_failed" | "interrupted" | "removed";

export interface TrialChangedFileDto {
  path: string;
  kind: "add" | "delete" | "update";
  /** 二进制文件为 null。 */
  additions: number | null;
  deletions: number | null;
}

/** 一版试做（比较视图的一列）。 */
export interface TrialEntryDto {
  id: string;
  agentId: string;
  agentName: string;
  /** 这一版的试做会话；还没建好或建失败为 null。 */
  sessionId: string | null;
  /** worktree 路径与分支。 */
  path: string;
  branch: string;
  state: TrialEntryState;
  /** 准备命令的输出末尾（准备失败时看它）。 */
  setupLog: string | null;
  error: string | null;
  /** 最终回答。 */
  finalMessage: string | null;
  changedFiles: TrialChangedFileDto[];
  additions: number;
  deletions: number;
  /** 测试类命令与退出码（从这一版执行过的命令里挑）。 */
  tests: Array<{ command: string; exitCode: number | null }>;
  /** 从开始到最后一轮结束的时长；还没开始为 null。 */
  durationMs: number | null;
  /** 删除工作目录时分支也删了（采用为保留分支的那一版只删工作目录）。 */
  branchRemoved: boolean;
  /** 这一版的会话里等你确认的操作数。 */
  pendingApprovals: number;
  /** 这一版的目录还在被用：还在准备，或这一版的会话 / 从它开的评审、接着做有回合在排队或运行（清理不动它）。 */
  busy: boolean;
  /** 这一版的采用方式与结果；没采用为 null。 */
  adoptMode: "merge" | "keep-branch" | null;
  adoptResult: TrialAdoptResultDto | null;
  /** 清理这一版会做什么（确认对话框照它列出）；没有可清理的为 null。 */
  cleanup: TrialCleanupPlanDto | null;
}

/**
 * 清理一版会做什么：删不删工作目录；分支 delete-merged = `git branch -d`（提交都已在当前分支里）、
 * delete-unmerged = `-D`（没合并的提交会丢；只有确认对话框写明了、用户勾上了才执行）、keep = 保留（采用为保留分支）、
 * none = 没有分支可删（分支不是这一版建的——同名分支可能是别人的——或已经不在）。
 */
export interface TrialCleanupPlanDto {
  worktree: boolean;
  branch: "delete-merged" | "delete-unmerged" | "keep" | "none";
  /** 上次 `git branch -d` 被拒时 git 的原话（这次按没合并处理）。 */
  gitSaid: string | null;
}

/** 采用的结果：合并成功 / 有冲突（停在冲突状态由人处理）/ git 拒绝合并 / 保留分支。 */
export type TrialAdoptResultDto =
  | { kind: "merged"; commit: string }
  | { kind: "conflict"; files: string[]; message: string }
  | { kind: "refused"; message: string }
  | { kind: "kept"; branch: string };

export interface TrialDto {
  id: string;
  projectId: string;
  remoteProjectId: string | null;
  remoteRequirementId: string | null;
  /** 「REQ-12 标题」；项目会话发起为 null。 */
  requirementLabel: string | null;
  task: string;
  /** 各版都基于这次提交。 */
  baseCommit: string;
  baseBranch: string | null;
  setupCommand: string | null;
  status: "active" | "adopted" | "closed";
  /** 最近一次采用的版本与它的方式、结果（结果横幅用；各版自己的在 entries 里）。 */
  adoptedEntryId: string | null;
  adoptMode: "merge" | "keep-branch" | null;
  adoptResult: TrialAdoptResultDto | null;
  entries: TrialEntryDto[];
  createdAt: number;
  updatedAt: number;
}

/** 发起前 / 采用前看一眼：是不是 git 仓库、有没有未提交的改动（试做版本基于最近一次提交，不含它们）、记下的准备命令。 */
export interface TrialPrecheckDto {
  isGitRepo: boolean;
  dirty: boolean;
  head: string | null;
  branch: string | null;
  setupCommand: string | null;
  localProjectId: string;
}

export type TrialTarget = { remoteRequirementId: string } | { remoteProjectId: string };

/** POST /api/v1/trials：同一任务交给两三家 Agent 各做一版。 */
export interface StartTrialRequest {
  target: TrialTarget;
  agents: Array<{ agentId: string; approvalMode?: "ask" | "auto" | "full"; model?: string; reasoningEffort?: string }>;
  task: string;
  /** 工作目录准备命令（如 pnpm install）；给了就按项目记住，空字符串表示不跑。不给用记下的。 */
  setupCommand?: string | null;
}

/** POST /api/v1/trials/:id/adopt：采用一版——合并到原分支，或保留分支稍后提 PR。 */
export interface AdoptTrialRequest {
  entryId: string;
  mode: "merge" | "keep-branch";
}

/** POST /api/v1/trials/:id/cleanup：删除这几版的工作目录与分支（界面先列出路径与分支请用户确认，R11）。 */
export interface CleanupTrialRequest {
  entryIds: string[];
  /**
   * 用户在确认对话框里看到「分支有没合并的提交，会丢」并勾上的版本：只有它们的分支会用 `-D` 删。
   * 执行时分支的状态变成要 `-D`、但不在这里的，分支留着并说明（再确认一次）。
   */
  forceBranches?: string[];
}

/** GET /api/v1/trials/:id/repo：试做所在的原工作目录现在的状态（采用前看：合并到哪个分支、有没有未提交的改动）。 */
export interface TrialRepoStateDto {
  isGitRepo: boolean;
  branch: string | null;
  dirty: boolean;
}

/**
 * 共享对象草稿（多 Agent 协作 S11，需求 4.7 / 4.13）：交接包（Agent 用 handoff_submit 起草）、评审报告（从评审卡生成）、
 * 会话快照（选定若干回合）。本人编辑、预览后发布到需求；发布前本机扫一遍疑似密钥，标出位置，由人决定（不拦截）。
 */
export type SharedDraftStatus = "draft" | "published" | "discarded";

/** 疑似密钥：在哪个字段（如 `summary`、`todo[1]`、`rounds[2].answer`）、像什么、遮住中间的片段。 */
export interface SecretHitDto {
  field: string;
  kind: string;
  excerpt: string;
}

export interface SharedDraftDto {
  id: string;
  kind: SharedItemKind;
  /** 起草它的会话（会话删了为 null）。 */
  sessionId: string | null;
  /** 从哪次评审生成（评审报告）。 */
  reviewId: string | null;
  remoteRequirementId: string;
  agentId: string | null;
  title: string;
  content: SharedItemContent;
  status: SharedDraftStatus;
  /** 发布到需求后云端的编号。 */
  publishedItemId: string | null;
  secretHits: SecretHitDto[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 时间线上的草稿卡（`shared_draft.updated` 的载荷）：只带卡片要的字段，全文由发布对话框按编号去取（不把几 MB 的快照
 * 一遍遍写进账本）。
 */
export interface SharedDraftSummaryDto {
  id: string;
  kind: SharedItemKind;
  sessionId: string | null;
  title: string;
  status: SharedDraftStatus;
  publishedItemId: string | null;
  secretHitCount: number;
  updatedAt: number;
}

/**
 * PUT /api/v1/shared-drafts/:id：改标题与内容；回包重新扫过疑似密钥。`expectedUpdatedAt` 是打开对话框时看到的版本：
 * 期间 Agent 又交了一版时回 409 并带上最新的，由人决定载入它还是用自己的覆盖（不带就直接覆盖）。
 */
export interface UpdateSharedDraftRequest {
  title?: string;
  content?: SharedItemContent;
  expectedUpdatedAt?: number;
}

/**
 * POST /api/v1/shared-drafts/:id/publish：`expectedUpdatedAt` 是用户预览时的版本。发布到团队是不可逆的对外副作用
 * （ADR-0004 红线），预览之后内容变了就不发，回 409 带上最新的请人再看一遍。
 */
export interface PublishSharedDraftRequest {
  expectedUpdatedAt?: number;
}

/**
 * GET /api/v1/sessions/:id/ai-rules：会话开工 / 重建线程时注入的项目 AI 规范版本（used，没注入为 null）与项目当前版本
 * （current，没写过或读不到为 null）。current 比 used 新时界面提示，可以一键应用（多 Agent 协作 S11）。
 */
export interface SessionAiRulesDto {
  used: number | null;
  /** 项目当前的版本；带上内容，应用前给用户看（第二轮复核：不把没看过的规范发给 Agent）。 */
  current: { version: number; content: string; updatedBy: string | null; updatedAt: string | null } | null;
}

/** POST /api/v1/sessions/:id/ai-rules/apply：发用户看过的那一版（期间又有新版本时，提示照旧留着）。 */
export interface ApplySessionAiRulesRequest {
  version: number;
}

/** GET /api/v1/sessions/:id/rounds：会话快照选回合用的摘要（序号与快照一致）。 */
export interface SessionRoundSummaryDto {
  index: number;
  /** 提问的开头。 */
  userText: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: number;
}

/** POST /api/v1/sessions/:id/snapshot：选这些回合（从 1 开始的回合序号）生成会话快照草稿。 */
export interface CreateSnapshotDraftRequest {
  rounds: number[];
}
