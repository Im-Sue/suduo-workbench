import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, RuntimeEventDraft, ThreadRef } from "@suduo/client-contracts";
import { OMITTED_IMAGE_URL } from "../src/infrastructure/runtime/suduo-tool-item.js";
import { snippetDiff } from "../src/infrastructure/runtime/snippet-diff.js";
import { claudePermissionOptions, sameQueryShape } from "../src/infrastructure/runtime/claude/claude-permissions.js";
import { ClaudeRuntime, claudeEffort, describePermission, sessionRules, type ClaudeSdk } from "../src/infrastructure/runtime/claude/claude-runtime.js";
import { ClaudeTurnTranslator, type TranslatedEvent } from "../src/infrastructure/runtime/claude/claude-translator.js";

/** 多 Agent S3：Claude Code 运行时（ADR-0014，技术设计 2.4、4.1、4.2；S0 实测）。 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stream = (event: Record<string, JsonValue>, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent });
const assistant = (id: string, content: JsonValue[], extra: Record<string, JsonValue> = {}) => ({ type: "assistant", message: { id, content, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }, parent_tool_use_id: null, ...extra });
const toolResult = (toolUseId: string, content: JsonValue, isError = false) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] }, parent_tool_use_id: null });
const success = { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, modelUsage: { "claude-x": { contextWindow: 200000 } } };

function items(events: TranslatedEvent[], type: string): Record<string, JsonValue>[] {
  return events.filter((event) => event.type === type).map((event) => (event.payload as Record<string, JsonValue>)["item"] as Record<string, JsonValue>);
}

describe("Claude 消息翻译成 SuDuo 的条目", () => {
  const translator = () => {
    let now = 1_000;
    const t = new ClaudeTurnTranslator({ threadId: "th-1", cwd: "/repo", now: () => (now += 100) });
    t.beginTurn("turn-1");
    return t;
  };

  it("流式文字与思考：开始、增量、完成；回合结束带用量与结局", () => {
    const t = translator();
    const events = [
      stream({ type: "message_start", message: { id: "msg-1" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一想" } }),
      stream({ type: "content_block_stop", index: 0 }),
      stream({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } }),
      stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "，世界" } }),
      stream({ type: "content_block_stop", index: 1 }),
      assistant("msg-1", [{ type: "thinking", thinking: "想一想" }, { type: "text", text: "你好，世界" }]),
      success,
    ].flatMap((message) => t.translate(message));
    expect(events.filter((event) => event.type === "message.delta").map((event) => (event.payload as Record<string, JsonValue>)["text"])).toEqual(["你好", "，世界"]);
    expect(items(events, "item.completed")).toEqual([
      { type: "reasoning", id: "msg-1:0", summary: ["想一想"], content: [] },
      { type: "agentMessage", id: "msg-1:1", text: "你好，世界" },
    ]);
    // 已经流式给过的消息不再整段补出
    expect(items(events, "item.started").filter((item) => item["type"] === "agentMessage")).toHaveLength(1);
    const usage = events.find((event) => event.type === "usage.updated")!.payload as Record<string, JsonValue>;
    expect(usage["tokenUsage"]).toMatchObject({ last: { totalTokens: 105 }, total: { totalTokens: 105 }, modelContextWindow: 200000 });
    expect(events.at(-1)).toEqual({ type: "turn.completed", payload: { threadId: "th-1", turn: { id: "turn-1", status: "completed", error: null } } });
    expect(t.activeTurnId).toBeNull();
  });

  it("工具：命令、查看、改文件、SuDuo 工具、其他 MCP、计划；ToolSearch 不显示", () => {
    const t = translator();
    const events = [
      assistant("msg-2", [
        { type: "tool_use", id: "tu-bash", name: "Bash", input: { command: "pnpm test" } },
        { type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "/repo/src/a.ts" } },
        { type: "tool_use", id: "tu-edit", name: "Edit", input: { file_path: "/repo/src/a.ts", old_string: "a\nb\nc", new_string: "a\nB\nc" } },
        { type: "tool_use", id: "tu-suduo", name: "mcp__suduo__attachment_view", input: { attachmentId: "x" } },
        { type: "tool_use", id: "tu-gh", name: "mcp__github__get_issue", input: { n: 1 } },
        { type: "tool_use", id: "tu-todo", name: "TodoWrite", input: { todos: [{ content: "写测试", status: "in_progress" }, { content: "提交", status: "pending" }] } },
        { type: "tool_use", id: "tu-search", name: "ToolSearch", input: { query: "suduo" } },
      ]),
      toolResult("tu-bash", "1 failed", true),
      toolResult("tu-read", "file body"),
      toolResult("tu-edit", "ok"),
      toolResult("tu-suduo", [{ type: "text", text: "附件" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }]),
      toolResult("tu-gh", [{ type: "text", text: "issue" }]),
      toolResult("tu-search", "loaded"),
    ].flatMap((message) => t.translate(message));
    expect(items(events, "item.started").map((item) => item["type"])).toEqual(["commandExecution", "commandExecution", "fileChange", "dynamicToolCall", "mcpToolCall"]);
    const plan = events.find((event) => event.type === "plan.updated")!.payload as Record<string, JsonValue>;
    expect(plan["plan"]).toEqual([{ step: "写测试", status: "inProgress" }, { step: "提交", status: "pending" }]);
    const done = items(events, "item.completed");
    expect(done[0]).toMatchObject({ type: "commandExecution", command: "pnpm test", cwd: "/repo", status: "failed", exitCode: 1, aggregatedOutput: "1 failed" });
    expect(done[1]).toMatchObject({ type: "commandExecution", commandActions: [{ type: "read", name: "a.ts", path: "/repo/src/a.ts" }], aggregatedOutput: null, status: "completed" });
    expect(done[2]).toMatchObject({ type: "fileChange", status: "completed", changes: [{ path: "/repo/src/a.ts", kind: { type: "update", move_path: null } }] });
    expect(String((done[2]!["changes"] as Array<Record<string, JsonValue>>)[0]!["diff"])).toContain("-b\n+B");
    expect(done[3]).toEqual({
      type: "dynamicToolCall",
      id: "tu-suduo",
      namespace: null,
      tool: "suduo_attachment_view",
      arguments: { attachmentId: "x" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "附件" }, { type: "inputImage", imageUrl: OMITTED_IMAGE_URL }],
      success: true,
      durationMs: expect.any(Number) as unknown as JsonValue,
    });
    expect(done[4]).toMatchObject({ type: "mcpToolCall", server: "github", tool: "get_issue", status: "completed", error: null });
    expect(done).toHaveLength(5);
  });

  it("用户拒绝的调用记为 declined；子 Agent 内部的消息不展开", () => {
    const t = translator();
    t.translate(assistant("m", [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "rm -rf build" } }]));
    t.markDeclined("tu-1");
    expect(items(t.translate(toolResult("tu-1", "The user declined this action.", true)), "item.completed")[0]).toMatchObject({ status: "declined" });
    expect(t.translate(stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }, "tu-task"))).toEqual([]);
    expect(t.translate({ ...assistant("sub", [{ type: "text", text: "inner" }]), parent_tool_use_id: "tu-task" })).toEqual([]);
  });

  it("发过中断后 error_during_execution 记为 interrupted；其他错误记为失败并带说明", () => {
    const t = translator();
    t.markInterruptRequested();
    expect(t.translate({ ...success, subtype: "error_during_execution", is_error: true, errors: [] }).at(-1)).toMatchObject({ payload: { turn: { status: "interrupted", error: null } } });
    t.beginTurn("turn-2");
    expect(t.translate({ ...success, subtype: "error_max_turns", is_error: true, result: undefined, errors: ["max turns reached"] } as never).at(-1)).toMatchObject({
      payload: { turn: { id: "turn-2", status: "failed", error: { message: "max turns reached" } } },
    });
  });

  it("登录失效：报错并记下；SuDuo 工具服务没连上：提醒；没流式的文字整段补出", () => {
    const t = translator();
    const auth = t.translate(assistant("m", [{ type: "text", text: "Invalid API key · Please run /login" }], { error: "authentication_failed" }));
    expect(auth).toEqual([{ type: "runtime.error", payload: { message: "Invalid API key · Please run /login", code: "authentication_failed" } }]);
    expect(t.authFailed).toBe(true);
    expect(t.translate({ type: "system", subtype: "init", model: "claude-x", mcp_servers: [{ name: "suduo", status: "failed" }] })[0]).toMatchObject({ type: "runtime.warning" });
    expect(t.model).toBe("claude-x");
    expect(items(t.translate(assistant("m2", [{ type: "text", text: "整段" }])), "item.completed")).toEqual([{ type: "agentMessage", id: "m2:0", text: "整段" }]);
  });

  it("进程断开时收口：未完成的文字补完，回合失败", () => {
    const t = translator();
    t.translate(stream({ type: "message_start", message: { id: "m" } }));
    t.translate(stream({ type: "content_block_start", index: 0, content_block: { type: "text" } }));
    t.translate(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半句" } }));
    const events = t.abortTurn("Claude Code exited");
    expect(items(events, "item.completed")).toEqual([{ type: "agentMessage", id: "m:0", text: "半句" }]);
    expect(events.at(-1)).toMatchObject({ payload: { turn: { status: "failed", error: { message: "Claude Code exited" } } } });
  });
});

describe("权限档位与审批卡", () => {
  it("四档映射；SuDuo 工具服务整个放行；只读不加载设置、只用 SuDuo 的 MCP、禁写", () => {
    expect(claudePermissionOptions("ask")).toMatchObject({ permissionMode: "default", settingSources: ["user", "project", "local"], strictMcpConfig: false, allowedTools: ["mcp__suduo"] });
    expect(claudePermissionOptions("auto")).toMatchObject({ permissionMode: "acceptEdits" });
    expect(claudePermissionOptions("full")).toMatchObject({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
    const readonly = claudePermissionOptions("readonly");
    expect(readonly).toMatchObject({ permissionMode: "dontAsk", settingSources: [], strictMcpConfig: true });
    expect(readonly.allowedTools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "mcp__suduo"]));
    expect(readonly.allowedTools).not.toContain("Bash");
    expect(readonly.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
  });

  it("命令卡带命令与目录（写到某路径时也是命令卡）；改文件卡带 itemId；其他工具说清是哪个", () => {
    expect(describePermission("Bash", { command: "echo x > out.txt" }, { cwd: "/repo", toolUseId: "tu", blockedPath: "/repo/out.txt" })).toMatchObject({
      kind: "command",
      subject: "command",
      request: { command: "echo x > out.txt", cwd: "/repo" },
      display: { command: "echo x > out.txt", paths: ["/repo/out.txt"] },
    });
    expect(describePermission("Write", { file_path: "/repo/a.md" }, { cwd: "/repo", toolUseId: "tu-9", title: "Claude wants to write a.md" })).toMatchObject({
      kind: "file-change",
      subject: "file",
      request: { itemId: "tu-9", path: "/repo/a.md", reason: "Claude wants to write a.md" },
    });
    expect(describePermission("mcp__github__create_issue", {}, { cwd: "/repo", toolUseId: "tu" })).toMatchObject({ kind: "other", subject: "tool", request: { command: "github · create_issue" } });
    expect(describePermission("WebFetch", { url: "https://x.test" }, { cwd: "/repo", toolUseId: "tu" })).toMatchObject({ request: { command: "WebFetch https://x.test" } });
  });

  it("片段 diff：首尾相同的行作上下文，只标改动行", () => {
    expect(snippetDiff("a.ts", "x\ny\nz\n", "x\nY\nz\n")).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n x\n-y\n+Y\n z\n");
    expect(snippetDiff("b.ts", "", "new")).toBe("--- a/b.ts\n+++ b/b.ts\n@@ -1,0 +1,1 @@\n+new\n");
  });
});

/** 可控的假查询：测试往里推 SDK 消息；记下收到的用户消息与控制请求。 */
class FakeQuery {
  readonly calls: string[] = [];
  readonly received: SDKUserMessage[] = [];
  private readonly queue: Array<{ value?: unknown; error?: unknown; done?: boolean }> = [];
  private wake: (() => void) | null = null;
  closed = false;

  constructor(readonly options: Options, prompt: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const message of prompt) this.received.push(message);
    })();
  }

  emit(value: unknown): void {
    this.queue.push({ value });
    this.wake?.();
  }

  fail(error: unknown): void {
    this.queue.push({ error });
    this.wake?.();
  }

  async *iterate(): AsyncGenerator<unknown> {
    for (;;) {
      const next = this.queue.shift();
      if (next === undefined) {
        if (this.closed) return;
        await new Promise<void>((resolve) => (this.wake = resolve));
        continue;
      }
      if (next.error !== undefined) throw next.error;
      yield next.value;
    }
  }

  asQuery(): Query {
    const generator = this.iterate();
    return Object.assign(generator, {
      interrupt: async () => {
        this.calls.push("interrupt");
        return undefined;
      },
      setPermissionMode: async (mode: string) => {
        this.calls.push("setPermissionMode:" + mode);
      },
      setModel: async (model?: string) => {
        this.calls.push("setModel:" + String(model));
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        this.calls.push("applyFlagSettings:" + JSON.stringify(settings));
      },
      setMcpServers: async () => {
        this.calls.push("setMcpServers");
        return { added: [], removed: [], errors: {} };
      },
      close: () => {
        this.closed = true;
        this.calls.push("close");
        this.wake?.();
      },
    }) as unknown as Query;
  }
}

function setup(options: { exists?: boolean; executable?: string | null; startDelayMs?: number; idleMs?: number } = {}) {
  const queries: FakeQuery[] = [];
  const sdk: ClaudeSdk = {
    query: ({ prompt, options: queryOptions }) => {
      const fake = new FakeQuery(queryOptions, prompt);
      queries.push(fake);
      return fake.asQuery();
    },
    sessionExists: async () => {
      if (options.startDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.startDelayMs));
      return options.exists ?? false;
    },
  };
  let authRequired = 0;
  const runtime = new ClaudeRuntime({
    resolveExecutable: () => (options.executable === undefined ? "/usr/local/bin/claude" : options.executable),
    env: () => ({ PATH: "/bin", HTTPS_PROXY: "http://proxy.test:8080" }),
    sdk,
    onAuthRequired: () => (authRequired += 1),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  const abort = new AbortController();
  const events: RuntimeEventDraft[] = [];
  void (async () => {
    for await (const event of runtime.subscribe({ signal: abort.signal })) events.push(event);
  })();
  const ofType = (type: string) => events.filter((event) => event.type === type);
  return { runtime, queries, events, ofType, abort, authRequired: () => authRequired };
}

const toolServer = { url: "http://127.0.0.1:8787/mcp", token: "tok-1", toolTimeoutSec: 600 };

async function started(context: ReturnType<typeof setup>, approvalMode: "ask" | "readonly" = "ask") {
  const result = await context.runtime.startThread({ mode: "create", sessionId: "s-1", projectRoot: "/repo", workspaceRoots: ["/repo"], approvalMode, developerInstructions: "需求卡", toolServer });
  return result.primaryThread.threadRef;
}

const turnInput = (threadRef: ThreadRef, text: string, approvalMode: "ask" | "auto" | "readonly" = "ask") => ({
  sessionId: "s-1",
  threadRef,
  clientTurnId: "c",
  input: [{ type: "text" as const, text }],
  projectRoot: "/repo",
  workspaceRoots: ["/repo"],
  approvalMode,
});

describe("Claude 运行时", () => {
  it("建线程不启动进程；首个回合按会话参数启动查询（新会话用指定 ID、SuDuo 工具服务、说明追加、本机直连）", async () => {
    const context = setup();
    const threadRef = await started(context);
    expect(threadRef).toMatchObject({ runtimeId: "claude-local", runtimeKind: "claude-sdk" });
    expect(context.queries).toHaveLength(0);
    await vi.waitFor(() => expect(context.ofType("thread.started")).toHaveLength(1));
    expect(context.events[0]).toMatchObject({ sessionHint: "s-1", threadRef });
    const { turnRef } = await context.runtime.startTurn(turnInput(threadRef, "你好"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(1));
    const options = context.queries[0]!.options;
    expect(options).toMatchObject({
      cwd: "/repo",
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      sessionId: threadRef.threadId,
      permissionMode: "default",
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: "需求卡" },
      mcpServers: { suduo: { type: "http", url: toolServer.url, headers: { Authorization: "Bearer tok-1" }, timeout: 600_000 } },
    });
    expect(options).not.toHaveProperty("resume");
    expect(options.env).toMatchObject({ NO_PROXY: "127.0.0.1,localhost,::1", HTTPS_PROXY: "http://proxy.test:8080" });
    await vi.waitFor(() => expect(context.queries[0]!.received).toHaveLength(1));
    expect(context.queries[0]!.received[0]!.message.content).toEqual([{ type: "text", text: "你好" }]);
    expect(context.ofType("turn.started")[0]).toMatchObject({ turnRef });
  });

  it("续接已有记录的会话用 resume；没装 claude 时建线程直接报错", async () => {
    const context = setup({ exists: true });
    await context.runtime.startThread({ mode: "resume", sessionId: "s-1", threadRef: { runtimeId: "claude-local", runtimeKind: "claude-sdk", threadId: "th-old" }, projectRoot: "/repo", workspaceRoots: ["/repo"], approvalMode: "ask", toolServer });
    await context.runtime.startTurn(turnInput({ runtimeId: "claude-local", runtimeKind: "claude-sdk", threadId: "th-old" }, "继续"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(1));
    expect(context.queries[0]!.options).toMatchObject({ resume: "th-old" });
    expect(context.queries[0]!.options).not.toHaveProperty("sessionId");
    await expect(setup({ executable: null }).runtime.startThread({ mode: "create", sessionId: "s", projectRoot: "/r", workspaceRoots: ["/r"], approvalMode: "ask" })).rejects.toThrow(/not_installed/);
  });

  it("审批：卡片带中立字段；同意 / 本会话同意 / 拒绝 / 拒绝并停止各回给 Claude 对应结果", async () => {
    const context = setup();
    const threadRef = await started(context);
    await context.runtime.startTurn(turnInput(threadRef, "改文件"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(1));
    const canUseTool = context.queries[0]!.options.canUseTool!;
    const ask = (toolUseID: string) =>
      canUseTool("Bash", { command: "pnpm build" }, {
        signal: new AbortController().signal,
        toolUseID,
        requestId: "req-" + toolUseID,
        suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm build" }], behavior: "allow", destination: "localSettings" }],
      } as never);
    const results: Array<Promise<PermissionResult | null>> = ["a", "b", "c", "d"].map(ask);
    await vi.waitFor(() => expect(context.ofType("approval.requested")).toHaveLength(4));
    const card = context.ofType("approval.requested")[0]!.payload as Record<string, JsonValue>;
    expect(card).toMatchObject({ kind: "command", subject: "command", nativeMethod: "claude/canUseTool", requestId: "req-a", display: { command: "pnpm build", cwd: "/repo" } });
    expect((card["options"] as Array<Record<string, JsonValue>>).map((option) => option["id"])).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    const refs = context.ofType("approval.requested").map((event) => (event.payload as Record<string, JsonValue>)["approvalRef"] as string);
    for (const [index, decision] of (["accept", "acceptForSession", "decline", "cancel"] as const).entries()) {
      await context.runtime.approve({ sessionId: "s-1", threadRef, approvalRef: refs[index]!, decision });
    }
    const [accept, session, decline, cancel] = await Promise.all(results);
    expect(accept).toEqual({ behavior: "allow", updatedInput: { command: "pnpm build" } });
    // 本会话同意：Claude 建议的规则改记到 session，不写用户的设置文件
    expect(session).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "addRules", destination: "session" }] });
    expect(decline).toMatchObject({ behavior: "deny" });
    expect(cancel).toMatchObject({ behavior: "deny", interrupt: true });
    await expect(context.runtime.approve({ sessionId: "s-1", threadRef, approvalRef: refs[0]!, decision: "accept" })).rejects.toThrow(/not pending/);
  });

  it("Claude 撤回请求时卡片作废；查询断开时这条连接上的卡作废、回合失败，下个回合重新启动", async () => {
    const context = setup();
    const threadRef = await started(context);
    await context.runtime.startTurn(turnInput(threadRef, "一"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(1));
    const abort = new AbortController();
    void context.queries[0]!.options.canUseTool!("Bash", { command: "x" }, { signal: abort.signal, toolUseID: "tu", requestId: "r" } as never);
    await vi.waitFor(() => expect(context.ofType("approval.requested")).toHaveLength(1));
    abort.abort();
    await vi.waitFor(() => expect(context.ofType("approval.withdrawn")).toHaveLength(1));
    expect(context.ofType("approval.withdrawn")[0]!.payload).toMatchObject({ approvalRef: (context.ofType("approval.requested")[0]!.payload as Record<string, JsonValue>)["approvalRef"] });

    context.queries[0]!.fail(new Error("claude crashed"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    expect(context.ofType("runtime.connection-closed")[0]!.payload).toEqual({ connectionId: (context.ofType("approval.requested")[0]!.payload as Record<string, JsonValue>)["connectionId"] });
    expect(context.ofType("turn.completed")[0]!.payload).toMatchObject({ turn: { status: "failed", error: { message: "claude crashed" } } });

    await context.runtime.startTurn(turnInput(threadRef, "二"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(2));
  });

  it("一次只跑一个回合，后来的排队；中断当前回合；排队中的回合中断即拿掉", async () => {
    const context = setup();
    const threadRef = await started(context);
    const first = await context.runtime.startTurn(turnInput(threadRef, "一"));
    const second = await context.runtime.startTurn(turnInput(threadRef, "二"));
    const third = await context.runtime.startTurn(turnInput(threadRef, "三"));
    await vi.waitFor(() => expect(context.queries[0]?.received).toHaveLength(1));
    await context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: third.turnRef.turnId });
    // 排队中的回合拿掉时给终态
    await vi.waitFor(() => expect(context.ofType("turn.interrupted")[0]).toMatchObject({ turnRef: third.turnRef }));
    await context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: first.turnRef.turnId });
    expect(context.queries[0]!.calls).toContain("interrupt");
    context.queries[0]!.emit({ ...success, subtype: "error_during_execution", is_error: true, errors: [] });
    await vi.waitFor(() => expect(context.queries[0]!.received).toHaveLength(2));
    // 与 Codex 一致：中断的回合是 turn.interrupted（队列据此暂停）
    expect(context.ofType("turn.interrupted")[1]).toMatchObject({ turnRef: first.turnRef, payload: { turn: { status: "interrupted" } } });
    context.queries[0]!.emit(success);
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    expect(context.ofType("turn.completed")[0]).toMatchObject({ turnRef: second.turnRef, payload: { turn: { status: "completed" } } });
    // 不认识的回合：报「已经停了」，中断服务据此补终态
    await expect(context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: "gone" })).rejects.toThrow(/no active turn/);
    // 第三个回合被拿掉了
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.queries[0]!.received).toHaveLength(2);
  });

  it("档位：同类之间直接切换；跨只读要重启查询；改模型；续接时令牌换到活着的查询上；登录失效回调", async () => {
    const context = setup();
    const threadRef = await started(context);
    await context.runtime.startTurn(turnInput(threadRef, "一"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(1));
    context.queries[0]!.emit(success);
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    await context.runtime.startTurn({ ...turnInput(threadRef, "二", "auto"), model: "claude-opus-x" });
    // 档位与模型在回合开始时生效
    await vi.waitFor(() => expect(context.queries[0]!.calls).toEqual(expect.arrayContaining(["setPermissionMode:acceptEdits", "setModel:claude-opus-x"])));
    context.queries[0]!.emit(assistant("m", [{ type: "text", text: "Please run /login" }], { error: "authentication_failed" }));
    context.queries[0]!.emit({ ...success, is_error: true, result: "Please run /login" });
    await vi.waitFor(() => expect(context.authRequired()).toBe(1));

    await context.runtime.startThread({ mode: "resume", sessionId: "s-1", threadRef, projectRoot: "/repo", workspaceRoots: ["/repo"], approvalMode: "auto", toolServer: { ...toolServer, token: "tok-2" } });
    expect(context.queries[0]!.calls).toContain("setMcpServers");

    // 完全访问要在启动时允许跳过权限检查：也重启查询
    expect(sameQueryShape("auto", "full")).toBe(false);
    expect(sameQueryShape("ask", "auto")).toBe(true);
    await context.runtime.startTurn(turnInput(threadRef, "三", "readonly"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(2));
    expect(context.queries[0]!.calls).toContain("close");
    expect(context.queries[1]!.options).toMatchObject({ permissionMode: "dontAsk", strictMcpConfig: true, settingSources: [], mcpServers: { suduo: { headers: { Authorization: "Bearer tok-2" } } } });
  });

  it("本机图片转成 base64 内容块；技能提示去读说明", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suduo-claude-img-"));
    dirs.push(dir);
    const image = join(dir, "shot.jpg");
    writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff]));
    const context = setup();
    const threadRef = await started(context);
    await context.runtime.startTurn({
      ...turnInput(threadRef, "看图"),
      input: [{ type: "local-image", path: image }, { type: "skill", name: "gate-c", path: "/repo/.codex/skills/gate-c/SKILL.md" }],
    });
    await vi.waitFor(() => expect(context.queries[0]?.received).toHaveLength(1));
    expect(context.queries[0]!.received[0]!.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } },
      { type: "text", text: 'Use the "gate-c" skill: read /repo/.codex/skills/gate-c/SKILL.md and follow it.' },
    ]);
  });

  it("查询启动期间点停止：这条消息不发出，紧接着的回合共用同一条查询（复核第 6 条）", async () => {
    const context = setup({ startDelayMs: 80 });
    const threadRef = await started(context);
    const first = await context.runtime.startTurn(turnInput(threadRef, "一"));
    await context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: first.turnRef.turnId });
    await context.runtime.startTurn(turnInput(threadRef, "二"));
    await vi.waitFor(() => expect(context.queries[0]?.received).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.queries).toHaveLength(1);
    expect(context.queries[0]!.received.map((message) => message.message.content)).toEqual([[{ type: "text", text: "二" }]]);
    expect(context.ofType("turn.interrupted")).toHaveLength(1);
  });

  it("本会话同意只带回规则与目录（不收切换模式的建议）；线程元数据记下说明；闲置关查询（复核第 4、5、8 条）", async () => {
    expect(
      sessionRules([
        { type: "setMode", mode: "acceptEdits", destination: "session" },
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm test" }], behavior: "allow", destination: "localSettings" },
        { type: "addDirectories", directories: ["/tmp"], destination: "localSettings" },
      ]),
    ).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm test" }], behavior: "allow", destination: "session" },
      { type: "addDirectories", directories: ["/tmp"], destination: "session" },
    ]);
    const context = setup({ idleMs: 30 });
    const created = await context.runtime.startThread({ mode: "create", sessionId: "s-1", projectRoot: "/repo", workspaceRoots: ["/repo"], approvalMode: "ask", developerInstructions: "需求卡", toolServer });
    expect(created.primaryThread.metadata).toMatchObject({ suDuoInstructions: "需求卡" });
    const threadRef = created.primaryThread.threadRef;
    await context.runtime.startTurn(turnInput(threadRef, "一"));
    await vi.waitFor(() => expect(context.queries).toHaveLength(1));
    // 只有切换模式的建议时不给「本会话同意」
    void context.queries[0]!.options.canUseTool!("Edit", { file_path: "/repo/a" }, { signal: new AbortController().signal, toolUseID: "tu", requestId: "r", suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } as never);
    await vi.waitFor(() => expect(context.ofType("approval.requested")).toHaveLength(1));
    expect(((context.ofType("approval.requested")[0]!.payload as Record<string, JsonValue>)["options"] as Array<Record<string, JsonValue>>).map((option) => option["id"])).toEqual(["accept", "decline", "cancel"]);
    context.queries[0]!.emit(success);
    await vi.waitFor(() => expect(context.queries[0]!.calls).toContain("close"));
  });

  it("推理强度：启动时带上，回合间改了就实时下发；SuDuo 的档位换算成 Claude 的（多 Agent S5）", async () => {
    expect([claudeEffort("minimal"), claudeEffort("medium"), claudeEffort("ultra"), claudeEffort(null), claudeEffort(undefined)]).toEqual(["low", "medium", "max", null, null]);
    const context = setup();
    const threadRef = await started(context);
    await context.runtime.startTurn({ ...turnInput(threadRef, "一"), reasoningEffort: "high" });
    await vi.waitFor(() => expect(context.queries).toHaveLength(1));
    expect(context.queries[0]!.options).toMatchObject({ effort: "high" });
    context.queries[0]!.emit(success);
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    await context.runtime.startTurn({ ...turnInput(threadRef, "二"), reasoningEffort: "low" });
    await vi.waitFor(() => expect(context.queries[0]!.calls).toContain('applyFlagSettings:{"effortLevel":"low"}'));
  });
});
