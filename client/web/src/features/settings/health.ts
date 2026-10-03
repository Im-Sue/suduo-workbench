import type {
  CodexModelsResponse,
  McpServerDto,
  ModelProviderSettingsDto,
} from "@suduo/client-contracts";
import type { RequirementsSettingsDto, RequirementsWorkspaceMappingDto, WorkspaceMappingVerification } from "../../api/client.js";
import { summarizeDoctor, type DoctorCheck } from "../../app/pages/doctor-summary.js";
import { classifyFailure } from "../../feedback/classify.js";
import { formatDay } from "./format.js";
import type { SettingsSectionId } from "./sections.js";

/**
 * 诊断页的健康检查（需求 §4.7）：把各处的状态汇总成「每项一句结论 + 修复入口」。
 * 每项独立加载、独立失败；查不到的项如实写「没能完成检查」，不当成正常。
 */
export type HealthStatus = "ok" | "warn" | "fail" | "checking" | "unknown";

export type HealthFix = { label: string; section: SettingsSectionId } | { label: string; login: true };

export interface HealthItem {
  key: "service" | "login" | "codex" | "model" | "network" | "mcp" | "workspace" | "runtime";
  title: string;
  status: HealthStatus;
  detail: string;
  fix?: HealthFix;
}

/** 查询状态的最小形态，便于单测直接构造。 */
export interface Probe<T> {
  data?: T | undefined;
  error?: unknown;
  pending: boolean;
}

function host(url: string | null | undefined): string {
  if (url === null || url === undefined || url === "") return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function unknownItem(key: HealthItem["key"], title: string, error: unknown): HealthItem {
  return { key, title, status: "unknown", detail: `没能完成检查：${classifyFailure(error).message}` };
}

export function serviceHealth(settings: RequirementsSettingsDto | undefined, probe: Probe<unknown>): HealthItem {
  const title = "需求服务";
  if (settings === undefined) return { key: "service", title, status: "checking", detail: "正在检查…" };
  if (!settings.configured || settings.baseUrl === null) {
    return { key: "service", title, status: "fail", detail: "还没有设置需求服务地址", fix: { label: "去设置", section: "service" } };
  }
  const where = host(settings.baseUrl);
  if (probe.pending) return { key: "service", title, status: "checking", detail: `正在连接 ${where}…` };
  if (probe.error !== undefined && probe.error !== null) {
    return { key: "service", title, status: "fail", detail: `连不上 ${where}`, fix: { label: "检查地址", section: "service" } };
  }
  return { key: "service", title, status: "ok", detail: `连接正常 · ${where}` };
}

export function loginHealth(settings: RequirementsSettingsDto | undefined): HealthItem {
  const title = "登录";
  if (settings === undefined) return { key: "login", title, status: "checking", detail: "正在检查…" };
  if (settings.session === null) {
    return { key: "login", title, status: "fail", detail: "未登录", fix: { label: "去登录", login: true } };
  }
  return {
    key: "login",
    title,
    status: "ok",
    detail: `已登录：${settings.session.user.displayName} · 有效期至 ${formatDay(settings.session.expiresAt)}`,
  };
}

export function doctorHealth(probe: Probe<{ checks: DoctorCheck[] }>, key: "codex" | "runtime"): HealthItem {
  const title = key === "codex" ? "Codex 命令行" : "本机运行环境";
  if (probe.pending) return { key, title, status: "checking", detail: "正在检查…" };
  if (probe.data === undefined) return unknownItem(key, title, probe.error);
  const item = summarizeDoctor(probe.data.checks).find((entry) => entry.key === key);
  if (item === undefined) return { key, title, status: "unknown", detail: "没有拿到检查结果" };
  return { key, title, status: item.status, detail: item.detail };
}

export function modelHealth(
  provider: Probe<ModelProviderSettingsDto>,
  models: Probe<CodexModelsResponse>,
  warning: { summary: string | null } | null,
): HealthItem {
  const title = "模型服务";
  if (provider.pending) return { key: "model", title, status: "checking", detail: "正在检查…" };
  if (provider.data === undefined) {
    return { key: "model", title, status: "fail", detail: `读不到 Codex 的模型配置：${classifyFailure(provider.error).message}`, fix: { label: "查看", section: "model" } };
  }
  if (provider.data.baseUrl === "" || provider.data.apiKeyMasked === null) {
    return { key: "model", title, status: "warn", detail: "还没有配置服务地址或 API Key，开始会话前需要补上", fix: { label: "去配置", section: "model" } };
  }
  if (models.pending) return { key: "model", title, status: "checking", detail: "正在验证…" };
  if (models.data === undefined) {
    return {
      key: "model",
      title,
      status: "fail",
      detail: `Codex 没能取回模型清单：${classifyFailure(models.error).message}`,
      fix: { label: "去检查", section: "model" },
    };
  }
  if (warning !== null) {
    return {
      key: "model",
      title,
      status: "warn",
      detail: `可用，但 Codex 对当前配置有提醒${warning.summary === null ? "" : `：${warning.summary}`}`,
      fix: { label: "查看", section: "model" },
    };
  }
  return { key: "model", title, status: "ok", detail: `可用 · ${models.data.models.length} 个模型` };
}

export function networkHealth(probe: Probe<{ reachable: boolean; usingProxy: boolean; message: string }>): HealthItem {
  const title = "网络与代理";
  if (probe.pending) return { key: "network", title, status: "checking", detail: "正在试连模型服务…" };
  if (probe.data === undefined) return unknownItem("network", title, probe.error);
  const route = probe.data.usingProxy ? "经代理" : "直连";
  if (probe.data.reachable) return { key: "network", title, status: "ok", detail: `能连上模型服务（${route}）` };
  return {
    key: "network",
    title,
    status: "fail",
    detail: `连不上模型服务（${route}）`,
    fix: { label: "设置代理", section: "proxy" },
  };
}

export function mcpHealth(probe: Probe<{ items: McpServerDto[]; statusAvailable: boolean }>): HealthItem {
  const title = "MCP 服务";
  if (probe.pending) return { key: "mcp", title, status: "checking", detail: "正在检查…" };
  if (probe.data === undefined) return unknownItem("mcp", title, probe.error);
  const enabled = probe.data.items.filter((item) => item.enabled);
  if (probe.data.items.length === 0) return { key: "mcp", title, status: "ok", detail: "没有配置（可选）" };
  if (!probe.data.statusAvailable) {
    return { key: "mcp", title, status: "warn", detail: "暂时读不到 Codex 的运行状态", fix: { label: "查看", section: "mcp" } };
  }
  const troubled = enabled.filter((item) => item.status.startupState === "failed" || item.status.startupState === "unknown");
  if (troubled.length > 0) {
    return {
      key: "mcp",
      title,
      status: "warn",
      detail: `${troubled.map((item) => `「${item.name}」`).join("")}没有连上`,
      fix: { label: "去修复", section: "mcp" },
    };
  }
  return { key: "mcp", title, status: "ok", detail: enabled.length === 0 ? "都已停用" : `启用的 ${enabled.length} 个都已连接` };
}

export function workspaceHealth(
  probe: Probe<(RequirementsWorkspaceMappingDto & { verification?: WorkspaceMappingVerification })[]>,
  projectName: (mapping: RequirementsWorkspaceMappingDto) => string,
): HealthItem {
  const title = "代码目录";
  if (probe.pending) return { key: "workspace", title, status: "checking", detail: "正在检查…" };
  if (probe.data === undefined) return unknownItem("workspace", title, probe.error);
  if (probe.data.length === 0) {
    return { key: "workspace", title, status: "warn", detail: "还没有关联代码目录", fix: { label: "去关联", section: "workspace" } };
  }
  const broken = probe.data.filter((item) => item.verification !== undefined && !item.verification.available);
  if (broken.length > 0) {
    const first = broken[0]!;
    const reason = first.verification?.exists === false ? "目录已不存在" : "目录不可读写";
    return {
      key: "workspace",
      title,
      status: "fail",
      detail: `「${projectName(first)}」的${reason}${broken.length > 1 ? `，另有 ${broken.length - 1} 个项目也有问题` : ""}`,
      fix: { label: "重新选择", section: "workspace" },
    };
  }
  return { key: "workspace", title, status: "ok", detail: `${probe.data.length} 个项目的目录都可用` };
}
