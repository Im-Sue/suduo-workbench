import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/feedback/classify.js";
import type { FailureKind } from "../src/feedback/types.js";

const EMITTED_ERROR_FIXTURES: Array<{
  status: number;
  code: string;
  kind: FailureKind;
}> = [
  { status: 400, code: "ATTACHMENT_INVALID", kind: "validation" },
  { status: 400, code: "VALIDATION_ERROR", kind: "validation" },
  { status: 401, code: "AUTH_INVALID", kind: "auth_expired" },
  { status: 401, code: "AUTH_REQUIRED", kind: "auth_expired" },
  { status: 401, code: "LOGIN_CREDENTIALS_INVALID", kind: "auth_expired" },
  { status: 403, code: "ORIGIN_REJECTED", kind: "forbidden" },
  { status: 403, code: "VALIDATION_ERROR", kind: "validation" },
  { status: 404, code: "NOT_FOUND", kind: "not_found" },
  { status: 409, code: "APPROVAL_ALREADY_DECIDED", kind: "stale_state" },
  { status: 409, code: "APPROVAL_NOT_PENDING", kind: "stale_state" },
  { status: 409, code: "ATTACHMENT_INVALID", kind: "validation" },
  { status: 409, code: "AUTH_INVALID", kind: "auth_expired" },
  { status: 409, code: "IDEMPOTENCY_CONFLICT", kind: "stale_state" },
  { status: 409, code: "IDEMPOTENCY_INDETERMINATE", kind: "stale_state" },
  { status: 409, code: "LOGIN_NAME_TAKEN", kind: "validation" },
  { status: 409, code: "PROJECT_ARCHIVED", kind: "stale_state" },
  { status: 409, code: "PROJECT_HAS_ACTIVE_SESSIONS", kind: "stale_state" },
  { status: 409, code: "REMOTE_SERVICE_NOT_CONFIGURED", kind: "not_configured" },
  { status: 409, code: "RUNTIME_REQUEST_FAILED", kind: "runtime_failed" },
  { status: 409, code: "SESSION_NOT_ACTIVE", kind: "stale_state" },
  { status: 409, code: "SESSION_HAS_NO_PRIMARY_THREAD", kind: "stale_state" },
  { status: 409, code: "SESSION_PRIMARY_THREAD_AMBIGUOUS", kind: "stale_state" },
  { status: 409, code: "SESSION_PROJECT_MISMATCH", kind: "stale_state" },
  { status: 409, code: "SHUTDOWN_UNAVAILABLE", kind: "runtime_failed" },
  { status: 409, code: "VALIDATION_ERROR", kind: "validation" },
  { status: 409, code: "VERSION_CONFLICT", kind: "version_conflict" },
  { status: 409, code: "WORKSPACE_MAPPING_CONFLICT", kind: "stale_state" },
  { status: 409, code: "WORKSPACE_MAPPING_REQUIRED", kind: "not_configured" },
  { status: 413, code: "ATTACHMENT_TOO_LARGE", kind: "validation" },
  { status: 500, code: "INTERNAL_ERROR", kind: "runtime_failed" },
  { status: 500, code: "RUNTIME_REQUEST_FAILED", kind: "runtime_failed" },
  { status: 502, code: "DEPENDENCY_UNAVAILABLE", kind: "upstream_unavailable" },
  { status: 502, code: "RUNTIME_REQUEST_FAILED", kind: "runtime_failed" },
  { status: 503, code: "DEPENDENCY_UNAVAILABLE", kind: "upstream_unavailable" },
  { status: 503, code: "RUNTIME_REQUEST_FAILED", kind: "runtime_failed" },
  { status: 503, code: "RUNTIME_UNAVAILABLE", kind: "runtime_failed" },
  { status: 504, code: "RUNTIME_REQUEST_FAILED", kind: "runtime_failed" },
];

describe("classifyFailure", () => {
  it("从 requirements-service 与 BFF 的 37 个静态 (status, code) 发码点推导分类", () => {
    for (const fixture of EMITTED_ERROR_FIXTURES) {
      expect(classifyFailure({ ...fixture, message: fixture.code })).toMatchObject({
        kind: fixture.kind,
        status: fixture.status,
        code: fixture.code,
      });
    }
  });

  it("取消优先于 code/status，且未知 code 不被状态码误判", () => {
    const controller = new AbortController();
    controller.abort();
    expect(classifyFailure({ status: 409, code: "VERSION_CONFLICT", signal: controller.signal }).kind)
      .toBe("cancelled");
    expect(classifyFailure({ status: 409, code: "FUTURE_REMOTE_CODE" }).kind).toBe("unknown");
  });

  it("无 code 时才按 status 兜底；裸 TypeError 使用中性连接文案", () => {
    expect(classifyFailure({ status: 404 }).kind).toBe("not_found");
    const failure = classifyFailure(new TypeError("Failed to fetch"));
    expect(failure.kind).toBe("transport_unknown");
    expect(failure.message).toBe("暂时无法连接工作台，请稍后重试");
  });

  it("浏览器网络错误不泄漏原始归因信息", () => {
    const failure = classifyFailure(
      new TypeError("NetworkError when attempting to fetch resource."),
    );
    expect(failure.kind).toBe("transport_unknown");
    expect(failure.message).not.toMatch(/网络|Network|启动|CORS|防火墙|代理|fetch/i);
  });
});
