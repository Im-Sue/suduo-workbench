import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { EventRepository } from "../infrastructure/db/repositories/event-repository.js";
import type { EventBroker } from "./event-broker.js";

const MAX_LIVE_BUFFER_BYTES = 1024 * 1024;

export class SseBufferOverflowError extends Error {
  constructor() {
    super("SSE live buffer exceeded 1 MiB");
    this.name = "SseBufferOverflowError";
  }
}

/**
 * 一条 SSE 连接上交付的帧：账本事件，或不入账本、无 seq 的传输控制帧。
 *
 * `stream.live`（PR3）：回放账本结束、切到实时之前发一次，告诉本连接「从这以后到的
 * 才是实时」。客户端分不出回放与实时（同一条连接先回放再直通），计时锚点只能认这个边界。
 * 它不是事件：不进账本、不进缓存、不带 seq；序列化必须走 `formatSseControlFrame`，
 * 否则 `id:` 行会污染浏览器的 Last-Event-ID。
 */
export type SessionStreamFrame =
  | { kind: "event"; event: EventEnvelope<string, JsonValue> }
  | { kind: "control"; type: "stream.live" };

export class SessionEventStream {
  constructor(
    private readonly events: EventRepository,
    private readonly broker: EventBroker,
    private readonly replayPageSize = 500,
  ) {}

  async *open(input: {
    sessionId: string;
    after: number;
    signal: AbortSignal;
  }): AsyncIterable<SessionStreamFrame> {
    const buffered: EventEnvelope<string, JsonValue>[] = [];
    const live = new EventQueue(input.signal);
    let directLive = false;
    const unsubscribe = this.broker.subscribe(input.sessionId, (event) => {
      if (directLive) {
        live.push(event);
      } else {
        buffered.push(event);
      }
    });
    let lastSent = input.after;
    try {
      const highWater = this.events.maxSeq(input.sessionId);
      while (lastSent < highWater && !input.signal.aborted) {
        const page = this.events.listRange(
          input.sessionId,
          lastSent,
          highWater,
          this.replayPageSize,
        );
        if (page.length === 0) {
          break;
        }
        for (const event of page) {
          if (event.seq > lastSent) {
            lastSent = event.seq;
            yield { kind: "event", event };
          }
        }
      }

      // 回放到此为止。`buffered` 里的都是本连接打开之后实时到达的，算边界之后。
      // 空账本、after 已是最新同样要发——边界的意义是「回放结束」，不是「回放过东西」。
      if (input.signal.aborted) {
        return;
      }
      yield { kind: "control", type: "stream.live" };

      while (!input.signal.aborted) {
        const pending = buffered
          .splice(0)
          .sort((left, right) => left.seq - right.seq);
        for (const event of pending) {
          if (event.seq > lastSent) {
            lastSent = event.seq;
            yield { kind: "event", event };
          }
        }
        if (buffered.length === 0) {
          directLive = true;
          break;
        }
      }

      while (!input.signal.aborted) {
        const event = await live.shift();
        if (!event) {
          return;
        }
        if (event.seq > lastSent) {
          lastSent = event.seq;
          yield { kind: "event", event };
        }
      }
    } finally {
      unsubscribe();
      live.close();
    }
  }

  /**
   * 账本历史的紧凑只读分页。SSE 仍保留完整事件及既有 after 语义；
   * 该读取专供缓存截断后的窗口补头。
   */
  backfill(input: {
    sessionId: string;
    after: number;
    until: number;
    limit: number;
  }): EventEnvelope<string, JsonValue>[] {
    return this.events.listBackfill(
      input.sessionId,
      input.after,
      input.until,
      input.limit,
    );
  }
}

class EventQueue {
  private readonly values: EventEnvelope<string, JsonValue>[] = [];
  private readonly waiters: Array<
    (event: EventEnvelope<string, JsonValue> | null) => void
  > = [];
  private bufferedBytes = 0;
  private closed = false;
  private failure: Error | null = null;

  constructor(signal: AbortSignal) {
    if (signal.aborted) {
      this.close();
    } else {
      signal.addEventListener("abort", () => this.close(), { once: true });
    }
  }

  push(event: EventEnvelope<string, JsonValue>): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.bufferedBytes += Buffer.byteLength(JSON.stringify(event));
    if (this.bufferedBytes > MAX_LIVE_BUFFER_BYTES) {
      this.failure = new SseBufferOverflowError();
      this.close();
      return;
    }
    this.values.push(event);
  }

  shift(): Promise<EventEnvelope<string, JsonValue> | null> {
    const value = this.values.shift();
    if (value) {
      this.bufferedBytes -= Buffer.byteLength(JSON.stringify(value));
      return Promise.resolve(value);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }
}

export function formatSseEvent(
  event: EventEnvelope<string, JsonValue>,
): string {
  return (
    "id: " +
    String(event.seq) +
    "\nevent: " +
    event.type +
    "\ndata: " +
    JSON.stringify(event) +
    "\n\n"
  );
}

/**
 * 控制帧的序列化：有 `data:`（没有 data 的帧浏览器不派发）、有 `event:`，
 * **没有 `id:` 行**——既不能写 `id: undefined`（会被存成 Last-Event-ID 并在重连时带回），
 * 也不能写空 `id:`（会把浏览器已记的游标清空）。账本事件仍走 `formatSseEvent`，字节不变。
 */
export function formatSseControlFrame(
  frame: Extract<SessionStreamFrame, { kind: "control" }>,
): string {
  return "event: " + frame.type + "\ndata: {}\n\n";
}

export function formatSseHeartbeat(now = Date.now()): string {
  return ": ping " + String(now) + "\n\n";
}
