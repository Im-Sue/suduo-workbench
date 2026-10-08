import { SUDUO_MCP_SERVER_NAME, type RuntimeApprovalMode } from "@suduo/client-contracts";

/** 只读档放行的 Claude 内置工具（技术设计 2.4，S0 实测）。 */
export const CLAUDE_READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "TodoWrite"] as const;

/** 只读档明确禁用的写入与执行类工具（allowedTools 之外再兜一层）。 */
export const CLAUDE_WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "BashOutput", "KillShell", "KillBash"] as const;

/** 一条查询启动时定下的权限相关参数（只读档的几项改了要重启查询）。 */
export interface ClaudePermissionOptions {
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  allowDangerouslySkipPermissions?: true;
  /** 只读档不加载用户与项目设置：免得其中的 allow 规则先于 canUseTool 放行写入、带上所有者的 MCP。 */
  settingSources: Array<"user" | "project" | "local">;
  /** 只读档只用 SuDuo 传入的 MCP（S0：不加这个仍会挂上 claude.ai 账号的连接器）。 */
  strictMcpConfig: boolean;
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * SuDuo 审批档 → Claude Code 的权限参数（ADR-0014 第 5 条、技术设计 2.4）。SuDuo 工具服务整个放行：
 * 只读工具不该每次问；发评论有 SuDuo 自己的确认卡（与 Codex 配 default_tools_approval_mode = approve 同理）。
 * 令牌只授予这个会话该有的工具，只读档拿到的清单里本来就没有写工具。
 */
export function claudePermissionOptions(mode: RuntimeApprovalMode): ClaudePermissionOptions {
  const suDuoTools = "mcp__" + SUDUO_MCP_SERVER_NAME;
  if (mode === "readonly") {
    return {
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      allowedTools: [...CLAUDE_READ_ONLY_TOOLS, suDuoTools],
      disallowedTools: [...CLAUDE_WRITE_TOOLS],
    };
  }
  const common = { settingSources: ["user", "project", "local"] as Array<"user" | "project" | "local">, strictMcpConfig: false, allowedTools: [suDuoTools], disallowedTools: [] };
  switch (mode) {
    case "ask":
      return { ...common, permissionMode: "default" };
    case "auto":
      return { ...common, permissionMode: "acceptEdits" };
    case "full":
      return { ...common, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  }
}

/**
 * 档位之间能不能在同一条查询里切换。只读的启动参数不同；完全访问要在启动时就允许跳过权限检查
 * （实测：没带 allowDangerouslySkipPermissions 启动的查询切不到 bypassPermissions）。这两种都要重启查询
 * （续接，历史不丢）；询问与自动之间直接切换。
 */
export function sameQueryShape(a: RuntimeApprovalMode, b: RuntimeApprovalMode): boolean {
  return queryShape(a) === queryShape(b);
}

function queryShape(mode: RuntimeApprovalMode): "readonly" | "bypass" | "normal" {
  return mode === "readonly" ? "readonly" : mode === "full" ? "bypass" : "normal";
}
