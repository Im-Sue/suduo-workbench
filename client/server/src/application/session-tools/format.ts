import type { Locale, RuntimeToolOutputItem } from "@suduo/client-contracts";
import {
  formatRequirementNumber,
  type RequirementDto,
  type UserSummaryDto,
} from "@suduo/cloud-contracts";
import { messagesFor } from "../../i18n/messages/index.js";
import { ApiError, IndeterminateOperationError, renderText } from "../api-error.js";

/** 单次工具结果的文本上限：代码模式下整串都会进模型上下文，太长就让模型翻页或看文件。 */
export const TOOL_TEXT_LIMIT = 12_000;

/** 工具执行结果：成功与否 + 交回给模型的内容。 */
export interface ToolResult {
  success: boolean;
  contentItems: RuntimeToolOutputItem[];
}

/** 工具结果的文字；超过上限时截断（截断说明与语言无关）。 */
export function textResult(text: string, success = true): ToolResult {
  return {
    success,
    contentItems: [{ type: "inputText", text: text.length > TOOL_TEXT_LIMIT ? text.slice(0, TOOL_TEXT_LIMIT) + "\n…" : text }],
  };
}

export function failure(text: string): ToolResult {
  return textResult(text, false);
}

/** 需求状态名，按会话的语言（`locale` 必填，免得漏传时悄悄退回中文）。 */
export function statusLabel(status: RequirementDto["status"], locale: Locale): string {
  const labels: Readonly<Record<string, string>> = messagesFor(locale).common.requirementStatus;
  return labels[status] ?? status;
}

/** 本机时区的「2026-09-30 14:32」。 */
export function formatTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 按会话语言绑定的工具文字辅助（中英双语 S7）：给 Codex 的工具回包、需求卡、房间开场一律用它，
 * `locale` 取会话的语言（`ToolSessionContext.locale` / 开场函数的 `input.locale`）。
 */
export function toolFormat(locale: Locale) {
  const t = messagesFor(locale);
  const text = t.toolText;
  const reason = (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.statusCode === 401 || error.code === "AUTH_REQUIRED" || error.code === "AUTH_INVALID") {
        return text.reason.notSignedIn;
      }
      if (error.statusCode === 404) {
        return text.reason.notFound;
      }
      if (error.statusCode === 503) {
        return text.reason.unreachable(error.render(t));
      }
      return error.render(t);
    }
    if (error instanceof IndeterminateOperationError) {
      return renderText(error.text, t);
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  };
  return {
    locale,
    /** 本机服务字典（工具文字之外的条目，如需求状态名）。 */
    t,
    truncate: (value: string, limit: number): string =>
      value.length > limit ? value.slice(0, limit) + text.truncatedSuffix : value,
    /** 三态里的「查不到」：`what` 由调用方按同一语言给出。 */
    unavailable: (what: string, error: unknown): ToolResult => failure(text.unavailable(what, reason(error))),
    reasonOf: reason,
    requirementLabel: (requirement: Pick<RequirementDto, "number" | "title">): string =>
      text.requirementLabel(formatRequirementNumber(requirement.number), requirement.title),
    statusLabel: (status: RequirementDto["status"]): string => statusLabel(status, locale),
    userName: (user: UserSummaryDto | null | undefined): string => user?.displayName ?? text.unassigned,
    evidenceNote: text.evidenceNote,
  };
}

export type ToolFormat = ReturnType<typeof toolFormat>;
