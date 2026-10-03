import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
  LocalAgentStateDto,
} from "@suduo/client-contracts";
import { ApiError } from "../src/application/api-error.js";
import { RemoteEventsHub } from "../src/application/remote-events-hub.js";
import { RequirementsCredentialStore } from "../src/infrastructure/requirements-v2/credential-store.js";
import { RequirementsRemoteClient } from "../src/infrastructure/requirements-v2/remote-client.js";
import { RequirementsSettingsStore } from "../src/infrastructure/requirements-v2/settings-store.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * 本机 `/api/v2/*` 房间端点一比一转发（技术设计第七节）：状态码与正文原样、错误码同一套映射、
 * 没有请求体的端点不带体、房间文件上传流式转发、下载透传 Range（206 / 416）与缓存头；
 * `GET /api/v2/events` 订阅单一上游连接。
 */

const BASE_URL = "https://requirements.test";
const temporaryPaths: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    throw new Error("unused");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("unused");
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {}
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

const FILE = Buffer.from("0123456789");
/** 本机服务只接受 loopback 同源写请求。 */
const WRITE_HEADERS = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" };

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "suduo-rooms-routes-"));
  temporaryPaths.push(directory);
  const settings = new RequirementsSettingsStore(directory, BASE_URL);
  const credentials = new RequirementsCredentialStore(directory);
  credentials.save({
    baseUrl: BASE_URL,
    accessToken: "token-1",
    expiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    user: { id: "user-dev", displayName: "陈思远", loginName: "dev", createdAt: "2026-09-01T00:00:00.000Z" },
  });
  const requests: RecordedRequest[] = [];
  let upstream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const client = new RequirementsRemoteClient(settings, credentials, async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    let body: string | null = null;
    if (typeof init?.body === "string") {
      body = init.body;
    } else if (init?.body) {
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString("utf8");
    }
    const method = init?.method ?? "GET";
    requests.push({ method, url, headers, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const path = url.pathname;
    if (path === "/v2/events") {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          upstream = controller;
          controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"epoch":"e1"}\n\n'));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/v2/rooms/room-1/messages" && method === "GET") {
      return json(200, { items: [], hasMoreBefore: false, hasMoreAfter: false, lastSeq: 9 });
    }
    if (path === "/v2/rooms/room-1/messages" && method === "POST") {
      const parsed = JSON.parse(body ?? "{}") as { clientId: string };
      return json(parsed.clientId === "retry" ? 200 : 201, { id: "m-1", clientId: parsed.clientId });
    }
    if (path === "/v2/rooms/archived/messages" && method === "POST") {
      return json(409, { error: { code: "ROOM_ARCHIVED", message: "room archived", requestId: "r" } });
    }
    if (path === "/v2/agent-runs/run-1/stop") {
      return json(200, { id: "run-1", status: "stopped" });
    }
    if (path === "/v2/requirements/req-1/rooms" && method === "POST") {
      return json(201, { id: "room-new" });
    }
    if (path === "/v2/rooms/room-1/files" && method === "POST") {
      return json(201, { id: "f-new", size: body?.length ?? 0 });
    }
    if (path === "/v2/room-files/f-1/content") {
      const range = headers.get("range");
      if (headers.get("if-none-match") === '"sha"') {
        return new Response(null, { status: 304, headers: { etag: '"sha"' } });
      }
      if (range === "bytes=20-") {
        return new Response(null, { status: 416, headers: { "content-range": "bytes */10" } });
      }
      const common = {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        etag: '"sha"',
        "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": url.searchParams.get("disposition") === "inline" ? 'inline; filename="a.mp4"' : 'attachment; filename="a.mp4"',
      };
      if (range === "bytes=2-5") {
        return new Response(new Uint8Array(FILE.subarray(2, 6)), {
          status: 206,
          headers: { ...common, "content-range": "bytes 2-5/10", "content-length": "4" },
        });
      }
      return new Response(new Uint8Array(FILE), { status: 200, headers: { ...common, "content-length": "10" } });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "nope", requestId: "r" } });
  });
  const agentState: LocalAgentStateDto = {
    status: "ready",
    agent: null,
    message: null,
    activeRun: null,
    queuedRuns: 0,
  };
  const hub = new RemoteEventsHub({
    openEvents: (signal, options) => client.openEvents(signal, options),
    connectionState: () => {
      const session = credentials.getForBaseUrl(BASE_URL);
      return session === null
        ? { state: "none", error: new ApiError(401, "AUTH_INVALID", "请先登录远程需求服务") }
        : { state: "ready", identity: BASE_URL };
    },
    heartbeatMs: 60_000,
    log: () => undefined,
  });
  const context = createMinimalHttpContext(new IdleRuntime(), {
    rooms: { remote: client, agentState: () => agentState },
    remoteEvents: hub,
  });
  closers.push(async () => {
    hub.stop();
    await context.close();
  });
  return {
    context,
    hub,
    requests,
    credentials,
    pushUpstream: (text: string) => upstream?.enqueue(new TextEncoder().encode(text)),
  };
}

describe("房间端点一比一转发", () => {
  it("JSON 端点：查询串与正文原样转发，201 / 200 原样透传，带登录凭证", async () => {
    const { context, requests } = setup();
    const list = await context.server.inject({ method: "GET", url: "/api/v2/rooms/room-1/messages?after=5&limit=20" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ lastSeq: 9 });
    expect(requests[0]!.url.search).toBe("?after=5&limit=20");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer token-1");

    const created = await context.server.inject({
      method: "POST",
      url: "/api/v2/rooms/room-1/messages",
      headers: WRITE_HEADERS,
      payload: { clientId: "c-1", body: "你好" },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(requests[1]!.body!)).toEqual({ clientId: "c-1", body: "你好" });
    const merged = await context.server.inject({
      method: "POST",
      url: "/api/v2/rooms/room-1/messages",
      headers: WRITE_HEADERS,
      payload: { clientId: "retry", body: "你好" },
    });
    expect(merged.statusCode).toBe(200);
  });

  it("错误码同一套映射：房间已归档 → 409「房间已归档，只能查看」", async () => {
    const { context } = setup();
    const response = await context.server.inject({
      method: "POST",
      url: "/api/v2/rooms/archived/messages",
      headers: WRITE_HEADERS,
      payload: { clientId: "c-1", body: "x" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "ROOM_ARCHIVED", message: "房间已归档，只能查看" } });
  });

  it("没有请求体的端点（start / stop / retry / close）不带体与 Content-Type；建需求房间可以不带体", async () => {
    const { context, requests } = setup();
    const stopped = await context.server.inject({ method: "POST", url: "/api/v2/agent-runs/run-1/stop", headers: WRITE_HEADERS, payload: {} });
    expect(stopped.statusCode).toBe(200);
    expect(requests[0]!.body).toBeNull();
    expect(requests[0]!.headers.get("content-type")).toBeNull();

    const room = await context.server.inject({ method: "POST", url: "/api/v2/requirements/req-1/rooms", headers: WRITE_HEADERS });
    expect(room.statusCode).toBe(201);
    expect(requests[1]!.body).toBeNull();
    expect(requests[1]!.headers.get("content-type")).toBeNull();
  });

  it("房间文件上传：multipart 流式转发，状态码原样", async () => {
    const { context, requests } = setup();
    const payload = "--fixture\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--fixture--\r\n";
    const response = await context.server.inject({
      method: "POST",
      url: "/api/v2/rooms/room-1/files",
      headers: { ...WRITE_HEADERS, "content-type": "multipart/form-data; boundary=fixture", "x-attachment-size": "5" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "f-new" });
    expect(requests[0]!.body).toBe(payload);
    expect(requests[0]!.headers.get("content-type")).toBe("multipart/form-data; boundary=fixture");
    expect(requests[0]!.headers.get("x-attachment-size")).toBe("5");

    const wrong = await context.server.inject({
      method: "POST",
      url: "/api/v2/rooms/room-1/files",
      headers: WRITE_HEADERS,
      payload: { not: "multipart" },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it("房间文件下载：Range 透传，206 / Content-Range / Accept-Ranges / Content-Type / Content-Disposition 原样；416 与 304 也原样", async () => {
    const { context, requests } = setup();
    const partial = await context.server.inject({
      method: "GET",
      url: "/api/v2/room-files/f-1/content?disposition=inline",
      headers: { range: "bytes=2-5" },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("2345");
    expect(partial.headers["content-range"]).toBe("bytes 2-5/10");
    expect(partial.headers["accept-ranges"]).toBe("bytes");
    expect(partial.headers["content-type"]).toBe("video/mp4");
    expect(partial.headers["content-disposition"]).toBe('inline; filename="a.mp4"');
    expect(partial.headers["etag"]).toBe('"sha"');
    expect(partial.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(partial.headers["x-content-type-options"]).toBe("nosniff");
    expect(requests[0]!.url.searchParams.get("disposition")).toBe("inline");
    expect(requests[0]!.headers.get("range")).toBe("bytes=2-5");

    const whole = await context.server.inject({ method: "GET", url: "/api/v2/room-files/f-1/content" });
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe("0123456789");
    expect(whole.headers["content-disposition"]).toBe('attachment; filename="a.mp4"');

    const outOfRange = await context.server.inject({
      method: "GET",
      url: "/api/v2/room-files/f-1/content",
      headers: { range: "bytes=20-" },
    });
    expect(outOfRange.statusCode).toBe(416);
    expect(outOfRange.headers["content-range"]).toBe("bytes */10");

    const cached = await context.server.inject({
      method: "GET",
      url: "/api/v2/room-files/f-1/content",
      headers: { "if-none-match": '"sha"' },
    });
    expect(cached.statusCode).toBe(304);
  });

  it("接收器专用端点（登记、心跳、开始 / 进度 / 完成 / 收尾、任务列表）不给浏览器开代理", async () => {
    const { context, requests } = setup();
    for (const [method, url] of [
      ["POST", "/api/v2/agents"],
      ["POST", "/api/v2/agents/agent-1/heartbeat"],
      ["GET", "/api/v2/agent-runs"],
      ["POST", "/api/v2/agent-runs/run-1/start"],
      ["POST", "/api/v2/agent-runs/run-1/progress"],
      ["POST", "/api/v2/agent-runs/run-1/complete"],
      ["POST", "/api/v2/agent-runs/run-1/finish"],
    ] as const) {
      const response = await context.server.inject({ method, url, headers: WRITE_HEADERS, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(requests).toHaveLength(0);
  });

  it("GET /api/v2/agents/self 是本机端点，不经远程", async () => {
    const { context, requests } = setup();
    const response = await context.server.inject({ method: "GET", url: "/api/v2/agents/self" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", agent: null, message: null, activeRun: null, queuedRuns: 0 });
    expect(requests).toHaveLength(0);
  });

  it("GET /api/v2/events 订阅单一上游：两个标签页共用一条上游连接，帧原样转发", async () => {
    const { context, hub, requests, pushUpstream, credentials } = setup();
    const baseUrl = await context.listen();
    const first = new AbortController();
    const second = new AbortController();
    const decoder = new TextDecoder();
    const texts = ["", ""];
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    const readUntil = async (index: number, needle: string) => {
      while (!texts[index]!.includes(needle)) {
        const next = await Promise.race([
          readers[index]!.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`timeout waiting for ${needle}; got: ${texts[index]!}`)), 3_000),
          ),
        ]);
        if (next.done) throw new Error("stream ended");
        texts[index] += decoder.decode(next.value, { stream: true });
      }
    };
    // 第一个标签页把上游拉起来；上游连上时给已连着的页面发 room-resync。
    const firstResponse = await fetch(baseUrl + "/api/v2/events", { signal: first.signal });
    expect(firstResponse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    readers.push(firstResponse.body!.getReader());
    await readUntil(0, "event: room-resync");
    // 第二个标签页共用同一条上游。
    const secondResponse = await fetch(baseUrl + "/api/v2/events", { signal: second.signal });
    readers.push(secondResponse.body!.getReader());
    await readUntil(1, "retry: 3000");
    pushUpstream('event: room\nid: 5\ndata: {"id":5,"type":"room.message"}\n\n');
    await readUntil(0, '{"id":5,"type":"room.message"}');
    await readUntil(1, '{"id":5,"type":"room.message"}');
    expect(requests.filter((request) => request.url.pathname === "/v2/events")).toHaveLength(1);
    expect(hub.browserClientCount()).toBe(2);

    first.abort();
    await readers[0]!.cancel().catch(() => undefined);
    const deadline = Date.now() + 2_000;
    while (hub.browserClientCount() !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hub.browserClientCount()).toBe(1);
    second.abort();
    await readers[1]!.cancel().catch(() => undefined);

    // 没登录时浏览器连不上（页面据此回登录页）。
    credentials.clear();
    const denied = await context.server.inject({ method: "GET", url: "/api/v2/events" });
    expect(denied.statusCode).toBe(401);
  });
});
