import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("API 客户端幂等键", () => {
  it("写请求自动带 Idempotency-Key，读请求不带", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "c1", body: "正文" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await api.createRequirementComment("r1", { body: "正文" });
    await api.getSessionContext("s1");

    const writeHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const readHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(writeHeaders.get("Idempotency-Key")).toMatch(/\S+/);
    expect(readHeaders.get("Idempotency-Key")).toBeNull();
  });

  it("会话上下文走 /api/v1/sessions/:id/context", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ sessionId: "s 1", kind: "none", contextMode: null, remoteProjectId: null, requirement: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getSessionContext("s 1")).resolves.toMatchObject({ kind: "none" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions/s%201/context");
  });
});
