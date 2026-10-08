import {
  BellIcon,
  BotIcon,
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
import { LOCALES } from "@suduo/client-contracts";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";

/**
 * 设置分组（需求 §4.7）。分组即路由：`/settings/$section`。
 * 顺序与分段按「谁拥有这项设置」：本机与团队（通用，含本机的 AI Agent）→ Codex → 排障与版本（其他）。
 */
export const SETTINGS_SECTION_IDS = [
  "appearance",
  "notifications",
  "account",
  "service",
  "workspace",
  "agents",
  "model",
  "execution",
  "skills",
  "mcp",
  "proxy",
  "diagnostics",
  "about",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export type SettingsBand = keyof Messages["settings"]["bands"];

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  title: string;
  icon: LucideIcon;
  /** 分组导航里的分段（文字见字典 settings.bands）。 */
  band: SettingsBand;
}

const SECTION_LAYOUT: readonly Omit<SettingsSectionMeta, "title">[] = [
  { id: "appearance", icon: PaletteIcon, band: "general" },
  { id: "notifications", icon: BellIcon, band: "general" },
  { id: "account", icon: UserRoundIcon, band: "general" },
  { id: "service", icon: ServerIcon, band: "general" },
  { id: "workspace", icon: FolderGit2Icon, band: "general" },
  { id: "agents", icon: BotIcon, band: "general" },
  { id: "model", icon: SparklesIcon, band: "codex" },
  { id: "execution", icon: ShieldCheckIcon, band: "codex" },
  { id: "skills", icon: PuzzleIcon, band: "codex" },
  { id: "mcp", icon: PlugIcon, band: "codex" },
  { id: "proxy", icon: GlobeIcon, band: "codex" },
  { id: "diagnostics", icon: StethoscopeIcon, band: "other" },
  { id: "about", icon: InfoIcon, band: "other" },
];

/** 分组清单；分组名按调用时的界面语言取，组件里可以传入 useT() 拿到的字典。 */
export function settingsSections(t: Messages = messagesFor(currentLocale())): SettingsSectionMeta[] {
  return SECTION_LAYOUT.map((section) => ({ ...section, title: t.settings.sections[section.id] }));
}

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

export function isSettingsSection(value: unknown): value is SettingsSectionId {
  return typeof value === "string" && (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export function sectionMeta(id: SettingsSectionId, t: Messages = messagesFor(currentLocale())): SettingsSectionMeta {
  const layout = SECTION_LAYOUT.find((section) => section.id === id) ?? SECTION_LAYOUT[0]!;
  return { ...layout, title: t.settings.sections[layout.id] };
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
 * 设置搜索的索引：每一项对应页面上的一行（`anchor` 即行的锚点，`key` 是字典 settings.search 里的标题与关键词）。
 * 关键词写用户会搜的说法，也收常见英文与旧叫法。
 */
export type SettingsSearchKey = keyof Messages["settings"]["search"];

export interface SettingsSearchEntry {
  section: SettingsSectionId;
  anchor: string;
  key: SettingsSearchKey;
}

export interface SettingsSearchItem {
  section: SettingsSectionId;
  anchor: string;
  title: string;
}

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { section: "appearance", anchor: "theme", key: "theme" },
  { section: "appearance", anchor: "density", key: "density" },
  { section: "appearance", anchor: "locale", key: "locale" },
  { section: "notifications", anchor: "system-notify", key: "systemNotify" },
  { section: "account", anchor: "current-user", key: "currentUser" },
  { section: "account", anchor: "logout", key: "logout" },
  { section: "service", anchor: "service-url", key: "serviceUrl" },
  { section: "workspace", anchor: "mappings", key: "mappings" },
  { section: "model", anchor: "model-url", key: "modelUrl" },
  { section: "model", anchor: "api-key", key: "apiKey" },
  { section: "model", anchor: "model-name", key: "modelName" },
  { section: "model", anchor: "reasoning", key: "reasoning" },
  { section: "model", anchor: "context-window", key: "contextWindow" },
  { section: "model", anchor: "model-test", key: "modelTest" },
  { section: "execution", anchor: "approval", key: "approval" },
  { section: "execution", anchor: "full-access", key: "fullAccess" },
  { section: "execution", anchor: "checkpoint", key: "checkpoint" },
  { section: "skills", anchor: "global-skills", key: "globalSkills" },
  { section: "skills", anchor: "install-skill", key: "installSkill" },
  { section: "skills", anchor: "skill-list", key: "skillList" },
  { section: "mcp", anchor: "mcp-servers", key: "mcpServers" },
  { section: "proxy", anchor: "proxy-http", key: "proxyHttp" },
  { section: "proxy", anchor: "proxy-https", key: "proxyHttps" },
  { section: "proxy", anchor: "proxy-all", key: "proxyAll" },
  { section: "proxy", anchor: "no-proxy", key: "noProxy" },
  { section: "proxy", anchor: "proxy-test", key: "proxyTest" },
  { section: "diagnostics", anchor: "health", key: "health" },
  { section: "diagnostics", anchor: "all-checks", key: "allChecks" },
  { section: "about", anchor: "version", key: "version" },
  { section: "about", anchor: "license", key: "license" },
  { section: "about", anchor: "config-file", key: "configFile" },
];

/**
 * 一项的搜索文本：所有语言的标题、分组名与关键词拼在一起，中文、英文都能搜到同一行；
 * 显示仍用当前语言（中英双语技术设计 §4.3）。
 */
function searchText(entry: SettingsSearchEntry): string {
  return LOCALES.map((locale) => {
    const text = messagesFor(locale).settings;
    const item = text.search[entry.key];
    return `${item.title} ${text.sections[entry.section]} ${item.keywords}`;
  })
    .join(" ")
    .toLowerCase();
}

/** 搜索设置；结果的标题按调用时的界面语言取，组件里可以传入 useT() 拿到的字典。 */
export function searchSettings(query: string, t: Messages = messagesFor(currentLocale())): SettingsSearchItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return [];
  return SETTINGS_SEARCH_INDEX.filter((entry) => {
    const haystack = searchText(entry);
    return terms.every((term) => haystack.includes(term));
  }).map((entry) => ({ section: entry.section, anchor: entry.anchor, title: t.settings.search[entry.key].title }));
}

/** 行锚点在 DOM 里的 id。 */
export function settingAnchorId(anchor: string): string {
  return `setting-${anchor}`;
}
