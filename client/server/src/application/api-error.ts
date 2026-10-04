import type { ErrorCode, JsonValue, Locale, LocalPathErrorCode } from "@suduo/client-contracts";
import type { RequirementsV2ErrorCode } from "@suduo/cloud-contracts";
import { messagesFor, type ServerMessages } from "../i18n/messages/index.js";

export type BffErrorCode = ErrorCode | RequirementsV2ErrorCode | LocalPathErrorCode;

export interface BffErrorResponse {
  error: {
    code: BffErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/**
 * 给人看的说明：「按字典生成」的函数，或与语言无关的固定文字（第三方原文、技术标识）。
 * 中英双语技术设计 §三：本机服务的错误与提示按请求语言生成，所以写成函数、到返回时才定语言：
 * `new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.pathInvalid)`。
 */
export type ErrorText = string | ((t: ServerMessages) => string);

/** 按字典渲染一段说明。 */
export function renderText(text: ErrorText, t: ServerMessages): string {
  return typeof text === "string" ? text : text(t);
}

/**
 * `Error.message` 用的语言。日志、测试和只读 `message` 的旧调用方看到的都是它；
 * 要给人看的地方一律用 `localizedMessage()` / `render()` / `errorTextOf()`，不要拼 `error.message`。
 */
const MESSAGE_LOCALE: Locale = "zh-CN";

export class ApiError extends Error {
  private readonly text: ErrorText;

  constructor(
    readonly statusCode: number,
    readonly code: BffErrorCode,
    message: ErrorText,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(renderText(message, messagesFor(MESSAGE_LOCALE)), options);
    this.text = message;
    this.name = "ApiError";
  }

  /** 按给定字典生成的说明（拼进另一段说明时用）。 */
  render(t: ServerMessages): string {
    return renderText(this.text, t);
  }

  /** 按指定语言给出的说明；返回给界面时用请求的语言。 */
  localizedMessage(locale: Locale): string {
    return this.render(messagesFor(locale));
  }
}

/**
 * 任意错误的说明，拼进另一段说明时用：`(t) => t.activity.heartbeatFailed(errorTextOf(error)(t))`。
 * `ApiError` 按字典生成；其它错误用原文（多为系统或第三方的报错，不翻译）。
 */
export function errorTextOf(error: unknown): (t: ServerMessages) => string {
  if (error instanceof ApiError) return (t) => error.render(t);
  const message = error instanceof Error ? error.message : String(error);
  return () => message;
}

export class IndeterminateOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndeterminateOperationError";
  }
}

export function errorResponse(
  error: ApiError,
  requestId: string,
  locale: Locale = MESSAGE_LOCALE,
): BffErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.localizedMessage(locale),
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function asJsonError(error: unknown): JsonValue {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
}
