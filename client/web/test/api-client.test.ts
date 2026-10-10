import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("会话删除 API", () => {
  it("以转义后的 id 调用 DELETE，并接受 204 空响应", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => "delete-key" });

    await expect(api.deleteSession("session/a b")).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/sessions/session%2Fa%20b",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "Idempotency-Key": "delete-key" }),
      }),
    );
    await api.deleteSession("s1", { withChildren: true });
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/v1/sessions/s1?withChildren=true");
  });
});

describe("概览与工作台 BFF API", () => {
  it("只经本机 /api/v2 访问 stats、workbench 和按项目过滤的审计", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetch);

    await api.getProjectStats("project/a", { window: "30d", tz: "Asia/Shanghai" });
    await api.getMyWorkbench();
    await api.listRequirementsAudit({ projectId: "project/a" });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/v2/projects/project%2Fa/stats?window=30d&tz=Asia%2FShanghai",
      "/api/v2/my/workbench",
      "/api/v2/audit?projectId=project%2Fa",
    ]);
  });
});
