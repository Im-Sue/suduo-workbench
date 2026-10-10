import type { UserSummaryDto } from "./auth.js";

/**
 * 多 Agent 协作的团队共享部分（需求「多 Agent 协作机制」4.7 / 4.8 / 4.13，技术设计 2.13）：
 * 需求共享对象（交接包、评审报告、会话快照，本人确认后发布、可撤回）、项目 AI 规范（带版本）、
 * 协作记录（P2-D1：谁用哪个 Agent 在需求上做了什么类型的协作，只含元数据）。
 */

/** 需求共享对象的种类：交接包、评审报告、会话快照。 */
export const SHARED_ITEM_KINDS = ["handoff", "review", "snapshot"] as const;
export type SharedItemKind = (typeof SHARED_ITEM_KINDS)[number];

/** 单个共享对象内容（JSON 序列化后的字节数）上限：会话快照 1.5 MB（同房间任务过程），其余 256 KB。 */
export const SHARED_ITEM_MAX_BYTES: Readonly<Record<SharedItemKind, number>> = {
  handoff: 262_144,
  review: 262_144,
  snapshot: 1_572_864,
};

/** 共享对象标题上限（字符）。 */
export const SHARED_ITEM_TITLE_MAX = 200;

/**
 * 共享对象内容各字段的上限（字符 / 条数），两端共用：本机起草时按它截断（预览即所发），云端规整时超出的也截断并在
 * 回包里列出被截断的字段，不因为一条超长命令拒掉整份；只有超过总大小（SHARED_ITEM_MAX_BYTES）才报错。
 */
export const SHARED_ITEM_FIELD_LIMITS = {
  /** 交接包的 summary、评审报告的 summary、快照每轮的提问与回答。 */
  text: 20_000,
  /** 列表里的一条、评审意见的 detail / suggestion、命令。 */
  item: 4_000,
  /** 评审意见的标题、文件路径。 */
  short: 300,
  /** 交接包的各个列表、每轮的文件与命令条数。 */
  list: 200,
  findings: 50,
  rounds: 200,
} as const;

/** 交接包：跨成员接力时的结构化摘要（Agent 用 handoff_submit 起草，本人编辑确认后发布）。 */
export interface HandoffContent {
  /** 做到哪了。 */
  summary: string;
  /** 关键决定。 */
  decisions: string[];
  /** 没做完的。 */
  todo: string[];
  risks: string[];
  /** 相关分支；没有为 null。 */
  branch: string | null;
  /** 相关文件（项目内相对路径）。 */
  files: string[];
}

/** 同本机评审意见的严重程度（info = 提示，不算问题）。 */
export type ReviewFindingSeverity = "high" | "medium" | "low" | "info";

/** 评审报告：评审会话交回的结构化意见（本人确认后发布到需求）。 */
export interface ReviewReportContent {
  summary: string;
  findings: Array<{
    severity: ReviewFindingSeverity;
    file: string | null;
    line: number | null;
    title: string;
    detail: string;
    suggestion: string | null;
  }>;
  /** 被评会话用的 Agent（本机配置表 ID）。 */
  targetAgentId: string | null;
}

/** 会话快照：本人选定的若干回合，只读。 */
export interface SnapshotContent {
  rounds: Array<{
    userText: string;
    answer: string | null;
    /** 这一轮改过的文件（项目内相对路径）。 */
    files: string[];
    commands: Array<{ command: string; exitCode: number | null }>;
    /** 开始时间（毫秒时间戳）；不知道为 null。 */
    startedAt: number | null;
  }>;
}

export type SharedItemContent = HandoffContent | ReviewReportContent | SnapshotContent;

/** 共享对象的来源：哪个 Agent、哪个本机会话（不透明句柄，只有发布人自己的本机认得）。 */
export interface SharedItemSourceDto {
  agentId: string | null;
  sessionRef: string | null;
}

export interface SharedItemDto {
  id: string;
  requirementId: string;
  kind: SharedItemKind;
  title: string;
  source: SharedItemSourceDto;
  publishedBy: UserSummaryDto;
  publishedAt: string;
  /** 内容的字节数（撤回后仍保留发布时的大小）。 */
  sizeBytes: number;
  /** 撤回时间；撤回后内容从服务器删除（标题留着，好知道撤的是什么）。没撤回为 null。 */
  retractedAt: string | null;
  /** 谁撤回的（项目成员都能撤，不只发布人）。 */
  retractedBy: UserSummaryDto | null;
  /** 发布人以外读过它的人数：已被读过的内容无法收回，撤回时据此说明。 */
  readCount: number;
}

export interface SharedItemDetailDto extends SharedItemDto {
  /** 已撤回为 null。 */
  content: SharedItemContent | null;
  /** 只在发布的回包里有：超出字段上限被截断的字段（如 `content.rounds[3].commands[0].command`、`title`）。 */
  truncatedFields?: string[];
}

/** POST /v2/requirements/:id/shared-items：发布到需求（本人确认内容后）。 */
export interface PublishSharedItemRequest {
  kind: SharedItemKind;
  title: string;
  content: SharedItemContent;
  agentId?: string | null;
  sessionRef?: string | null;
}

/** GET /v2/requirements/:id/shared-items：新的在前，含已撤回的（不带内容）。 */
export interface ListSharedItemsResponse {
  items: SharedItemDto[];
}

/** 项目 AI 规范内容上限（UTF-8 字节）。 */
export const PROJECT_AI_RULES_MAX_BYTES = 32_768;

/** 项目 AI 规范的当前版本；从没写过时 version 为 0、内容为空。 */
export interface ProjectAiRulesDto {
  projectId: string;
  version: number;
  content: string;
  updatedBy: UserSummaryDto | null;
  updatedAt: string | null;
}

/**
 * PUT /v2/projects/:id/ai-rules：保存即新版本（后写入的成为新版本，不做并发拒绝，ADR-0004）；内容没变时不新增版本。
 * `baseVersion` 是编辑时看到的版本：只用来检测，回包里列出这期间别人存过的版本（谁、何时），可按版本取回内容。
 */
export interface SaveProjectAiRulesRequest {
  content: string;
  baseVersion?: number;
}

export interface SaveProjectAiRulesResponse extends ProjectAiRulesDto {
  /** `baseVersion` 之后、这次保存之前别人存过的版本（新的在前）；没带 baseVersion 或没有为空。 */
  skippedVersions: ProjectAiRulesVersionDto[];
}

export interface ProjectAiRulesVersionDto {
  version: number;
  updatedBy: UserSummaryDto;
  updatedAt: string;
  sizeBytes: number;
}

/** GET /v2/projects/:id/ai-rules/versions：新的在前（谁什么时候改过，两次修改都可见）。 */
export interface ListProjectAiRulesVersionsResponse {
  items: ProjectAiRulesVersionDto[];
}

/** GET /v2/projects/:id/ai-rules/versions/:version：某个版本的内容（被覆盖的改动能找回）。 */
export interface ProjectAiRulesVersionDetailDto extends ProjectAiRulesVersionDto {
  content: string;
}

/**
 * 协作记录的类型：开工、委派、评审、试做、交接。服务端只查格式（`AI_ACTIVITY_VALUE_PATTERN`），
 * 以后加类型不用改迁移；界面遇到不认识的按原文显示。
 */
export const AI_ACTIVITY_KINDS = ["session", "delegate", "review", "trial", "handoff"] as const;
export type AiActivityKind = (typeof AI_ACTIVITY_KINDS)[number];

/** opened：会话开出来（会话没有「结束」）；discarded：试做没采用的那版清理了。 */
export const AI_ACTIVITY_STATUSES = ["opened", "started", "completed", "failed", "cancelled", "adopted", "discarded"] as const;
export type AiActivityStatus = (typeof AI_ACTIVITY_STATUSES)[number];

/** 协作记录的类型与状态的格式。 */
export const AI_ACTIVITY_VALUE_PATTERN = "^[a-z][a-z_-]{0,15}$";

/**
 * POST /v2/requirements/:id/ai-activity：上报一条协作记录（只含元数据，不含对话与代码）。同一成员、同一类型、同一 `localRef`
 * （本机的不透明编号，比如委派编号）再报时更新状态与分支，不新增；按 `occurredAt`（本机发生时间）只认更新的，
 * 补发的旧状态不会把新状态盖回去。
 */
export interface RecordAiActivityRequest {
  localRef: string;
  agentId: string;
  /** 已知的见 AI_ACTIVITY_KINDS；服务端只查格式。 */
  kind: string;
  /** 已知的见 AI_ACTIVITY_STATUSES；服务端只查格式。 */
  status: string;
  branch?: string | null;
  /** 本机发生时间（ISO）；不给用服务器收到的时间。 */
  occurredAt?: string;
}

export interface AiActivityDto {
  id: string;
  requirementId: string;
  member: UserSummaryDto;
  agentId: string;
  kind: string;
  status: string;
  branch: string | null;
  /** 最近一次状态变化在本机发生的时间。 */
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /v2/requirements/:id/ai-activity：最近更新的在前，最多 `AI_ACTIVITY_LIST_LIMIT` 条。 */
export interface ListAiActivityResponse {
  items: AiActivityDto[];
}

export const AI_ACTIVITY_LIST_LIMIT = 100;
