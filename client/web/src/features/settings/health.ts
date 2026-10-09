import {
  SUDUO_DOCTOR_CHECK_IDS,
  type CodexModelsResponse,
  type McpServerDto,
  type ModelProviderSettingsDto,
} from "@suduo/client-contracts";
import type { RequirementsSettingsDto, RequirementsWorkspaceMappingDto, WorkspaceMappingVerification } from "../../api/client.js";
import { summarizeDoctor, type DoctorCheck } from "../../app/pages/doctor-summary.js";
import { classifyFailure } from "../../feedback/classify.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { formatDay } from "./format.js";
import type { SettingsSectionId } from "./sections.js";

/**
 * 诊断页的健康检查（需求 §4.7）：把各处的状态汇总成「每项一句结论 + 修复入口」。
 * 每项独立加载、独立失败；查不到的项如实写「没能完成检查」，不当成正常。
 * 文字按调用时的界面语言取；组件里可以把 useT() 拿到的字典作为最后一个参数传入。
 */
export type HealthStatus = "ok" | "warn" | "fail" | "checking" | "unknown";

export type HealthFix = { label: string; section: SettingsSectionId } | { label: string; login: true };

export interface HealthItem {
  /** 各家 Agent 一项（多 Agent S12）：`agent:<id>`。 */
  key: "service" | "login" | "codex" | "model" | "network" | "mcp" | "workspace" | "runtime" | `agent:${string}`;
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

function unknownItem(key: HealthItem["key"], title: string, error: unknown, t: Messages): HealthItem {
  return { key, title, status: "unknown", detail: t.settings.health.unknown(classifyFailure(error).message) };
}

export function serviceHealth(
  settings: RequirementsSettingsDto | undefined,
  probe: Probe<unknown>,
  t: Messages = messagesFor(currentLocale()),
): HealthItem {
  const text = t.settings.health;
  const title = text.titles.service;
  if (settings === undefined) return { key: "service", title, status: "checking", detail: text.checking };
  if (!settings.configured || settings.baseUrl === null) {
    return { key: "service", title, status: "fail", detail: text.service.notConfigured, fix: { label: text.fix.setUp, section: "service" } };
  }
  const where = host(settings.baseUrl);
  if (probe.pending) return { key: "service", title, status: "checking", detail: text.service.connecting(where) };
  if (probe.error !== undefined && probe.error !== null) {
    return { key: "service", title, status: "fail", detail: text.service.unreachable(where), fix: { label: text.fix.checkAddress, section: "service" } };
  }
  return { key: "service", title, status: "ok", detail: text.service.ok(where) };
}

export function loginHealth(settings: RequirementsSettingsDto | undefined, t: Messages = messagesFor(currentLocale())): HealthItem {
  const text = t.settings.health;
  const title = text.titles.login;
  if (settings === undefined) return { key: "login", title, status: "checking", detail: text.checking };
  if (settings.session === null) {
    return { key: "login", title, status: "fail", detail: text.login.signedOut, fix: { label: text.fix.signIn, login: true } };
  }
  return {
    key: "login",
    title,
    status: "ok",
    detail: text.login.signedIn(settings.session.user.displayName, formatDay(settings.session.expiresAt)),
  };
}

export function doctorHealth(
  probe: Probe<{ checks: DoctorCheck[] }>,
  key: "codex" | "runtime",
  t: Messages = messagesFor(currentLocale()),
): HealthItem {
  const text = t.settings.health;
  const title = text.titles[key];
  if (probe.pending) return { key, title, status: "checking", detail: text.checking };
  if (probe.data === undefined) return unknownItem(key, title, probe.error, t);
  const item = summarizeDoctor(probe.data.checks, t).find((entry) => entry.key === key);
  if (item === undefined) return { key, title, status: "unknown", detail: text.noResult };
  return { key, title, status: item.status, detail: item.detail };
}

/**
 * 各家 Agent（多 Agent S12）：自检里 Codex 以外的每家一项（启用了、装了的，没装的只在它是默认 Agent 时出现），
 * 结论与说明都来自服务端（命令行 doctor 同一份）。没通过的给「AI Agent」设置入口；自检还没出来时不占位。
 */
export function agentHealthItems(probe: Probe<{ checks: DoctorCheck[] }>, t: Messages = messagesFor(currentLocale())): HealthItem[] {
  const fix = { label: t.settings.health.fix.view, section: "agents" as const };
  return (probe.data?.checks ?? [])
    .filter((check) => check.id === SUDUO_DOCTOR_CHECK_IDS.agent && check.agentId !== undefined)
    .map((check) => ({
      key: `agent:${check.agentId ?? ""}` as const,
      title: check.name,
      status: check.status === "pass" ? "ok" : check.status,
      detail: check.message,
      ...(check.status === "pass" ? {} : { fix }),
    }));
}

export function modelHealth(
  provider: Probe<ModelProviderSettingsDto>,
  models: Probe<CodexModelsResponse>,
  warning: { summary: string | null } | null,
  t: Messages = messagesFor(currentLocale()),
): HealthItem {
  const text = t.settings.health;
  const title = text.titles.model;
  if (provider.pending) return { key: "model", title, status: "checking", detail: text.checking };
  if (provider.data === undefined) {
    return { key: "model", title, status: "fail", detail: text.model.unreadable(classifyFailure(provider.error).message), fix: { label: text.fix.view, section: "model" } };
  }
  if (provider.data.baseUrl === "" || provider.data.apiKeyMasked === null) {
    return { key: "model", title, status: "warn", detail: text.model.notConfigured, fix: { label: text.fix.configure, section: "model" } };
  }
  if (models.pending) return { key: "model", title, status: "checking", detail: text.model.verifying };
  if (models.data === undefined) {
    return {
      key: "model",
      title,
      status: "fail",
      detail: text.model.listFailed(classifyFailure(models.error).message),
      fix: { label: text.fix.check, section: "model" },
    };
  }
  if (warning !== null) {
    return {
      key: "model",
      title,
      status: "warn",
      detail: text.model.configWarning(warning.summary),
      fix: { label: text.fix.view, section: "model" },
    };
  }
  return { key: "model", title, status: "ok", detail: text.model.ok(models.data.models.length) };
}

export function networkHealth(
  probe: Probe<{ reachable: boolean; usingProxy: boolean; message: string }>,
  t: Messages = messagesFor(currentLocale()),
): HealthItem {
  const text = t.settings.health;
  const title = text.titles.network;
  if (probe.pending) return { key: "network", title, status: "checking", detail: text.network.checking };
  if (probe.data === undefined) return unknownItem("network", title, probe.error, t);
  const route = probe.data.usingProxy ? text.network.viaProxy : text.network.direct;
  if (probe.data.reachable) return { key: "network", title, status: "ok", detail: text.network.reachable(route) };
  return {
    key: "network",
    title,
    status: "fail",
    detail: text.network.unreachable(route),
    fix: { label: text.fix.setProxy, section: "proxy" },
  };
}

export function mcpHealth(
  probe: Probe<{ items: McpServerDto[]; statusAvailable: boolean }>,
  t: Messages = messagesFor(currentLocale()),
): HealthItem {
  const text = t.settings.health;
  const title = text.titles.mcp;
  if (probe.pending) return { key: "mcp", title, status: "checking", detail: text.checking };
  if (probe.data === undefined) return unknownItem("mcp", title, probe.error, t);
  const enabled = probe.data.items.filter((item) => item.enabled);
  if (probe.data.items.length === 0) return { key: "mcp", title, status: "ok", detail: text.mcp.none };
  if (!probe.data.statusAvailable) {
    return { key: "mcp", title, status: "warn", detail: text.mcp.statusUnavailable, fix: { label: text.fix.view, section: "mcp" } };
  }
  const troubled = enabled.filter((item) => item.status.startupState === "failed" || item.status.startupState === "unknown");
  if (troubled.length > 0) {
    return {
      key: "mcp",
      title,
      status: "warn",
      detail: text.mcp.notConnected(troubled.map((item) => item.name)),
      fix: { label: text.fix.repair, section: "mcp" },
    };
  }
  return { key: "mcp", title, status: "ok", detail: enabled.length === 0 ? text.mcp.allDisabled : text.mcp.allConnected(enabled.length) };
}

export function workspaceHealth(
  probe: Probe<(RequirementsWorkspaceMappingDto & { verification?: WorkspaceMappingVerification })[]>,
  projectName: (mapping: RequirementsWorkspaceMappingDto) => string,
  t: Messages = messagesFor(currentLocale()),
): HealthItem {
  const text = t.settings.health;
  const title = text.titles.workspace;
  if (probe.pending) return { key: "workspace", title, status: "checking", detail: text.checking };
  if (probe.data === undefined) return unknownItem("workspace", title, probe.error, t);
  if (probe.data.length === 0) {
    return { key: "workspace", title, status: "warn", detail: text.workspace.none, fix: { label: text.fix.link, section: "workspace" } };
  }
  const broken = probe.data.filter((item) => item.verification !== undefined && !item.verification.available);
  if (broken.length > 0) {
    const first = broken[0]!;
    const reason = first.verification?.exists === false ? text.workspace.missing : text.workspace.noAccess;
    return {
      key: "workspace",
      title,
      status: "fail",
      detail: text.workspace.broken(projectName(first), reason, broken.length - 1),
      fix: { label: text.fix.reselect, section: "workspace" },
    };
  }
  return { key: "workspace", title, status: "ok", detail: text.workspace.ok(probe.data.length) };
}
