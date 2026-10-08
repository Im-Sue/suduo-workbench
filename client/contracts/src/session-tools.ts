/**
 * 会话里的 SuDuo 工具（ADR-0008）：本机服务通过 Codex 的 dynamicTools 挂到会话线程上，
 * 模型调用时由本机服务执行。这里是前后端共用的名字、展示文案与确认卡载荷。
 */

export const SUDUO_TOOL_NAMES = [
  "suduo_requirement_get",
  "suduo_requirement_comments",
  "suduo_requirement_attachments",
  "suduo_attachment_view",
  "suduo_artifact_versions",
  "suduo_artifact_fetch",
  "suduo_notes_read",
  "suduo_notes_save",
  "suduo_comment_submit",
  "suduo_artifact_publish",
] as const;

export type SuDuoToolName = (typeof SUDUO_TOOL_NAMES)[number];

export function isSuDuoToolName(value: unknown): value is SuDuoToolName {
  return typeof value === "string" && (SUDUO_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * 已撤下的工具：确认版停用（需求附件评论文件与优先级）。名字仍留在 SUDUO_TOOL_NAMES 里——
 * 旧会话的时间线要显示它们的标题；新会话不再挂它们。Codex 续接旧线程时不会重新领取工具清单，
 * 模型仍可能调用，本机服务对它们统一回复「已停用」。
 */
export const RETIRED_SUDUO_TOOL_NAMES = [
  "suduo_artifact_versions",
  "suduo_artifact_fetch",
  "suduo_artifact_publish",
] as const satisfies readonly SuDuoToolName[];

export type RetiredSuDuoToolName = (typeof RETIRED_SUDUO_TOOL_NAMES)[number];

/** 新会话实际挂的 SuDuo 工具。 */
export type ActiveSuDuoToolName = Exclude<SuDuoToolName, RetiredSuDuoToolName>;

export function isRetiredSuDuoToolName(value: string): value is RetiredSuDuoToolName {
  return (RETIRED_SUDUO_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * 品牌更名（ADR-0010）前的旧前缀。更名前建的 Codex 线程把工具清单存在线程里，续接后模型仍按旧名调用；
 * 旧会话的事件记录里也是旧名。执行与时间线都先过 currentSuDuoToolName 按新名认——唯一保留的旧品牌兼容。
 */
const LEGACY_TOOL_PREFIX = "zjwork_"; // eslint-disable-line no-restricted-syntax -- ADR-0010 唯一保留的旧名兼容

/** 旧前缀的工具名换成新名；其它原样返回。 */
export function currentSuDuoToolName(tool: string): string {
  return tool.startsWith(LEGACY_TOOL_PREFIX) ? `suduo_${tool.slice(LEGACY_TOOL_PREFIX.length)}` : tool;
}

/** 审批表里工具确认卡的原生方法名（`ApprovalDto.request.nativeMethod`）。 */
export const SUDUO_TOOL_NATIVE_METHOD = "item/tool/call";

/**
 * 对外写工具的确认卡内容（`ApprovalDto.request.suDuoTool`）。
 * 界面逐字展示，用户确认后本机服务才执行（ADR-0004「不可逆对外副作用」红线）。
 */
export interface SuDuoToolConfirmationDto {
  /** `artifact_publish` 只出现在确认版停用前的旧记录里，时间线据此显示历史；不会再新建。 */
  tool: "comment_submit" | "artifact_publish";
  requirement: {
    id: string;
    projectId: string;
    number: number | null;
    title: string | null;
  };
  comment?: { body: string };
  publish?: {
    files: Array<{
      name: string;
      sizeBytes: number | null;
      /** path = 项目里的文件，确认后先上传为附件；attachment = 需求已有附件。 */
      source: "path" | "attachment";
      /** source=path 时为项目内相对路径；source=attachment 时为附件 ID。 */
      ref: string;
    }>;
    note: string | null;
  };
  /**
   * 本会话里已发过（或还有一张待确认的）相同内容时的提示（只告知，不拒绝；ADR-0004）。
   * pending=true 表示那张卡还没决定。
   */
  duplicateOf: { at: number; pending?: boolean } | null;
}

/** `GET /api/v1/sessions/:id/context`：会话关联的 SuDuo 上下文。 */
export interface SessionContextDto {
  sessionId: string;
  /** requirement = 从需求创建；project = 项目会话（建时记下了所属项目）；none = 不属于任何项目。 */
  kind: "requirement" | "project" | "none";
  /** tools = 新版（挂 suduo_* 工具）；legacy = 旧版（快照与现状文件，已不再刷新）；none 时为 null。 */
  contextMode: "tools" | "legacy" | null;
  remoteProjectId: string | null;
  requirement: {
    remoteRequirementId: string;
    number: number | null;
    title: string | null;
    /** 开工时的需求版本。 */
    startVersion: number;
    /** 开工时刻（毫秒）。 */
    startedAt: number;
  } | null;
}
