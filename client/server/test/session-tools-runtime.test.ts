import { describe, expect, it } from "vitest";
import {
  M1_RUNTIME_SECURITY_POLICY,
  type AgentRuntime,
  type ApproveResult,
  type CodexTransportFactory,
  type JsonRpcId,
  type JsonValue,
  type RespondToolCallInput,
  type RpcConnection,
  type RpcInbound,
  type RpcRequestOptions,
  type RuntimeEventDraft,
  type StartThreadResult,
  type StartTurnResult,
} from "@suduo/client-contracts";
import type { ApprovalService } from "../src/application/approval-service.js";
import { consumeRuntimeUntilAborted } from "../src/application/runtime-consumer.js";
import type { RuntimeEventIngestor } from "../src/application/runtime-event-ingestor.js";
import type { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";
import {
  OMITTED_IMAGE_URL,
  normalizeCodexNotification,
} from "../src/infrastructure/runtime/codex/codex-event-normalizer.js";
import { CodexRuntime } from "../src/infrastructure/runtime/codex/codex-runtime.js";

/**
 * 会话工具层在 runtime 侧的行为（ADR-0008、技术设计 4.2）：
 * item/tool/call → tool.call-requested；respondToolCall 回包；serverRequest/resolved 作废；
 * thread/start 只在 create 时带 dynamicTools；连接换代 / 重连后旧调用不再回包。
 */

const TOOL_SPEC = {
  name: "suduo_requirement_get",
  description: "查询需求",
  inputSchema: { type: "object", properties: { number: { type: "string" } } },
};

describe("CodexRuntime 客户端自定义工具", () => {
  it("item/tool/call 产生 tool.call-requested（带 sessionHint），回包形状为 {contentItems, success}", async () => {
    const { runtime, connection } = await startedRuntime();
    const subscription = runtime.subscribe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    connection.push(toolCallRequest(7, { callId: "call-1", tool: "suduo_requirement_get", arguments: { number: "REQ-1" } }));

    const requested = (await subscription.next()).value as RuntimeEventDraft;
    expect(requested.type).toBe("tool.call-requested");
    expect(requested.sessionHint).toBe("session-1");
    expect(requested.threadRef).toEqual({ runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" });
    expect(requested.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    const payload = asObject(requested.payload);
    expect(payload).toEqual({
      callRef: expect.any(String),
      connectionId: "connection-a",
      requestId: "7",
      callId: "call-1",
      turnId: "turn-1",
      tool: "suduo_requirement_get",
      arguments: { number: "REQ-1" },
    });
    // callRef 是 runtime 自己生成的不透明引用，不是 Codex 的 callId / requestId。
    expect(payload["callRef"]).not.toBe("call-1");
    // 还没回包：不在订阅循环里等工具。
    expect(connection.responses).toEqual([]);

    const callRef = String(payload["callRef"]);
    const first = await runtime.respondToolCall({
      callRef,
      success: true,
      contentItems: [
        { type: "inputText", text: "REQ-1「商家端-订单详情优化」" },
        { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
      ],
    });
    expect(first).toEqual({ delivered: true });
    expect(connection.responses).toEqual([
      {
        id: 7,
        result: {
          contentItems: [
            { type: "inputText", text: "REQ-1「商家端-订单详情优化」" },
            { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
          ],
          success: true,
        },
      },
    ]);

    // 同一 callRef 第二次回复：不再发给 Codex。
    const second = await runtime.respondToolCall({ callRef, success: false, contentItems: [] });
    expect(second).toEqual({ delivered: false });
    expect(connection.responses).toHaveLength(1);
    // 不认识的 callRef 同样不抛错。
    await expect(runtime.respondToolCall({ callRef: "unknown", success: true, contentItems: [] })).resolves.toEqual({
      delivered: false,
    });
  });

  it("缺 threadId 的工具调用直接回错误，不产生 tool.call-requested", async () => {
    const { runtime, connection } = await startedRuntime();
    const subscription = runtime.subscribe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    connection.push({ kind: "server-request", id: 9, method: "item/tool/call", params: { callId: "c", tool: "x", arguments: {} } });
    const event = (await subscription.next()).value as RuntimeEventDraft;
    expect(event.type).toBe("runtime.error");
    // 认不出会话也就拿不到会话的语言，回给 Codex 的报错写英文（中英双语 S7）。
    expect(connection.errors).toEqual([{ id: 9, code: -32602, message: "SuDuo can't tell which session this tool call belongs to" }]);
  });

  it("serverRequest/resolved 命中挂起调用时产生 tool.call-cancelled，之后回包不再送达", async () => {
    const { runtime, connection } = await startedRuntime();
    const subscription = runtime.subscribe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    connection.push(toolCallRequest(11, { callId: "call-11", tool: "suduo_comment_submit", arguments: { body: "hi" } }));
    const requested = (await subscription.next()).value as RuntimeEventDraft;
    const callRef = String(asObject(requested.payload)["callRef"]);

    connection.push({ kind: "notification", method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 11 } });
    const cancelled = (await subscription.next()).value as RuntimeEventDraft;
    expect(cancelled.type).toBe("tool.call-cancelled");
    expect(cancelled.sessionHint).toBe("session-1");
    expect(cancelled.threadRef?.threadId).toBe("thread-1");
    expect(asObject(cancelled.payload)).toEqual({ callRef, reason: "Codex withdrew this tool call" });
    // 原通知照常归一化（进账本）。
    const normalized = (await subscription.next()).value as RuntimeEventDraft;
    expect(normalized.type).not.toBe("tool.call-cancelled");

    await expect(runtime.respondToolCall({ callRef, success: true, contentItems: [] })).resolves.toEqual({
      delivered: false,
    });
    expect(connection.responses).toEqual([]);
  });

  it("已经回包的调用收到 serverRequest/resolved 时不产生 tool.call-cancelled", async () => {
    const { runtime, connection } = await startedRuntime();
    const subscription = runtime.subscribe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    connection.push(toolCallRequest(12, { callId: "call-12", tool: "suduo_notes_read", arguments: {} }));
    const requested = (await subscription.next()).value as RuntimeEventDraft;
    const callRef = String(asObject(requested.payload)["callRef"]);
    await expect(
      runtime.respondToolCall({ callRef, success: true, contentItems: [{ type: "inputText", text: "ok" }] }),
    ).resolves.toEqual({ delivered: true });

    connection.push({ kind: "notification", method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 12 } });
    const next = (await subscription.next()).value as RuntimeEventDraft;
    expect(next.type).not.toBe("tool.call-cancelled");
    // 别的连接上同号 requestId 也不会误伤（这里只有一个连接：再发一个不相干的 requestId）。
    connection.push({ kind: "notification", method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 999 } });
    const unrelated = (await subscription.next()).value as RuntimeEventDraft;
    expect(unrelated.type).not.toBe("tool.call-cancelled");
  });

  it("restartConnection 清空挂起表：之前的调用返回 delivered:false", async () => {
    const { runtime, connection } = await startedRuntime();
    const subscription = runtime.subscribe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    connection.push(toolCallRequest(21, { callId: "call-21", tool: "suduo_requirement_get", arguments: {} }));
    const requested = (await subscription.next()).value as RuntimeEventDraft;
    const callRef = String(asObject(requested.payload)["callRef"]);

    await runtime.restartConnection("proxy settings changed");
    await expect(runtime.respondToolCall({ callRef, success: true, contentItems: [] })).resolves.toEqual({
      delivered: false,
    });
    expect(connection.responses).toEqual([]);
  });

  it("连接换代后（旧连接迟到的调用）回包返回 delivered:false，不发到新连接", async () => {
    const first = new QueueRpcConnection("connection-a");
    const second = new QueueRpcConnection("connection-b");
    const runtime = createRuntime([first, second]);
    await runtime.startThread(createInput());
    const subscription = runtime.subscribe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    // 先让订阅循环跑起来、挂在旧连接 A 上等消息。
    const pendingEvent = subscription.next();
    await flush();

    // 重连：旧连接被关掉，新连接建立（interrupt 会触发 ensureConnection）。
    await runtime.restartConnection("model provider changed");
    await runtime.interrupt({
      sessionId: "session-1",
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
      turnId: "turn-1",
    });
    expect(first.closed).toBe(true);
    expect(second.requests.map((request) => request.method)).toContain("turn/interrupt");

    // 旧连接的订阅循环还没退出时又收到一个调用：记在旧连接名下。
    first.push(toolCallRequest(31, { callId: "call-31", tool: "suduo_requirement_get", arguments: {} }));
    const requested = (await pendingEvent).value as RuntimeEventDraft;
    expect(asObject(requested.payload)["connectionId"]).toBe("connection-a");
    const callRef = String(asObject(requested.payload)["callRef"]);

    await expect(runtime.respondToolCall({ callRef, success: true, contentItems: [] })).resolves.toEqual({
      delivered: false,
    });
    expect(first.responses).toEqual([]);
    expect(second.responses).toEqual([]);
  });

  it("连接异常断开后清空挂起表", async () => {
    const { runtime, connection } = await startedRuntime();
    const subscription = runtime.subscribe({ signal: new AbortController().signal })[Symbol.asyncIterator]();
    connection.push(toolCallRequest(41, { callId: "call-41", tool: "suduo_requirement_get", arguments: {} }));
    const requested = (await subscription.next()).value as RuntimeEventDraft;
    const callRef = String(asObject(requested.payload)["callRef"]);

    connection.push(new Error("codex app-server exited"));
    const tail: RuntimeEventDraft[] = [];
    for (let result = await subscription.next(); !result.done; result = await subscription.next()) {
      tail.push(result.value);
    }
    expect(tail.map((event) => event.type)).toEqual(["runtime.error", "runtime.recovery-required"]);
    await expect(runtime.respondToolCall({ callRef, success: true, contentItems: [] })).resolves.toEqual({
      delivered: false,
    });
    expect(connection.responses).toEqual([]);
  });

  it("thread/start（create）带 function 形态的 dynamicTools；resume 不带；空数组不带", async () => {
    const connection = new QueueRpcConnection("connection-a");
    const runtime = createRuntime([connection]);
    await runtime.startThread({ ...createInput(), dynamicTools: [TOOL_SPEC], developerInstructions: "# SuDuo 需求会话" });
    await runtime.startThread({
      ...createInput(),
      mode: "resume",
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
      dynamicTools: [TOOL_SPEC],
    });
    await runtime.startThread({ ...createInput(), dynamicTools: [] });

    const [create, resume, emptyCreate] = connection.requests.filter(
      (request) => request.method === "thread/start" || request.method === "thread/resume",
    );
    expect(create?.method).toBe("thread/start");
    expect(asObject(create?.params)["dynamicTools"]).toEqual([
      {
        type: "function",
        name: "suduo_requirement_get",
        description: "查询需求",
        inputSchema: { type: "object", properties: { number: { type: "string" } } },
      },
    ]);
    expect(asObject(create?.params)["developerInstructions"]).toContain("# SuDuo 需求会话");
    expect(resume?.method).toBe("thread/resume");
    expect(asObject(resume?.params)).not.toHaveProperty("dynamicTools");
    expect(emptyCreate?.method).toBe("thread/start");
    expect(asObject(emptyCreate?.params)).not.toHaveProperty("dynamicTools");
  });
});

describe("codex-event-normalizer：dynamicToolCall 结果瘦身", () => {
  it("item/completed 的 dynamicToolCall：图片换成占位、长文本截断", () => {
    const longText = "需".repeat(5_000);
    const event = normalizeCodexNotification({
      runtimeId: "codex-local",
      connectionId: "connection-a",
      ordinal: 1,
      message: {
        kind: "notification",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "dynamicToolCall",
            id: "item-1",
            tool: "suduo_attachment_view",
            contentItems: [
              { type: "inputText", text: "附件 截图.png" },
              { type: "inputImage", imageUrl: "data:image/png;base64," + "A".repeat(10_000) },
              { type: "inputText", text: longText },
            ],
          },
        },
      },
    });
    expect(event.type).toBe("item.completed");
    const item = asObject(asObject(event.payload)["item"]);
    expect(item["tool"]).toBe("suduo_attachment_view");
    const contentItems = item["contentItems"] as JsonValue[];
    expect(contentItems[0]).toEqual({ type: "inputText", text: "附件 截图.png" });
    expect(contentItems[1]).toEqual({ type: "inputImage", imageUrl: OMITTED_IMAGE_URL });
    const truncated = asObject(contentItems[2])["text"] as string;
    expect(truncated.startsWith("需".repeat(4_000))).toBe(true);
    // 账本这一层拿不到会话语言：截断标记只用与语言无关的省略号（中英双语 S7）。
    expect(truncated).toBe("需".repeat(4_000) + "\n…");
    expect(truncated.length).toBeLessThan(longText.length);
    // extensions 里的原生副本同样已瘦身（账本里不留整张图）。
    const nativeItem = asObject(asObject(asObject(asObject(event.payload)["extensions"])["codex"])["params"])["item"];
    expect(JSON.stringify(nativeItem)).not.toContain("data:image/png");
  });

  it("其他 item（以及没有 contentItems 的 dynamicToolCall）原样不动", () => {
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "mcpToolCall",
        id: "item-2",
        contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,BBBB" }],
      },
    };
    const event = normalizeCodexNotification({
      runtimeId: "codex-local",
      connectionId: "connection-a",
      ordinal: 2,
      message: { kind: "notification", method: "item/completed", params },
    });
    expect(asObject(event.payload)["item"]).toEqual(params.item);

    const started = normalizeCodexNotification({
      runtimeId: "codex-local",
      connectionId: "connection-a",
      ordinal: 3,
      message: {
        kind: "notification",
        method: "item/started",
        params: { threadId: "thread-1", item: { type: "dynamicToolCall", id: "item-3", contentItems: null } },
      },
    });
    expect(asObject(started.payload)["item"]).toEqual({ type: "dynamicToolCall", id: "item-3", contentItems: null });
  });
});

describe("runtime-consumer：tool.call-* 事件分流", () => {
  it("tool.call-* 交给 toolCalls，不进 ingestor", async () => {
    const abort = new AbortController();
    const runtime = new ScriptedRuntime(
      [toolEvent("tool.call-requested", "ref-1"), toolEvent("tool.call-cancelled", "ref-1"), itemCompleted()],
      abort,
    );
    const ingested: RuntimeEventDraft[] = [];
    const handled: RuntimeEventDraft[] = [];
    await consumeRuntimeUntilAborted({
      runtime,
      ingestor: { ingest: (event: RuntimeEventDraft) => ingested.push(event) } as unknown as RuntimeEventIngestor,
      approvals: unusedApprovals(),
      supervisor: unusedSupervisor(),
      toolCalls: { handle: (event) => handled.push(event) },
      signal: abort.signal,
    });
    expect(handled.map((event) => event.type)).toEqual(["tool.call-requested", "tool.call-cancelled"]);
    expect(ingested.map((event) => event.type)).toEqual(["item.completed"]);
    expect(runtime.responses).toEqual([]);
  });

  it("没有 toolCalls 时 requested 被回失败，cancelled 被忽略，都不进 ingestor", async () => {
    const abort = new AbortController();
    const runtime = new ScriptedRuntime(
      [toolEvent("tool.call-requested", "ref-2"), toolEvent("tool.call-cancelled", "ref-2")],
      abort,
    );
    const ingested: RuntimeEventDraft[] = [];
    await consumeRuntimeUntilAborted({
      runtime,
      ingestor: { ingest: (event: RuntimeEventDraft) => ingested.push(event) } as unknown as RuntimeEventIngestor,
      approvals: unusedApprovals(),
      supervisor: unusedSupervisor(),
      signal: abort.signal,
    });
    expect(ingested).toEqual([]);
    expect(runtime.responses).toEqual([
      {
        callRef: "ref-2",
        success: false,
        contentItems: [{ type: "inputText", text: "The SuDuo tool service is unavailable, so this call wasn't run." }],
      },
    ]);
  });

  it("toolCalls.handle 抛错只报给 onError，循环继续", async () => {
    const abort = new AbortController();
    const runtime = new ScriptedRuntime([toolEvent("tool.call-requested", "ref-3"), itemCompleted()], abort);
    const errors: unknown[] = [];
    const ingested: RuntimeEventDraft[] = [];
    await consumeRuntimeUntilAborted({
      runtime,
      ingestor: { ingest: (event: RuntimeEventDraft) => ingested.push(event) } as unknown as RuntimeEventIngestor,
      approvals: unusedApprovals(),
      supervisor: unusedSupervisor(),
      toolCalls: {
        handle: () => {
          throw new Error("boom");
        },
      },
      signal: abort.signal,
      onError: (error) => errors.push(error),
    });
    expect(errors).toHaveLength(1);
    expect(ingested.map((event) => event.type)).toEqual(["item.completed"]);
  });
});

// ───────────────────────────── 测试替身 ─────────────────────────────

/**
 * 可控的异步队列版 RPC 连接：测试往里 push 消息（或 Error 模拟断线），订阅循环按需拉取，
 * 这样可以在「已 yield、还没回包」之间插入 respondToolCall / restartConnection。
 */
class QueueRpcConnection implements RpcConnection {
  readonly transportKind = "stdio" as const;
  readonly requests: Array<{ method: string; params: JsonValue | undefined }> = [];
  readonly responses: Array<{ id: JsonRpcId; result: JsonValue }> = [];
  readonly errors: Array<{ id: JsonRpcId; code: number; message: string }> = [];
  closed = false;
  private readonly queue: Array<RpcInbound | Error> = [];
  private waiter: (() => void) | null = null;

  constructor(readonly connectionId: string) {}

  push(item: RpcInbound | Error): void {
    this.queue.push(item);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async request(method: string, params: JsonValue | undefined, options: RpcRequestOptions): Promise<JsonValue> {
    void options;
    this.requests.push({ method, params });
    if (method === "initialize") {
      return { userAgent: "fake" };
    }
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: "thread-1" } };
    }
    return {};
  }

  async respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    this.responses.push({ id, result });
  }

  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    this.errors.push({ id, code, message });
  }

  async notify(): Promise<void> {}

  async *messages(options: { signal: AbortSignal }): AsyncIterable<RpcInbound> {
    void options;
    while (true) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
      const item = this.queue.shift();
      if (item === undefined) {
        continue;
      }
      if (item instanceof Error) {
        throw item;
      }
      yield item;
    }
  }

  async close(): Promise<void> {
    // 不结束 messages()：模拟旧连接的订阅循环还没来得及退出。
    this.closed = true;
  }
}

function createRuntime(connections: QueueRpcConnection[]): CodexRuntime {
  const pool = [...connections];
  const transport: CodexTransportFactory = {
    kind: "stdio",
    connect: async () => {
      const next = pool.shift();
      if (!next) {
        throw new Error("no more fake connections");
      }
      return next;
    },
  };
  return new CodexRuntime({ transport, codexBin: "fake-codex", env: {} });
}

function createInput() {
  return {
    mode: "create" as const,
    sessionId: "session-1",
    projectRoot: "/tmp/project",
    workspaceRoots: ["/tmp/project"],
    security: M1_RUNTIME_SECURITY_POLICY,
  };
}

async function startedRuntime(): Promise<{ runtime: CodexRuntime; connection: QueueRpcConnection }> {
  const connection = new QueueRpcConnection("connection-a");
  const runtime = createRuntime([connection]);
  await runtime.startThread(createInput());
  return { runtime, connection };
}

function toolCallRequest(
  id: number,
  input: { callId: string; tool: string; arguments: JsonValue },
): RpcInbound {
  return {
    kind: "server-request",
    id,
    method: "item/tool/call",
    params: { threadId: "thread-1", turnId: "turn-1", ...input },
  };
}

class ScriptedRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  readonly responses: RespondToolCallInput[] = [];

  constructor(
    private readonly script: RuntimeEventDraft[],
    private readonly abort: AbortController,
  ) {}

  async startThread(): Promise<StartThreadResult> {
    throw new Error("unused");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("unused");
  }
  async approve(): Promise<ApproveResult> {
    throw new Error("unused");
  }
  async interrupt(): Promise<void> {}
  async respondToolCall(input: RespondToolCallInput): Promise<{ delivered: boolean }> {
    this.responses.push(input);
    return { delivered: true };
  }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* this.script;
    // 脚本放完即停止消费循环。
    this.abort.abort();
  }
}

function toolEvent(type: "tool.call-requested" | "tool.call-cancelled", callRef: string): RuntimeEventDraft {
  return {
    source: "runtime:codex-local",
    type,
    payload:
      type === "tool.call-requested"
        ? { callRef, connectionId: "c", requestId: "1", callId: "call", turnId: "turn-1", tool: "suduo_requirement_get", arguments: {} }
        : { callRef, reason: "Codex 已撤回这次工具调用" },
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
    turnRef: null,
    ts: Date.now(),
    dedupeKey: "c:" + type + ":" + callRef,
  };
}

function itemCompleted(): RuntimeEventDraft {
  return {
    source: "runtime:codex-local",
    type: "item.completed",
    payload: { item: { type: "dynamicToolCall", id: "item-1" } },
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
    turnRef: null,
    ts: Date.now(),
    dedupeKey: "c:item",
  };
}

function unusedApprovals(): ApprovalService {
  return { orphanPersistedPending: () => 0 } as unknown as ApprovalService;
}

function unusedSupervisor(): RuntimeSupervisor {
  return { markUnavailable: () => undefined } as unknown as RuntimeSupervisor;
}

/** 让已排队的微任务 / I/O 回调跑完。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, JsonValue>;
}
