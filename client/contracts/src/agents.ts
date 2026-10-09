/**
 * 多 Agent 接入（ADR-0014）：本机可用的 AI 编码 Agent、它们的状态与设置。
 * 状态与原因只给稳定的代码与参数，界面按语言自己翻译。
 */

/** 接入通道：Codex 官方 app-server、Claude 官方 Agent SDK、开放的 Agent Client Protocol。 */
export type AgentChannel = "codex-app-server" | "claude-sdk" | "acp";

/**
 * 本机状态：
 * - ready：已安装，确认可用（或已确认登录）；
 * - installed：已安装，登录状态要到第一次用时才能确认；
 * - not_installed：找不到可执行文件；
 * - auth_required：已安装但需要登录；
 * - version_unsupported：版本低于最低要求；
 * - error：检测时出错（原因见 reasonCode）。
 */
export type AgentStatus =
  /** 还没检测完（列表先出、状态逐个补上，S5）。 */
  | "checking"
  | "ready"
  | "installed"
  | "not_installed"
  | "auth_required"
  | "version_unsupported"
  | "error";

export type AgentStatusReasonCode =
  | "binary_not_found"
  | "version_unreadable"
  | "version_below_minimum"
  | "auth_check_failed"
  | "not_logged_in"
  | "check_timeout"
  | "check_failed"
  | "disabled";

/** 与 Agent 无关的能力名；界面按它显示或隐藏入口。 */
export type AgentCapability =
  | "image_input"
  | "plan"
  | "reasoning_summary"
  | "token_usage"
  | "skills"
  | "model_switch"
  | "reasoning_effort"
  | "active_turn_guidance"
  | "session_resume"
  | "mcp_http";

/** Agent 卡片上的操作；命令与链接来自 SuDuo 内置的配置表，不接受外部输入。 */
export type AgentActionKind = "copy_install_command" | "open_terminal_login" | "recheck" | "open_homepage";

export interface AgentActionDto {
  kind: AgentActionKind;
  /** copy_install_command / open_terminal_login 用。 */
  command?: string;
  /** open_homepage 用。 */
  url?: string;
}

export interface AgentDto {
  id: string;
  displayName: string;
  vendor: string;
  channel: AgentChannel;
  /** 随 SuDuo 捆绑（目前只有 Codex）。 */
  bundled: boolean;
  /** 这个版本的 SuDuo 能否驱动它开工（接入通道已实现）；为 false 时只显示检测结果。 */
  runtimeAvailable: boolean;
  enabled: boolean;
  status: AgentStatus;
  reasonCode: AgentStatusReasonCode | null;
  /** 原因的补充（如读到的版本号、退出码），不含凭据。 */
  reasonDetail: string | null;
  version: string | null;
  /** 低于它无法使用；null 表示不设门槛。 */
  minVersion: string | null;
  /** SuDuo 实测过的版本（同一大版本、次版本的补丁版本也算），只用于提示（ADR-0004：不拦截）。 */
  verifiedVersions: string[];
  /** 读到的版本在不在验证过的范围里；没读到版本、或这家还没有验证过的版本时为 null。 */
  versionVerified: boolean | null;
  executablePath: string | null;
  actions: AgentActionDto[];
  capabilities: AgentCapability[];
  /** 能做到「只读」（ADR-0014 第 9 条）；做不到的不能被共享进讨论。 */
  readOnlyCapable: boolean;
  homepageUrl: string;
  /** 该厂商的使用条款（ADR-0016：只提示、不限制）；没有可靠链接时为 null。 */
  termsUrl: string | null;
  /** 最近一次检测时间（毫秒）；从未检测为 null。 */
  checkedAt: number | null;
}

export interface AgentListDto {
  defaultAgentId: string;
  agents: AgentDto[];
}

export interface AgentSettingDto {
  id: string;
  enabled: boolean;
  /** 可执行文件路径覆盖；null 表示自动查找。 */
  binOverride: string | null;
  /** 这家 Agent 同时运行中的回合上限（多 Agent 协作 S8；没设时为配置表的默认值）。 */
  concurrency: number;
}

export interface AgentSettingsDto {
  defaultAgentId: string;
  agents: AgentSettingDto[];
  /** 全部 Agent 合计同时运行中的回合上限（默认 4）。 */
  globalConcurrency: number;
}

export interface UpdateAgentSettingsRequest {
  defaultAgentId?: string;
  agents?: Array<{ id: string; enabled?: boolean; binOverride?: string | null; concurrency?: number }>;
  globalConcurrency?: number;
}

/** 并发上限的取值范围（每家与合计都是）。 */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 8;
export const DEFAULT_GLOBAL_CONCURRENCY = 4;

/** POST /api/v1/agents/:id/login 的结果：桌面环境打开了终端，或者返回命令让用户自己执行。 */
export interface AgentLoginResultDto {
  opened: boolean;
  command: string;
}

/** 默认 Agent（老会话也视为 Codex）。 */
export const DEFAULT_AGENT_ID = "codex" as const;
