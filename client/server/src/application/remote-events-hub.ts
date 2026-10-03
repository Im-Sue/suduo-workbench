import type { ServerResponse } from "node:http";
import { ROOM_RESYNC_SSE_EVENT_NAME } from "@suduo/client-contracts";
import { ROOM_SSE_EVENT_NAME } from "@suduo/cloud-contracts";
import {
  consumeServerSentEvents,
  type ServerSentEvent,
} from "../infrastructure/requirements-v2/sse-parser.js";
import { ApiError } from "./api-error.js";

/**
 * 本机服务到远程 `/v2/events` 的**一条**上游推送连接（技术设计二、4.3；需求 4.9「多标签页共用」）：
 * - 登录后建立，断线按指数退避重连；重连时带 `Last-Event-ID` = 最后一个**房间事件**的数字序号
 *   （需求事件的 id 是 uuid，远程不按它补发）与 `?epoch=`，远程据此补发房间事件；
 * - 上游的每一帧原样转给所有浏览器连接（需求事件是无名事件、房间事件是 `event: room`）；
 * - 上游每次连上后给当时已连着的浏览器发 `event: room-resync`：断线期间的需求事件不补发、
 *   房间事件可能超出补发窗口或 epoch 变了，页面据此按房间序号补拉并刷新数据；
 * - 本机的房间任务接收器（RoomAgentRunner）通过 `subscribe` 拿同一份事件。
 * 上游没连上时浏览器连接照常保持（只有心跳注释帧）；登录态没了才断开浏览器连接，让页面回登录。
 */

/** 给订阅者的信号：上游的一帧，或上游刚连上。 */
export type RemoteEventsSignal =
  | { type: "event"; event: ServerSentEvent }
  | { type: "connected"; reconnect: boolean };

export type RemoteEventsListener = (signal: RemoteEventsSignal) => void;

export interface RemoteEventsHubDependencies {
  /** 打开上游流（RequirementsRemoteClient.openEvents）。 */
  openEvents(signal: AbortSignal, options: { lastEventId?: string; epoch?: string }): Promise<Response>;
  /**
   * 当前能不能连上游：none = 没配地址或没登录（不连，断开浏览器）；ready = 可以连。
   * `identity` 变化（换了服务地址）时丢掉断点续传的位置。
   */
  connectionState(): { state: "ready"; identity: string } | { state: "none"; error: ApiError };
  /** 浏览器连接期间保持本机服务不空闲退出。 */
  activity?: { retainStream(): () => void };
  /** 浏览器连接的心跳注释帧间隔。 */
  heartbeatMs?: number;
  /** 重连退避：起始与上限。 */
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** 打开着的页面从无到有 / 从有到无（本机 Agent 据此尽快发一次心跳）。 */
  onBrowserPresenceChanged?(active: boolean): void;
  log?(line: Record<string, unknown>): void;
}

interface BrowserClient {
  response: ServerResponse;
  heartbeat: NodeJS.Timeout;
  release: (() => void) | null;
}

/** 单个浏览器连接写缓冲超过这个量（慢消费者）就断开，让它自己重连补拉。 */
const BROWSER_BUFFER_LIMIT = 4 * 1024 * 1024;

export class RemoteEventsHub {
  private readonly clients = new Set<BrowserClient>();
  private readonly listeners = new Set<RemoteEventsListener>();
  private readonly heartbeatMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  /** 每次 restart / stop 换代；旧一代的循环看到代数变了就退出。 */
  private generation = 0;
  private loopAbort: AbortController | null = null;
  private state: "stopped" | "idle" | "connecting" | "live" | "backoff" = "stopped";
  /** 最后一个房间事件的序号（`event: room` 的数字 id）；不知道为 null。 */
  private lastRoomEventId: number | null = null;
  private epoch: string | undefined;
  private identity: string | null = null;
  private connectedOnce = false;

  constructor(private readonly deps: RemoteEventsHubDependencies) {
    this.heartbeatMs = deps.heartbeatMs ?? 15_000;
    this.backoffInitialMs = deps.backoffInitialMs ?? 1_000;
    this.backoffMaxMs = deps.backoffMaxMs ?? 30_000;
  }

  /** 启动（或在登录 / 退出 / 改服务地址 / 续期后重启）上游连接。 */
  restart(): void {
    this.generation += 1;
    this.loopAbort?.abort();
    const generation = this.generation;
    const abort = new AbortController();
    this.loopAbort = abort;
    void this.run(generation, abort.signal);
  }

  /** 关闭上游与全部浏览器连接（服务退出）。 */
  stop(): void {
    this.generation += 1;
    this.loopAbort?.abort();
    this.loopAbort = null;
    this.state = "stopped";
    this.closeBrowsers();
  }

  upstreamState(): "stopped" | "idle" | "connecting" | "live" | "backoff" {
    return this.state;
  }

  browserClientCount(): number {
    return this.clients.size;
  }

  subscribe(listener: RemoteEventsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 浏览器连接 `GET /api/v2/events`：没登录时抛错（页面据此回登录页，与旧行为一致）；
   * 否则挂上连接，直到浏览器断开。调用方已 hijack 响应。
   */
  assertBrowserCanConnect(): void {
    const connection = this.deps.connectionState();
    if (connection.state === "none") {
      throw connection.error;
    }
  }

  attachBrowser(response: ServerResponse): () => void {
    response.write("retry: 3000\n\n");
    const client: BrowserClient = {
      response,
      heartbeat: setInterval(() => {
        this.write(client, ": heartbeat\n\n");
      }, this.heartbeatMs),
      release: this.deps.activity?.retainStream() ?? null,
    };
    client.heartbeat.unref();
    this.clients.add(client);
    if (this.clients.size === 1) {
      this.deps.onBrowserPresenceChanged?.(true);
    }
    const detach = () => this.detach(client);
    response.once("close", detach);
    // 上游还没起来（例如本机服务刚启动、登录态刚恢复）时，顺手拉起来。
    if (this.state === "stopped" || this.state === "idle") {
      this.restart();
    }
    return detach;
  }

  private detach(client: BrowserClient): void {
    if (!this.clients.delete(client)) {
      return;
    }
    clearInterval(client.heartbeat);
    client.release?.();
    client.release = null;
    if (this.clients.size === 0) {
      this.deps.onBrowserPresenceChanged?.(false);
    }
  }

  private closeBrowsers(): void {
    for (const client of [...this.clients]) {
      this.detach(client);
      if (!client.response.destroyed) {
        client.response.end();
      }
    }
  }

  private write(client: BrowserClient, chunk: string): void {
    const response = client.response;
    if (response.destroyed || response.writableEnded) {
      this.detach(client);
      return;
    }
    if (response.writableLength > BROWSER_BUFFER_LIMIT) {
      // 慢消费者：断开，它会自动重连（重连后页面自己补拉）。
      this.detach(client);
      response.destroy();
      return;
    }
    response.write(chunk);
  }

  private broadcast(chunk: string): void {
    for (const client of [...this.clients]) {
      this.write(client, chunk);
    }
  }

  private notify(signal: RemoteEventsSignal): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(signal);
      } catch (error) {
        this.log({ event: "suduo.remote_events.listener_failed", message: messageOf(error) });
      }
    }
  }

  private async run(generation: number, signal: AbortSignal): Promise<void> {
    let backoffMs = this.backoffInitialMs;
    while (this.generation === generation && !signal.aborted) {
      const connection = this.deps.connectionState();
      if (connection.state === "none") {
        // 没登录 / 没配置：不连上游；已连着的浏览器断开，让页面按登录态处理。
        this.state = "idle";
        this.closeBrowsers();
        return;
      }
      if (this.identity !== connection.identity) {
        // 换了服务地址：旧的断点位置没有意义。
        this.identity = connection.identity;
        this.lastRoomEventId = null;
        this.epoch = undefined;
      }
      this.state = "connecting";
      let receivedAny = false;
      try {
        const response = await this.deps.openEvents(signal, {
          ...(this.lastRoomEventId === null ? {} : { lastEventId: String(this.lastRoomEventId) }),
          ...(this.epoch === undefined ? {} : { epoch: this.epoch }),
        });
        if (this.generation !== generation) {
          await response.body?.cancel().catch(() => undefined);
          return;
        }
        this.state = "live";
        const reconnect = this.connectedOnce;
        this.connectedOnce = true;
        backoffMs = this.backoffInitialMs;
        this.log({ event: "suduo.remote_events.connected", reconnect });
        // 上游断过（或浏览器在上游没连上时就连着）：需求事件不补发、房间事件可能有缺口，让页面补拉。
        this.broadcast(`event: ${ROOM_RESYNC_SSE_EVENT_NAME}\ndata: {}\n\n`);
        this.notify({ type: "connected", reconnect });
        await consumeServerSentEvents(response, {
          signal,
          onEvent: (event) => {
            receivedAny = true;
            this.handleUpstream(event);
          },
        });
        if (this.generation !== generation || signal.aborted) {
          return;
        }
        this.log({ event: "suduo.remote_events.closed_by_remote" });
      } catch (error) {
        if (this.generation !== generation || signal.aborted) {
          return;
        }
        if (isAuthError(error)) {
          // 401：远程客户端已清掉凭证；等用户重新登录（登录后会 restart）。
          this.log({ event: "suduo.remote_events.auth_lost" });
          this.state = "idle";
          this.closeBrowsers();
          return;
        }
        this.log({ event: "suduo.remote_events.connect_failed", message: messageOf(error), retryInMs: backoffMs });
      }
      this.state = "backoff";
      // 连上过且收到过数据的正常断线：从起始退避重连；连不上则逐次翻倍。
      const wait = receivedAny ? this.backoffInitialMs : backoffMs;
      await sleep(wait, signal);
      backoffMs = Math.min(backoffMs * 2, this.backoffMaxMs);
    }
  }

  private handleUpstream(event: ServerSentEvent): void {
    if (event.event === "ready") {
      // ready 帧由 hub 自己消费（记下 epoch），不转给浏览器：浏览器只认 room-resync。
      const epoch = readEpoch(event.data);
      if (epoch !== null && epoch !== this.epoch) {
        // 远程重启过（或第一次连上）：新一代序号从头来，旧断点作废；缺口由连上时的 room-resync 补。
        this.lastRoomEventId = null;
        this.epoch = epoch;
      }
      return;
    }
    if (event.event === ROOM_SSE_EVENT_NAME && event.id !== undefined && /^\d+$/u.test(event.id)) {
      this.lastRoomEventId = Number(event.id);
    }
    this.broadcast(formatFrame(event));
    this.notify({ type: "event", event });
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.info(JSON.stringify(value))))(line);
  }
}

/** 把解析后的帧还原成 SSE 文本（无名事件不写 event 行）。 */
export function formatFrame(event: ServerSentEvent): string {
  const lines: string[] = [];
  if (event.event !== "message") {
    lines.push(`event: ${event.event}`);
  }
  if (event.id !== undefined) {
    lines.push(`id: ${event.id}`);
  }
  for (const line of event.data.split("\n")) {
    lines.push(`data: ${line}`);
  }
  return lines.join("\n") + "\n\n";
}

function readEpoch(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const epoch = (parsed as Record<string, unknown>)["epoch"];
      if (typeof epoch === "string" && epoch !== "") return epoch;
      if (typeof epoch === "number" && Number.isFinite(epoch)) return String(epoch);
    }
  } catch {
    // 旧版远程的 ready 帧是 {}；没有 epoch 就不带。
  }
  return null;
}

function isAuthError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.statusCode === 401 || error.code === "AUTH_INVALID" || error.code === "AUTH_REQUIRED")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
