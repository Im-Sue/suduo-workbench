import {
  BellIcon,
  FolderGit2Icon,
  GlobeIcon,
  InfoIcon,
  PaletteIcon,
  PlugIcon,
  PuzzleIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StethoscopeIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * 设置分组（需求 §4.7）。分组即路由：`/settings/$section`。
 * 顺序与分段按「谁拥有这项设置」：本机与团队（通用）→ Codex → 排障与版本（其他）。
 */
export const SETTINGS_SECTION_IDS = [
  "appearance",
  "notifications",
  "account",
  "service",
  "workspace",
  "model",
  "execution",
  "skills",
  "mcp",
  "proxy",
  "diagnostics",
  "about",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  title: string;
  icon: LucideIcon;
  /** 分组导航里的分段标题。 */
  band: "通用" | "Codex" | "其他";
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: "appearance", title: "外观", icon: PaletteIcon, band: "通用" },
  { id: "notifications", title: "通知", icon: BellIcon, band: "通用" },
  { id: "account", title: "账号", icon: UserRoundIcon, band: "通用" },
  { id: "service", title: "需求服务", icon: ServerIcon, band: "通用" },
  { id: "workspace", title: "代码目录", icon: FolderGit2Icon, band: "通用" },
  { id: "model", title: "模型服务", icon: SparklesIcon, band: "Codex" },
  { id: "execution", title: "执行与安全", icon: ShieldCheckIcon, band: "Codex" },
  { id: "skills", title: "Skills", icon: PuzzleIcon, band: "Codex" },
  { id: "mcp", title: "MCP 服务", icon: PlugIcon, band: "Codex" },
  { id: "proxy", title: "网络代理", icon: GlobeIcon, band: "Codex" },
  { id: "diagnostics", title: "诊断", icon: StethoscopeIcon, band: "其他" },
  { id: "about", title: "关于", icon: InfoIcon, band: "其他" },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

export function isSettingsSection(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export function sectionMeta(id: SettingsSectionId): SettingsSectionMeta {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0]!;
}

/** 旧版 `/settings#组` 的锚点 → 新分组。 */
const LEGACY_HASH: Readonly<Record<string, SettingsSectionId>> = {
  account: "account",
  workspace: "workspace",
  model: "model",
  capability: "skills",
  security: "execution",
  diagnostics: "diagnostics",
  proxy: "proxy",
};

export function sectionFromLegacyHash(hash: string): SettingsSectionId | null {
  const raw = hash.replace(/^#/, "");
  if (raw === "") return null;
  return LEGACY_HASH[raw] ?? (isSettingsSection(raw) ? raw : null);
}

const LAST_SECTION_KEY = "suduo.settings.section";

/** 从侧栏回到设置时落在上次看的分组。 */
export function readLastSection(): SettingsSectionId | null {
  try {
    const raw = window.localStorage.getItem(LAST_SECTION_KEY);
    return isSettingsSection(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function rememberSection(section: SettingsSectionId): void {
  try {
    window.localStorage.setItem(LAST_SECTION_KEY, section);
  } catch {
    // 存储不可用时只是不记忆。
  }
}

/**
 * 设置搜索的索引：每一项对应页面上的一行（`anchor` 即行的锚点）。
 * 关键词写用户会搜的说法，也收常见英文与旧叫法。
 */
export interface SettingsSearchItem {
  section: SettingsSectionId;
  anchor: string;
  title: string;
  keywords: string;
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchItem[] = [
  { section: "appearance", anchor: "theme", title: "主题", keywords: "外观 浅色 亮色 深色 暗色 跟随系统 dark light theme" },
  { section: "appearance", anchor: "density", title: "界面密度", keywords: "紧凑 舒适 行高 字号 density" },
  { section: "notifications", anchor: "system-notify", title: "系统通知", keywords: "通知 提醒 完成 失败 等你确认 桌面 notification" },
  { section: "account", anchor: "current-user", title: "当前账号", keywords: "账号 登录 用户 身份" },
  { section: "account", anchor: "logout", title: "退出登录", keywords: "登出 注销 logout" },
  { section: "service", anchor: "service-url", title: "需求服务地址", keywords: "需求服务 服务地址 测试连接 url 内网" },
  { section: "workspace", anchor: "mappings", title: "项目的代码目录", keywords: "代码目录 目录 路径 关联 映射 仓库 工作目录 workspace" },
  { section: "model", anchor: "model-url", title: "模型服务地址", keywords: "模型 服务地址 base url 接口" },
  { section: "model", anchor: "api-key", title: "API Key", keywords: "密钥 key 凭据 token" },
  { section: "model", anchor: "model-name", title: "默认模型", keywords: "模型 model" },
  { section: "model", anchor: "reasoning", title: "默认推理强度", keywords: "推理 思考 强度 effort" },
  { section: "model", anchor: "context-window", title: "上下文上限", keywords: "上下文 token 窗口 context" },
  { section: "model", anchor: "model-test", title: "测试模型服务连接", keywords: "测试连接 连通 模型" },
  { section: "execution", anchor: "approval", title: "新会话默认确认方式", keywords: "审批 权限 确认 完全访问 每步确认 越界 approval" },
  { section: "execution", anchor: "full-access", title: "会话可切换到完全访问", keywords: "完全访问 限制 管理员 锁定" },
  { section: "execution", anchor: "checkpoint", title: "回合前自动存档", keywords: "检查点 存档 git 回退 checkpoint" },
  { section: "skills", anchor: "global-skills", title: "使用个人 Skills 目录", keywords: "skill 全局 个人目录" },
  { section: "skills", anchor: "install-skill", title: "安装 Skill", keywords: "skill 安装 导入" },
  { section: "skills", anchor: "skill-list", title: "已安装的 Skills", keywords: "skill 启用 停用 卸载" },
  { section: "mcp", anchor: "mcp-servers", title: "MCP 服务", keywords: "mcp 工具 服务器 连接 测试连接 登录" },
  { section: "proxy", anchor: "proxy-http", title: "HTTP 代理", keywords: "代理 proxy http 网络" },
  { section: "proxy", anchor: "proxy-https", title: "HTTPS 代理", keywords: "代理 proxy https 网络" },
  { section: "proxy", anchor: "proxy-all", title: "其他连接的代理", keywords: "代理 proxy socks all" },
  { section: "proxy", anchor: "no-proxy", title: "不走代理的地址", keywords: "代理 例外 直连 no proxy 白名单" },
  { section: "proxy", anchor: "proxy-test", title: "测试代理连接", keywords: "测试连接 代理 连通" },
  { section: "diagnostics", anchor: "health", title: "健康检查", keywords: "诊断 自检 排查 doctor 问题" },
  { section: "diagnostics", anchor: "all-checks", title: "全部检查项", keywords: "诊断 详细 处理建议" },
  { section: "about", anchor: "version", title: "版本", keywords: "版本 关于 codex version" },
  { section: "about", anchor: "license", title: "许可", keywords: "许可 许可证 授权 商用 登记 源码 license commercial" },
  { section: "about", anchor: "config-file", title: "直接编辑 Codex 配置文件", keywords: "配置文件 config toml 高级" },
];

export function searchSettings(query: string): SettingsSearchItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return [];
  return SETTINGS_SEARCH_INDEX.filter((item) => {
    const haystack = `${item.title} ${sectionMeta(item.section).title} ${item.keywords}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** 行锚点在 DOM 里的 id。 */
export function settingAnchorId(anchor: string): string {
  return `setting-${anchor}`;
}
