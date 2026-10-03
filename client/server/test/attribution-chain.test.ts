import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  EventEnvelope,
  JsonValue,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
} from "@suduo/client-contracts";
import { normalizeCodexNotification } from "../src/infrastructure/runtime/codex/codex-event-normalizer.js";
import {
  SseReader,
  createMinimalHttpContext,
  createProjectAndSession,
  postJson,
  type SseFrame,
} from "./helpers/minimal-http-context.js";

/**
 * PR2 归属机制整链（需求 4.2 / 4.7，技术设计 §二.1）：
 * POST 消息 → 服务端先入账 message.submitted（带 clientTurnId）→ Codex 通知经 normalizer
 * 原样保留 `item.clientId` 与真实 turnId → ingestor / 账本 → SSE 与 HTTP 回填两条读取路径。
 *
 * 前端 reducer 不在本包（server typecheck 的 rootDir 是 client/server），两层共享同一份静态
 * fixture：本测试证明真实链路产出的事件形状与 fixture 一致，web 的 reducer 测试消费同一份
 * fixture 证明归属判定正确。链路形状一变，这里先红，改 fixture 后 web 侧重验。
 */
const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "attribution-chain.events.json");
const THREAD_ID = "thread-1";
const REAL_TURN_ID = "turn-real-1";
const GHOST_TURN_ID = "turn-ghost-2";

describe("PR2 归属整链：clientId → 真实 turnId", () => {
  it("运行中发送：SSE 先于 HTTP 响应交付 userMessage item；两条读取路径与 fixture 一致", async () => {
    const runtime = new GatedRuntime();
    const context = createMinimalHttpContext(runtime);
    const sseAbort = new AbortController();
    let ordinal = 0;
    try {
      const base = await context.listen();
      const post = (url: string, key: string, body: unknown) => postJson(base, url, key, body);
      const { sessionId } = await createProjectAndSession(base, context.projectRoot);

      // SSE 先连上：之后到达的每条事件都会以实时路径推给这条连接。
      const sse = await fetch(`${base}/api/v1/sessions/${sessionId}/events?after=0`, { signal: sseAbort.signal });
      expect(sse.headers.get("content-type")).toContain("text/event-stream");
      const sseReader = new SseReader(sse);

      // 消息 A：空闲时发送，runtime 正常返回真实回合 id。
      const acceptedA = await post(`/api/v1/sessions/${sessionId}/messages`, "msg-a", {
        content: [{ type: "text", text: "把测试跑一遍" }],
      });
      expect(acceptedA.status).toBe(202);
      const bodyA = (await acceptedA.json()) as { clientTurnId?: string; turnRef: { turnId: string } };
      expect(bodyA.turnRef.turnId).toBe(REAL_TURN_ID);
      expect(typeof bodyA.clientTurnId).toBe("string");
      const clientA = bodyA.clientTurnId!;

      const codex = (method: string, params: JsonValue) =>
        context.ingestor.ingest(normalizeCodexNotification({
          runtimeId: runtime.runtimeId,
          connectionId: "conn-1",
          ordinal: ++ordinal,
          message: { kind: "notification", method, params },
        }));
      codex("turn/started", { threadId: THREAD_ID, turn: { id: REAL_TURN_ID, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
      codex("item/started", { threadId: THREAD_ID, turnId: REAL_TURN_ID, startedAtMs: 1, item: userMessageItem("item-a", clientA, "把测试跑一遍") });
      codex("item/completed", { threadId: THREAD_ID, turnId: REAL_TURN_ID, item: userMessageItem("item-a", clientA, "把测试跑一遍") });

      // 消息 B：回合运行中发送。runtime 的 startTurn 被挂起，HTTP 响应还没回来。
      const gate = deferred();
      runtime.holdNextStartTurn(gate.promise, GHOST_TURN_ID);
      let responded = false;
      const pendingB = post(`/api/v1/sessions/${sessionId}/messages`, "msg-b", {
        content: [{ type: "text", text: "顺便看下覆盖率" }],
      }).then((response) => {
        responded = true;
        return response;
      });
      // 服务端先入账 message.submitted 再启动 turn：从回填端点等到它，拿到 B 的关联键。
      const submittedB = await waitFor(async () => {
        const events = await backfill(base, sessionId);
        return events.find((event) => event.type === "message.submitted" && (event.payload as { clientTurnId?: string }).clientTurnId !== clientA) ?? null;
      });
      const clientB = String((submittedB.payload as { clientTurnId: string }).clientTurnId);
      expect(responded).toBe(false);

      // Codex 把 B 记进了正在跑的真实回合，随后回合以纯文本收尾（无任何工具步骤）。
      codex("item/started", { threadId: THREAD_ID, turnId: REAL_TURN_ID, startedAtMs: 2, item: userMessageItem("item-b", clientB, "顺便看下覆盖率") });
      codex("item/completed", { threadId: THREAD_ID, turnId: REAL_TURN_ID, item: userMessageItem("item-b", clientB, "顺便看下覆盖率") });
      codex("item/completed", { threadId: THREAD_ID, turnId: REAL_TURN_ID, item: { type: "agentMessage", id: "msg-1", text: "done" } });
      codex("turn/completed", { threadId: THREAD_ID, turn: { id: REAL_TURN_ID, items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } });

      // SSE 先于 HTTP 响应：终态已经推到前端，B 的 202 还没回。
      const frames = await sseReader.readUntil((frame) => frame.kind === "event" && frame.type === "turn.completed");
      const streamed = frames
        .filter((frame): frame is Extract<SseFrame, { kind: "event" }> => frame.kind === "event")
        .map((frame) => frame.event);
      expect(responded).toBe(false);
      const streamedUserItems = streamed.filter((event) =>
        event.type === "item.started" && itemOf(event).type === "userMessage");
      expect(streamedUserItems.map((event) => [itemOf(event).clientId, event.turnRef?.turnId]))
        .toEqual([[clientA, REAL_TURN_ID], [clientB, REAL_TURN_ID]]);

      gate.resolve();
      const acceptedB = await pendingB;
      expect(acceptedB.status).toBe(202);
      const bodyB = (await acceptedB.json()) as { clientTurnId?: string; turnRef: { turnId: string } };
      // 响应里的 turnRef 是幽灵 id（永不出现在事件流里）；关联键才是前端要用的。
      expect(bodyB.turnRef.turnId).toBe(GHOST_TURN_ID);
      expect(bodyB.clientTurnId).toBe(clientB);
      expect(streamed.some((event) => event.turnRef?.turnId === GHOST_TURN_ID)).toBe(false);

      // 两条读取路径交付同一份事实，且与 web 侧共享的 fixture 完全一致。
      const placeholders = { [clientA]: "<clientTurnId:A>", [clientB]: "<clientTurnId:B>", [sessionId]: "<sessionId>" };
      const replayed = normalizeEvents(await backfill(base, sessionId), placeholders);
      if (process.env["ATTRIBUTION_FIXTURE"] === "write") {
        // 链路形状有意变更时重新生成：ATTRIBUTION_FIXTURE=write pnpm --filter @suduo/client-server test -- attribution-chain
        writeFileSync(FIXTURE_PATH, JSON.stringify(replayed, null, 2) + "\n");
      }
      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown[];
      expect(replayed).toEqual(fixture);
      expect(normalizeEvents(streamed, placeholders)).toEqual(fixture);
    } finally {
      sseAbort.abort();
      await context.close();
    }
  }, 60_000);
});

function userMessageItem(id: string, clientId: string, text: string): JsonValue {
  return { type: "userMessage", id, clientId, content: [{ type: "text", text, text_elements: [] }] };
}

function itemOf(event: EventEnvelope<string, JsonValue>): { type?: string; clientId?: string } {
  const payload = event.payload as { item?: { type?: string; clientId?: string } };
  return payload.item ?? {};
}

/**
 * 去掉每次运行都不同的字段（seq / eventId / ts / dedupe 相关），把 sessionId 与两把
 * 关联键换成占位符；顺序保留。web 侧 reducer 测试用同样的占位符还原。
 */
function normalizeEvents(
  events: EventEnvelope<string, JsonValue>[],
  placeholders: Record<string, string>,
): unknown[] {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      return placeholders[value] ?? value;
    }
    if (Array.isArray(value)) {
      return value.map(replace);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  return events.map((event) => replace({
    type: event.type,
    source: event.source,
    payload: event.payload,
    threadRef: event.threadRef,
    turnRef: event.turnRef,
  }));
}

async function backfill(base: string, sessionId: string): Promise<EventEnvelope<string, JsonValue>[]> {
  const response = await fetch(`${base}/api/v1/sessions/${sessionId}/events/backfill?after=0&until=1000000&limit=500`);
  expect(response.status).toBe(200);
  return (await response.json()) as EventEnvelope<string, JsonValue>[];
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timed out");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class GatedRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  readonly turns: StartTurnInput[] = [];
  private hold: { promise: Promise<void>; turnId: string } | null = null;

  holdNextStartTurn(promise: Promise<void>, turnId: string): void {
    this.hold = { promise, turnId };
  }

  async startThread(): Promise<StartThreadResult> {
    const thread = { threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: THREAD_ID }, role: "primary" as const, metadata: {} };
    return { primaryThread: thread, threads: [thread] };
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.turns.push(input);
    const hold = this.hold;
    this.hold = null;
    if (hold !== null) {
      await hold.promise;
      return { turnRef: { threadId: input.threadRef.threadId, turnId: hold.turnId }, acceptedAt: Date.now() };
    }
    return { turnRef: { threadId: input.threadRef.threadId, turnId: REAL_TURN_ID }, acceptedAt: Date.now() };
  }

  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }

  async interrupt(): Promise<void> {
    return undefined;
  }

  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}
