import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/application/api-error.js";
import { RemoteEventsHub, type RemoteEventsSignal } from "../src/application/remote-events-hub.js";

/**
 * 本机一条上游 `/v2/events` 扇出给全部浏览器（技术设计 4.3）：帧原样转发、ready 自己消费、
 * 上游每次连上发 room-resync、断线带 Last-Event-ID 与 epoch 重连、登录态没了断开浏览器。
 */

class FakeBrowser extends EventEmitter {
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
    this.emit("close");
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
  disconnect(): void {
    this.destroyed = true;
    this.emit("close");
  }
  text(): string {
    return this.chunks.join("");
  }
}

/** 可控的上游流：push 写 SSE 文本，close 结束。 */
class FakeUpstream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;
  constructor() {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
  push(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
  close(): void {
    this.controller.close();
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timeout: " + label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createHub(options: { authenticated?: () => boolean } = {}) {
  const opens: Array<{ lastEventId?: string; epoch?: string }> = [];
  const upstreams: FakeUpstream[] = [];
  const failures: unknown[] = [];
  let retained = 0;
  const signals: RemoteEventsSignal[] = [];
  const presence: boolean[] = [];
  const hub = new RemoteEventsHub({
    openEvents: async (_signal, eventOptions) => {
      opens.push(eventOptions);
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      const upstream = new FakeUpstream();
      upstreams.push(upstream);
      return upstream.response;
    },
    connectionState: () =>
      (options.authenticated?.() ?? true)
        ? { state: "ready", identity: "https://requirements.test" }
        : { state: "none", error: new ApiError(401, "AUTH_INVALID", "请先登录远程需求服务") },
    activity: {
      retainStream: () => {
        retained += 1;
        return () => {
          retained -= 1;
        };
      },
    },
    heartbeatMs: 60_000,
    backoffInitialMs: 5,
    backoffMaxMs: 20,
    onBrowserPresenceChanged: (active) => presence.push(active),
    log: () => undefined,
  });
  hub.subscribe((signal) => signals.push(signal));
  return {
    hub,
    opens,
    upstreams,
    failures,
    signals,
    presence,
    retained: () => retained,
    attach(): FakeBrowser {
      const browser = new FakeBrowser();
      hub.attachBrowser(browser as unknown as ServerResponse);
      return browser;
    },
  };
}

describe("RemoteEventsHub", () => {
  it("一条上游扇出给所有浏览器：需求事件无名、房间事件 event: room；ready 不转发；浏览器计数与常驻", async () => {
    const context = createHub();
    const first = context.attach();
    const second = context.attach();
    expect(context.hub.browserClientCount()).toBe(2);
    expect(context.retained()).toBe(2);
    expect(context.presence).toEqual([true]);
    await until(() => context.upstreams.length === 1, "upstream opened");
    expect(context.opens).toHaveLength(1);

    const upstream = context.upstreams[0]!;
    upstream.push('retry: 2000\nevent: ready\ndata: {"epoch":"e1"}\n\n');
    upstream.push('id: 7\ndata: {"type":"requirement.changed","projectId":"p1"}\n\n');
    upstream.push('event: room\nid: 8\ndata: {"id":8,"type":"room.message","roomId":"r1"}\n\n');
    await until(() => context.signals.filter((signal) => signal.type === "event").length === 2, "two events");

    for (const browser of [first, second]) {
      const text = browser.text();
      expect(text.startsWith("retry: 3000\n\n")).toBe(true);
      // 上游连上时先发 room-resync。
      expect(text).toContain("event: room-resync\ndata: {}\n\n");
      expect(text).toContain('id: 7\ndata: {"type":"requirement.changed","projectId":"p1"}\n\n');
      expect(text).toContain('event: room\nid: 8\ndata: {"id":8,"type":"room.message","roomId":"r1"}\n\n');
      expect(text).not.toContain("event: ready");
    }
    expect(context.signals[0]).toEqual({ type: "connected", reconnect: false });

    first.disconnect();
    expect(context.hub.browserClientCount()).toBe(1);
    expect(context.retained()).toBe(1);
    second.disconnect();
    expect(context.presence).toEqual([true, false]);
    expect(context.retained()).toBe(0);
    context.hub.stop();
  });

  it("上游断线后带 Last-Event-ID 与 epoch 重连，重连成功给浏览器发 room-resync", async () => {
    const context = createHub();
    const browser = context.attach();
    await until(() => context.upstreams.length === 1, "first");
    context.upstreams[0]!.push('event: ready\ndata: {"epoch":"e1"}\n\n');
    context.upstreams[0]!.push('event: room\nid: 41\ndata: {"id":41}\n\n');
    // 需求事件的 uuid id 不当断点（远程只按房间事件的数字序号补发）。
    context.upstreams[0]!.push('id: 0b7c6f1e-0000-4000-8000-000000000000\ndata: {"type":"comment.created"}\n\n');
    await until(() => context.signals.filter((signal) => signal.type === "event").length === 2, "events");
    context.upstreams[0]!.close();

    await until(() => context.upstreams.length === 2, "reconnected");
    expect(context.opens[1]).toEqual({ lastEventId: "41", epoch: "e1" });
    await until(
      () => context.signals.some((signal) => signal.type === "connected" && signal.reconnect),
      "reconnect signal",
    );
    expect(browser.text().match(/event: room-resync/gu)).toHaveLength(2);
    // 浏览器连接没有因为上游断线而断开。
    expect(browser.writableEnded).toBe(false);

    // 远程重启（epoch 变了）：旧断点作废，只带新 epoch；新一代的房间事件序号重新当断点。
    context.upstreams[1]!.push('event: ready\ndata: {"epoch":"e2"}\n\n');
    context.upstreams[1]!.push(": heartbeat\n\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    context.upstreams[1]!.close();
    await until(() => context.upstreams.length === 3, "third");
    expect(context.opens[2]).toEqual({ epoch: "e2" });
    context.upstreams[2]!.push('event: room\nid: 3\ndata: {"id":3}\n\n');
    await until(() => context.signals.filter((signal) => signal.type === "event").length === 3, "new epoch event");
    context.upstreams[2]!.close();
    await until(() => context.upstreams.length === 4, "fourth");
    expect(context.opens[3]).toEqual({ lastEventId: "3", epoch: "e2" });
    context.hub.stop();
  });

  it("连不上时按退避重试，浏览器连接照常保持（心跳在本机发）", async () => {
    const context = createHub();
    context.failures.push(new ApiError(503, "DEPENDENCY_UNAVAILABLE", "远程需求服务流连接不可用"));
    context.failures.push(new Error("ECONNREFUSED"));
    const browser = context.attach();
    await until(() => context.upstreams.length === 1, "eventually connected");
    expect(context.opens).toHaveLength(3);
    expect(browser.writableEnded).toBe(false);
    expect(context.hub.upstreamState()).toBe("live");
    context.hub.stop();
    expect(browser.writableEnded).toBe(true);
  });

  it("登录态没了（上游 401 或已退出）：停在 idle、断开浏览器；没登录时浏览器连不上", async () => {
    let authenticated = true;
    const context = createHub({ authenticated: () => authenticated });
    context.failures.push(new ApiError(401, "AUTH_INVALID", "登录凭证无效或已过期，请重新登录"));
    const browser = context.attach();
    await until(() => browser.writableEnded, "browser closed after 401");
    expect(context.hub.upstreamState()).toBe("idle");
    expect(context.hub.browserClientCount()).toBe(0);

    authenticated = false;
    expect(() => context.hub.assertBrowserCanConnect()).toThrow("请先登录");
    authenticated = true;
    context.hub.assertBrowserCanConnect();

    // 重新登录后 restart：重新连上。
    context.hub.restart();
    await until(() => context.upstreams.length === 1, "connected after login");
    context.hub.stop();
  });
});
