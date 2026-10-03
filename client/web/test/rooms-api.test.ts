import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("房间 API（只经本机 /api/v2，一比一转发远程同名端点）", () => {
  it("消息分页：after / before / threadRootId / limit 拼进查询串，id 转义", async () => {
    const fetch = vi.fn(async () => json({ items: [], hasMoreBefore: false, hasMoreAfter: false, lastSeq: 0 }));
    vi.stubGlobal("fetch", fetch);
    await api.listRoomMessages("room/1", { after: 12, limit: 50 });
    await api.listRoomMessages("room/1", { threadRootId: "m 2", limit: 200 });
    await api.listRoomMessages("room/1", { before: 3 });
    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "/api/v2/rooms/room%2F1/messages?after=12&limit=50",
      "/api/v2/rooms/room%2F1/messages?threadRootId=m+2&limit=200",
      "/api/v2/rooms/room%2F1/messages?before=3",
    ]);
  });

  it("发消息带 clientId；201 新建与 200 合并都按消息返回", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ id: "m-1", clientId: "c-1" }, 201)).mockResolvedValueOnce(json({ id: "m-1", clientId: "c-1" }, 200));
    vi.stubGlobal("fetch", fetch);
    const body = { clientId: "c-1", body: "收到", threadRootId: null };
    await expect(api.sendRoomMessage("room-1", body)).resolves.toMatchObject({ id: "m-1" });
    await expect(api.sendRoomMessage("room-1", body)).resolves.toMatchObject({ id: "m-1" });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v2/rooms/room-1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("记已读、共享、任务的端点", async () => {
    const fetch = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetch);
    await api.markRoomRead("room-1", 9);
    await api.openAgentShare("room-1", { agentId: "a-1", duration: "two_hours" });
    await api.closeAgentShare("share-1");
    await api.requestAgentShare("room-1", "a-2");
    await api.resolveShareRequest("req-1", { action: "ignore" });
    await api.stopAgentRun("run-1");
    await api.retryAgentRun("run-1");
    await api.getSelfAgent();
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${String(init.method)} ${url}`)).toEqual([
      "POST /api/v2/rooms/room-1/read",
      "POST /api/v2/rooms/room-1/shares",
      "POST /api/v2/agent-shares/share-1/close",
      "POST /api/v2/rooms/room-1/share-requests",
      "POST /api/v2/share-requests/req-1/resolve",
      "POST /api/v2/agent-runs/run-1/stop",
      "POST /api/v2/agent-runs/run-1/retry",
      "GET /api/v2/agents/self",
    ]);
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ upToSeq: 9 });
  });

  it("文件地址：图片 / 视频内联，其他下载", () => {
    expect(api.roomFileUrl("f 1", "inline")).toBe("/api/v2/room-files/f%201/content?disposition=inline");
    expect(api.roomFileUrl("f 1")).toBe("/api/v2/room-files/f%201/content");
  });

  it("超过 300 MB 的文件不上传", async () => {
    const file = new File(["x"], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 314_572_801 });
    await expect(api.uploadRoomFile("room-1", file, () => undefined)).rejects.toMatchObject({ status: 413 });
  });
});
