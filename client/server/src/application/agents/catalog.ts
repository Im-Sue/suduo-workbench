import type { AgentCapability, AgentChannel } from "@suduo/client-contracts";

/**
 * 登录状态怎么判断（ADR-0016：只用 CLI 自己的命令或协议握手，不读凭据文件）：
 * - bundled-codex：随 SuDuo 捆绑的 Codex，登录在 Codex 设置里管，这里不检查；
 * - claude-auth-status：`claude auth status` 输出 JSON，只读 loggedIn / authMethod / apiProvider；
 * - acp-session-probe：要等 ACP 运行时（S4）用 `session/new` 的鉴权错误判断，之前显示「已安装」。
 */
export type AgentAuthCheck = "bundled-codex" | "claude-auth-status" | "acp-session-probe";

export interface AgentInstallCommands {
  /** macOS / Linux 的官方安装命令；没有核实过的命令时为 null（只给官网链接）。 */
  unix: string | null;
  windows: string | null;
}

/** SuDuo 内置的 Agent 配置表条目（ADR-0014 第 2 条）。新增一家 ACP Agent 原则上只加一条。 */
export interface AgentDescriptor {
  id: string;
  displayName: string;
  vendor: string;
  channel: AgentChannel;
  bundled: boolean;
  /** 这个版本的 SuDuo 是否已实现它的接入通道（S3 Claude、S4 ACP 之前为 false）。 */
  runtimeAvailable: boolean;
  /** 可执行文件名候选，按顺序查找。 */
  binaryNames: string[];
  /** ACP 模式的启动参数（channel = acp 时用）。 */
  launchArgs: string[];
  versionArgs: string[];
  /** 低于它无法使用；没有可靠依据时为 null（不设门槛）。 */
  minVersion: string | null;
  /** S0 实测过的版本，只用于提示。 */
  verifiedVersion: string | null;
  auth: AgentAuthCheck;
  /** 官方登录命令，在终端里执行；用户自己完成登录（ADR-0016 第 2 条）。 */
  loginCommand: string | null;
  install: AgentInstallCommands;
  homepageUrl: string;
  termsUrl: string | null;
  capabilities: AgentCapability[];
  /** 能做到只读；做不到或尚未实测的为 false（不能共享进讨论，ADR-0014 第 9 条）。 */
  readOnlyCapable: boolean;
  /** 本机同时运行中的回合上限默认值（ADR-0017 调度）。 */
  defaultConcurrency: number;
}

const COMMON_ACP: Pick<AgentDescriptor, "channel" | "bundled" | "runtimeAvailable" | "versionArgs" | "auth" | "defaultConcurrency"> = {
  channel: "acp",
  bundled: false,
  runtimeAvailable: true,
  versionArgs: ["--version"],
  auth: "acp-session-probe",
  defaultConcurrency: 2,
};

/**
 * 首批 Agent（母需求 D2，2026-10-08 用户确认）。启动参数、握手能力、登录方式来自 S0 实测
 * （技术设计第十二节）；Cursor、Kimi 本机未装，按官方说明填写，readOnlyCapable 暂为 false。
 */
export const AGENT_CATALOG: readonly AgentDescriptor[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    vendor: "Anthropic",
    channel: "claude-sdk",
    bundled: false,
    runtimeAvailable: true,
    binaryNames: ["claude"],
    launchArgs: [],
    versionArgs: ["--version"],
    minVersion: null,
    verifiedVersion: "2.1.284",
    auth: "claude-auth-status",
    loginCommand: "claude auth login",
    install: {
      unix: "curl -fsSL https://claude.ai/install.sh | bash",
      windows: "irm https://claude.ai/install.ps1 | iex",
    },
    homepageUrl: "https://code.claude.com/docs",
    termsUrl: "https://code.claude.com/docs/en/legal-and-compliance",
    capabilities: ["image_input", "plan", "token_usage", "skills", "model_switch", "reasoning_effort", "session_resume", "mcp_http"],
    readOnlyCapable: true,
    defaultConcurrency: 2,
  },
  {
    id: "codex",
    displayName: "Codex",
    vendor: "OpenAI",
    channel: "codex-app-server",
    bundled: true,
    runtimeAvailable: true,
    binaryNames: ["codex"],
    launchArgs: [],
    versionArgs: ["--version"],
    minVersion: null,
    verifiedVersion: "0.159.2",
    auth: "bundled-codex",
    loginCommand: null,
    install: { unix: null, windows: null },
    homepageUrl: "https://developers.openai.com/codex",
    termsUrl: "https://openai.com/policies/",
    capabilities: ["image_input", "plan", "reasoning_summary", "token_usage", "skills", "model_switch", "reasoning_effort", "session_resume", "mcp_http"],
    readOnlyCapable: true,
    defaultConcurrency: 2,
  },
  {
    ...COMMON_ACP,
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    vendor: "GitHub",
    binaryNames: ["copilot"],
    launchArgs: ["--acp"],
    minVersion: null,
    verifiedVersion: "1.0.93",
    loginCommand: "copilot login",
    install: { unix: "npm install -g @github/copilot", windows: "npm install -g @github/copilot" },
    homepageUrl: "https://github.com/features/copilot/cli",
    termsUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features",
    capabilities: ["image_input", "session_resume", "mcp_http"],
    readOnlyCapable: false,
  },
  {
    ...COMMON_ACP,
    id: "gemini",
    displayName: "Gemini CLI",
    vendor: "Google",
    binaryNames: ["gemini"],
    launchArgs: ["--acp"],
    minVersion: null,
    verifiedVersion: "0.63.0",
    loginCommand: "gemini",
    install: { unix: "npm install -g @google/gemini-cli", windows: "npm install -g @google/gemini-cli" },
    homepageUrl: "https://github.com/google-gemini/gemini-cli",
    termsUrl: "https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md",
    capabilities: ["image_input", "session_resume", "mcp_http"],
    readOnlyCapable: false,
  },
  {
    ...COMMON_ACP,
    id: "cursor",
    displayName: "Cursor CLI",
    vendor: "Cursor",
    binaryNames: ["cursor-agent", "agent"],
    launchArgs: ["acp"],
    minVersion: null,
    verifiedVersion: null,
    loginCommand: "cursor-agent login",
    install: { unix: "curl https://cursor.com/install -fsS | bash", windows: null },
    homepageUrl: "https://cursor.com/cli",
    termsUrl: null,
    capabilities: ["image_input", "mcp_http"],
    readOnlyCapable: false,
  },
  {
    ...COMMON_ACP,
    id: "opencode",
    displayName: "OpenCode",
    vendor: "OpenCode",
    binaryNames: ["opencode"],
    launchArgs: ["acp"],
    minVersion: null,
    verifiedVersion: "1.18.35",
    loginCommand: "opencode auth login",
    install: { unix: "curl -fsSL https://opencode.ai/install | bash", windows: "npm install -g opencode-ai" },
    homepageUrl: "https://opencode.ai",
    termsUrl: null,
    // 模型在 ACP 会话的配置项里，SuDuo 还没接切换（S5 之后）：先不声明 model_switch，界面不出现模型选择。
    capabilities: ["image_input", "plan", "token_usage", "session_resume", "mcp_http"],
    readOnlyCapable: false,
  },
  {
    ...COMMON_ACP,
    id: "qwen-code",
    displayName: "Qwen Code",
    vendor: "Alibaba Qwen",
    binaryNames: ["qwen"],
    launchArgs: ["--acp"],
    minVersion: null,
    verifiedVersion: "0.25.0",
    loginCommand: "qwen",
    install: { unix: "npm install -g @qwen-code/qwen-code", windows: "npm install -g @qwen-code/qwen-code" },
    homepageUrl: "https://github.com/QwenLM/qwen-code",
    termsUrl: null,
    capabilities: ["image_input", "session_resume", "mcp_http"],
    readOnlyCapable: false,
  },
  {
    ...COMMON_ACP,
    id: "kimi-code",
    displayName: "Kimi Code",
    vendor: "Moonshot AI",
    binaryNames: ["kimi"],
    launchArgs: ["acp"],
    minVersion: null,
    verifiedVersion: null,
    loginCommand: "kimi",
    install: { unix: null, windows: null },
    homepageUrl: "https://www.kimi.com/code",
    termsUrl: null,
    capabilities: ["mcp_http"],
    readOnlyCapable: false,
  },
];

/** 启动时校验配置表；写错直接启动失败，不带病运行。 */
export function validateAgentCatalog(catalog: readonly AgentDescriptor[]): void {
  const ids = new Set<string>();
  for (const agent of catalog) {
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(agent.id)) {
      throw new Error(`agent catalog: invalid id ${JSON.stringify(agent.id)}`);
    }
    if (ids.has(agent.id)) {
      throw new Error(`agent catalog: duplicate id ${agent.id}`);
    }
    ids.add(agent.id);
    if (agent.binaryNames.length === 0) {
      throw new Error(`agent catalog: ${agent.id} has no binary names`);
    }
    if (agent.channel === "acp" && agent.launchArgs.length === 0) {
      throw new Error(`agent catalog: ACP agent ${agent.id} has no launch args`);
    }
    if (agent.defaultConcurrency < 1) {
      throw new Error(`agent catalog: ${agent.id} concurrency must be >= 1`);
    }
  }
}

export function findAgentDescriptor(id: string, catalog: readonly AgentDescriptor[] = AGENT_CATALOG): AgentDescriptor | undefined {
  return catalog.find((agent) => agent.id === id);
}
