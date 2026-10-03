import { currentLocale } from "../i18n/locale.js";
import { messagesFor } from "../i18n/messages/index.js";
import type { Failure, FailureKind } from "./types.js";

const CODE_KINDS: Record<string, FailureKind> = {
  AUTH_REQUIRED: "auth_expired",
  AUTH_INVALID: "auth_expired",
  LOGIN_CREDENTIALS_INVALID: "auth_expired",
  REMOTE_SERVICE_NOT_CONFIGURED: "not_configured",
  WORKSPACE_MAPPING_REQUIRED: "not_configured",
  VERSION_CONFLICT: "version_conflict",
  IDEMPOTENCY_CONFLICT: "stale_state",
  IDEMPOTENCY_INDETERMINATE: "stale_state",
  PROJECT_HAS_ACTIVE_SESSIONS: "stale_state",
  SESSION_NOT_ACTIVE: "stale_state",
  SESSION_PROJECT_MISMATCH: "stale_state",
  PROJECT_ARCHIVED: "stale_state",
  SESSION_HAS_NO_PRIMARY_THREAD: "stale_state",
  SESSION_PRIMARY_THREAD_AMBIGUOUS: "stale_state",
  APPROVAL_NOT_PENDING: "stale_state",
  APPROVAL_ALREADY_DECIDED: "stale_state",
  WORKSPACE_MAPPING_CONFLICT: "stale_state",
  VALIDATION_ERROR: "validation",
  ATTACHMENT_INVALID: "validation",
  ATTACHMENT_TOO_LARGE: "validation",
  LOGIN_NAME_TAKEN: "validation",
  ORIGIN_REJECTED: "forbidden",
  NOT_FOUND: "not_found",
  DEPENDENCY_UNAVAILABLE: "upstream_unavailable",
  RUNTIME_UNAVAILABLE: "runtime_failed",
  RUNTIME_REQUEST_FAILED: "runtime_failed",
  SHUTDOWN_UNAVAILABLE: "runtime_failed",
  INTERNAL_ERROR: "runtime_failed",
};

const STATUS_KINDS: Record<number, FailureKind> = {
  400: "validation",
  401: "auth_expired",
  403: "forbidden",
  404: "not_found",
  409: "version_conflict",
  413: "validation",
  500: "runtime_failed",
  502: "upstream_unavailable",
  503: "upstream_unavailable",
  504: "upstream_unavailable",
};

interface CauseDetails {
  status: number | null;
  code: string | null;
  message: string | null;
  details: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function numberValue(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractCauseDetails(cause: unknown): CauseDetails {
  const record = asRecord(cause);
  const nestedError = asRecord(record?.["error"]);
  const details = asRecord(nestedError?.["details"]) ?? asRecord(record?.["details"]);
  return {
    status:
      numberValue(record, "status") ??
      numberValue(record, "statusCode") ??
      numberValue(nestedError, "status") ??
      null,
    code: stringValue(record, "code") ?? stringValue(nestedError, "code"),
    message:
      cause instanceof Error
        ? cause.message
        : stringValue(record, "message") ?? stringValue(nestedError, "message"),
    details,
  };
}

function isCancelled(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === "AbortError") return true;
  const record = asRecord(cause);
  return cause instanceof Error && cause.name === "AbortError"
    ? true
    : record?.["aborted"] === true || asRecord(record?.["signal"])?.["aborted"] === true;
}

function fallbackMessage(kind: FailureKind): string {
  const messages: Record<FailureKind, string> = messagesFor(currentLocale()).feedback.fallback;
  return messages[kind];
}

function failure(
  kind: FailureKind,
  details: CauseDetails,
  cause: unknown,
): Failure {
  return {
    kind,
    status: details.status,
    code: details.code,
    message: kind === "transport_unknown"
      ? fallbackMessage(kind)
      : details.message?.trim() || fallbackMessage(kind),
    details: details.details,
    cause,
  };
}

/**
 * 仅在没有 code 时使用 HTTP status 兜底；带未知 code 的远端响应不能被状态码误判。
 */
export function classifyFailure(cause: unknown): Failure {
  if (isCancelled(cause)) {
    return failure("cancelled", extractCauseDetails(cause), cause);
  }

  const details = extractCauseDetails(cause);
  if (details.code !== null) {
    return failure(CODE_KINDS[details.code] ?? "unknown", details, cause);
  }
  if (details.status !== null) {
    return failure(STATUS_KINDS[details.status] ?? "unknown", details, cause);
  }
  if (cause instanceof TypeError) {
    return failure("transport_unknown", details, cause);
  }
  return failure("unknown", details, cause);
}
