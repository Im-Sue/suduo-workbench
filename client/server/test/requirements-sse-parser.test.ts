import { describe, expect, it } from "vitest";
import {
  consumeServerSentEvents,
  ServerSentEventParser,
} from "../src/infrastructure/requirements-v2/sse-parser.js";

describe("requirements SSE parser", () => {
  it("跨任意 chunk、UTF-8 与 CRLF 边界解析多行 data，注释只续期", async () => {
    const events: unknown[] = [];
    const parser = new ServerSentEventParser((event) => { events.push(event); });
    const bytes = new TextEncoder().encode(
      ": heartbeat\r\nevent: update\r\nid: 7\r\ndata: {\"text\":\"中\r\ndata: 文\"}\r\n\r\n",
    );
    for (let index = 0; index < bytes.length; index += 1) {
      await parser.push(bytes.subarray(index, index + 1));
    }
    expect(events).toEqual([{
      event: "update",
      id: "7",
      data: "{\"text\":\"中\n文\"}",
    }]);
  });

  it("EOF 未以空行提交的事件必须丢弃", async () => {
    const events: unknown[] = [];
    const response = responseFrom(["data: {\"partial\":true}\n"]);
    await consumeServerSentEvents(response, { onEvent: (event) => { events.push(event); } });
    expect(events).toEqual([]);
  });

  it("校验 Content-Type，并把 ready 与心跳按普通 SSE 边界交给调用方", async () => {
    await expect(consumeServerSentEvents(new Response("data: nope\n\n"), { onEvent: () => undefined }))
      .rejects.toThrow("Content-Type");
    const events: string[] = [];
    let activity = 0;
    await consumeServerSentEvents(responseFrom([
      ": heartbeat\n\n",
      "event: ready\ndata: {}\n\n",
    ]), {
      onActivity: () => { activity += 1; },
      onEvent: (event) => { events.push(`${event.event}:${event.data}`); },
    });
    expect(events).toEqual(["ready:{}"]);
    expect(activity).toBe(2);
  });

  it("Abort 会取消仍在等待的 reader", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    const controller = new AbortController();
    const consuming = consumeServerSentEvents(response, {
      signal: controller.signal,
      onEvent: () => undefined,
    });
    controller.abort();
    await consuming;
    expect(cancelled).toBe(true);
  });
});

function responseFrom(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
