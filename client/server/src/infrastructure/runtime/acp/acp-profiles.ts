import type { RuntimeApprovalMode } from "@suduo/client-contracts";

/**
 * 每家 ACP Agent 在 SuDuo 里的特殊处理（技术设计 2.1 quirks、2.4）。新增一家原则上只加配置表一条；
 * 只有模式名、启动环境不合通用规则时才在这里补。
 */
export interface AcpProfile {
  /** 各档位优先选的会话模式（ACP `modes` 或 category 为 mode 的配置项），按顺序找第一个有的。 */
  modes: Record<RuntimeApprovalMode, string[]>;
  /** 按档位给进程加的环境变量（改档位会重启进程）。 */
  env?(mode: RuntimeApprovalMode): Record<string, string>;
}

/** 通用的模式名偏好（比较时忽略大小写与连字符、下划线）。 */
const GENERIC_MODES: Record<RuntimeApprovalMode, string[]> = {
  readonly: ["plan", "readonly", "read-only", "ask"],
  // 不收 "ask"：有的 Agent（如 Cursor）的 ask 模式是只读问答，选了会改不了文件。
  ask: ["default", "agent", "build", "normal"],
  auto: ["auto-edit", "autoedit", "accept-edits", "acceptedits", "auto"],
  full: ["yolo", "bypass-permissions", "bypasspermissions", "full-access", "full"],
};

/** 只读档留下的 OpenCode 工具：看文件、搜索、联网查资料、待办，加 SuDuo 自己的工具（MCP 服务器名 suduo）。 */
const OPENCODE_READONLY_TOOLS = ["read", "grep", "glob", "list", "webfetch", "todowrite", "todoread", "suduo_*"];

/**
 * OpenCode 自己写文件、build 模式下也不发权限请求（S0）：写前询问 / 只读只能在启动时经
 * OPENCODE_CONFIG_CONTENT 注入权限规则。
 *
 * 只读（房间任务的安全红线，ADR-0009）只放行白名单里的工具，其余一律拿掉：所有者自己配的 MCP、自定义工具、
 * 子代理（task）、技能都不在里面，它们的默认权限是放行、不经 ACP 的权限请求，SuDuo 看不到。权限（permission）
 * 与工具开关（tools）两套都写，全局与 plan / build 代理级各写一份——内联配置优先级最高，所有者在全局配置里
 * 显式放行某个工具（含代理级）也压得住（S6 实测）；再关掉仓库里的项目配置（同 Claude 只读不加载设置）。
 */
function openCodeEnv(mode: RuntimeApprovalMode): Record<string, string> {
  if (mode === "readonly") {
    const permission = Object.fromEntries([["*", "deny"], ...OPENCODE_READONLY_TOOLS.map((tool) => [tool, "allow"])]);
    const tools = Object.fromEntries([["*", false], ...OPENCODE_READONLY_TOOLS.map((tool) => [tool, true])]);
    const rules = { permission, tools };
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...rules, agent: { plan: rules, build: rules } }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    };
  }
  const rules: Record<Exclude<RuntimeApprovalMode, "readonly">, Record<string, string>> = {
    ask: { edit: "ask", bash: "ask", webfetch: "ask" },
    auto: { edit: "allow", bash: "ask", webfetch: "allow" },
    full: { edit: "allow", bash: "allow", webfetch: "allow" },
  };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: rules[mode] }) };
}

const PROFILES: Record<string, AcpProfile> = {
  opencode: {
    modes: { ...GENERIC_MODES, ask: ["build"], auto: ["build"], full: ["build"], readonly: ["plan"] },
    env: openCodeEnv,
  },
};

export function acpProfile(agentId: string): AcpProfile {
  return PROFILES[agentId] ?? { modes: GENERIC_MODES };
}

/** 在 Agent 给出的模式里按偏好选一个；都没有返回 null（只靠 SuDuo 自己的权限策略）。 */
export function pickMode(available: readonly string[], preferred: readonly string[]): string | null {
  const normalize = (id: string) => id.toLowerCase().replace(/[-_\s]/g, "");
  for (const wanted of preferred) {
    const found = available.find((id) => normalize(id) === normalize(wanted));
    if (found !== undefined) return found;
  }
  return null;
}
