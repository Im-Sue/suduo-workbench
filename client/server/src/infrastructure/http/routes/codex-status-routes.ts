import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CodexGlobalState,
  type CodexGlobalStatus,
} from "../../../application/codex-global-state.js";

export interface CodexStatusRouteDependencies {
  codexGlobalState?: CodexGlobalState;
  sseHeartbeatMs?: number;
  activity?: { retainStream(): () => void };
}

/** D7 的首条 routes/ 接线缝；后续端点沿用此处的依赖注入范式。 */
export function registerCodexStatusRoutes(
  server: FastifyInstance,
  dependencies: CodexStatusRouteDependencies,
): void {
  const state = dependencies.codexGlobalState ?? new CodexGlobalState();
  server.get("/api/v1/codex/status", async (request, reply) => {
    const releaseStream = dependencies.activity?.retainStream();
    try {
      await streamCodexStatus(
        request,
        reply,
        state,
        dependencies.sseHeartbeatMs ?? 15_000,
      );
    } finally {
      releaseStream?.();
    }
  });
}

async function streamCodexStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  state: CodexGlobalState,
  heartbeatMs: number,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write("retry: 3000\n\n");

  const abort = new AbortController();
  request.raw.once("close", () => abort.abort());
  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) {
      reply.raw.write(": ping " + String(Date.now()) + "\n\n");
    }
  }, heartbeatMs);
  heartbeat.unref();

  const queue = new StatusQueue(abort.signal);
  const unsubscribe = state.subscribe((status) => queue.push(status));
  try {
    await writeWithTimeout(reply.raw, formatCodexStatus(state.snapshot()));
    while (!abort.signal.aborted) {
      const status = await queue.shift();
      if (status === null) {
        return;
      }
      await writeWithTimeout(reply.raw, formatCodexStatus(status));
    }
  } finally {
    unsubscribe();
    queue.close();
    clearInterval(heartbeat);
    abort.abort();
    if (!reply.raw.destroyed) {
      reply.raw.end();
    }
  }
}

export function formatCodexStatus(status: CodexGlobalStatus): string {
  return "event: status\ndata: " + JSON.stringify(status) + "\n\n";
}

class StatusQueue {
  private readonly values: CodexGlobalStatus[] = [];
  private readonly waiters: Array<(value: CodexGlobalStatus | null) => void> = [];
  private closed = false;

  constructor(signal: AbortSignal) {
    signal.addEventListener("abort", () => this.close(), { once: true });
  }

  push(status: CodexGlobalStatus): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(status);
      return;
    }
    this.values.push(status);
  }

  shift(): Promise<CodexGlobalStatus | null> {
    const status = this.values.shift();
    if (status) {
      return Promise.resolve(status);
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

async function writeWithTimeout(
  response: ServerResponse,
  chunk: string,
): Promise<void> {
  if (response.write(chunk)) {
    return;
  }
  await Promise.race([
    once(response, "drain"),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SSE client blocked for 30 seconds")),
        30_000,
      );
      timer.unref();
    }),
  ]);
}
