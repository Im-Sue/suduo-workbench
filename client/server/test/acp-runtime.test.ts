import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, RuntimeEventDraft, ThreadRef } from "@suduo/client-contracts";
import { acpProfile, pickMode } from "../src/infrastructure/runtime/acp/acp-profiles.js";
import { AcpRuntime, isAuthError } from "../src/infrastructure/runtime/acp/acp-runtime.js";
import { AcpTurnTranslator, suDuoToolName, type TranslatedEvent } from "../src/infrastructure/runtime/acp/acp-translator.js";

/** 多 Agent S4：标准 ACP 运行时（ADR-0014，技术设计 2.4、4.1、4.2；S0 实测）。 */

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const dirs: string[] = [];
const runtimes: AcpRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function items(events: TranslatedEvent[], type: string): Record<string, JsonValue>[] {
  return events.filter((event) => event.type === type).map((event) => (event.payload as Record<string, JsonValue>)["item"] as Record<string, JsonValue>);
}

describe("ACP 更新翻译成 SuDuo 的条目", () => {
  const translator = () => {
    const t = new AcpTurnTranslator({ threadId: "s-1", cwd: "/repo", agentName: "Gemini CLI", now: () => 1_000 });
    t.beginTurn("turn-1");
    return t;
  };

  it("文字与思考按换了种更新切分；回合外（续接回放）的更新不翻译", () => {
    const t = new AcpTurnTranslator({ threadId: "s-1", cwd: "/repo", agentName: "X" });
    expect(t.translate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } })).toEqual([]);
    t.beginTurn("turn-1");
    const events = [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好" } },
    ].flatMap((update) => t.translate(update));
    const finished = t.finishTurn("end_turn");
    expect([...items(events, "item.completed"), ...items(finished, "item.completed")]).toEqual([
      { type: "reasoning", id: "turn-1:thought:1", summary: ["想"], content: [] },
      { type: "agentMessage", id: "turn-1:text:2", text: "你好" },
    ]);
    expect(finished.at(-1)).toEqual({ type: "turn.completed", payload: { threadId: "s-1", turn: { id: "turn-1", status: "completed", error: null } } });
  });

  it("工具：执行、查看、改文件（带 diff）、SuDuo 工具、其他；计划与用量", () => {
    const t = translator();
    const events = [
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "pnpm test", kind: "execute", status: "pending", rawInput: { command: "pnpm test" } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] },
      { sessionUpdate: "tool_call", toolCallId: "c2", title: "Read a.ts", kind: "read", status: "completed", locations: [{ path: "/repo/a.ts" }] },
      { sessionUpdate: "tool_call", toolCallId: "c3", title: "Edit", kind: "edit", status: "completed", content: [{ type: "diff", path: "/repo/a.ts", oldText: "x\n", newText: "y\n" }, { type: "diff", path: "/repo/new.ts", newText: "n\n" }] },
      { sessionUpdate: "tool_call", toolCallId: "c4", title: "suduo_attachment_view", kind: "other", status: "completed", content: [{ type: "content", content: { type: "image", data: "iVBOR", mimeType: "image/png" } }] },
      { sessionUpdate: "tool_call", toolCallId: "c5", title: "github: get issue", kind: "other", status: "failed", rawOutput: { error: "404" } },
      { sessionUpdate: "tool_call", toolCallId: "c6", title: "think", kind: "think", status: "completed" },
      { sessionUpdate: "plan", entries: [{ content: "一", priority: "high", status: "in_progress" }] },
      { sessionUpdate: "usage_update", used: 5000, size: 200000 },
    ].flatMap((update) => t.translate(update));
    const done = items(events, "item.completed");
    expect(done.map((item) => item["type"])).toEqual(["commandExecution", "commandExecution", "fileChange", "dynamicToolCall", "mcpToolCall"]);
    expect(done[0]).toMatchObject({ command: "pnpm test", status: "completed", exitCode: 0, aggregatedOutput: "ok" });
    expect(done[1]).toMatchObject({ commandActions: [{ type: "read", name: "a.ts", path: "/repo/a.ts" }] });
    expect(done[2]).toMatchObject({ changes: [{ path: "/repo/a.ts", kind: { type: "update" } }, { path: "/repo/new.ts", kind: { type: "add" }, diff: "n\n" }] });
    expect(done[3]).toMatchObject({ tool: "suduo_attachment_view", success: true, contentItems: [{ type: "inputImage", imageUrl: "[image omitted]" }] });
    expect(done[4]).toMatchObject({ server: "Gemini CLI", tool: "github: get issue", status: "failed" });
    expect(events.find((event) => event.type === "plan.updated")!.payload).toMatchObject({ plan: [{ step: "一", status: "inProgress" }] });
    expect(events.find((event) => event.type === "usage.updated")!.payload).toMatchObject({ tokenUsage: { last: { totalTokens: 5000 }, modelContextWindow: 200000 } });
  });

  it("结束原因：取消（发过中断）记 interrupted；拒绝与超限记失败；没收尾的工具记失败", () => {
    const t = translator();
    t.translate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "sleep", kind: "execute", status: "in_progress" });
    t.markInterruptRequested();
    const events = t.finishTurn("cancelled");
    expect(items(events, "item.completed")[0]).toMatchObject({ status: "failed" });
    expect(events.at(-1)).toMatchObject({ payload: { turn: { status: "interrupted" } } });
    t.beginTurn("turn-2");
    expect(t.finishTurn("refusal").at(-1)).toMatchObject({ payload: { turn: { status: "failed", error: { message: "refusal" } } } });
  });

  it("认出各家写法的 SuDuo 工具名", () => {
    expect(suDuoToolName({ title: "suduo_requirement_get", name: null })).toBe("requirement_get");
    expect(suDuoToolName({ title: "x", name: "mcp__suduo__notes_read" })).toBe("notes_read");
    expect(suDuoToolName({ title: "suduo/comment_submit", name: null })).toBe("comment_submit");
    expect(suDuoToolName({ title: "requirement_get (suduo MCP Server)", name: null })).toBe("requirement_get");
    expect(suDuoToolName({ title: "github_get_issue", name: null })).toBeNull();
  });
});

describe("档位与模式", () => {
  it("按偏好在 Agent 的模式里选；OpenCode 用 plan / build 并在启动时注入权限规则", () => {
    expect(pickMode(["default", "autoEdit", "yolo", "plan"], acpProfile("gemini").modes.auto)).toBe("autoEdit");
    expect(pickMode(["default", "auto-edit", "yolo", "plan"], acpProfile("qwen-code").modes.full)).toBe("yolo");
    expect(pickMode(["build", "plan"], acpProfile("opencode").modes.readonly)).toBe("plan");
    expect(pickMode(["agent"], acpProfile("copilot").modes.readonly)).toBeNull();
    expect(JSON.parse(acpProfile("opencode").env!("readonly")["OPENCODE_CONFIG_CONTENT"]!)).toEqual({ permission: { edit: "deny", bash: "deny", webfetch: "allow" } });
    expect(isAuthError({ code: -32000, message: "Authentication required" })).toBe(true);
    expect(isAuthError(new Error("Gemini API key is missing or not configured."))).toBe(true);
    expect(isAuthError(new Error("boom"))).toBe(false);
  });
});

function setup(options: { env?: Record<string, string>; agentId?: string; idleMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "suduo-acp-"));
  dirs.push(dir);
  const log = join(dir, "agent.log");
  let authRequired = 0;
  const runtime = new AcpRuntime({
    agentId: options.agentId ?? "gemini",
    agentName: "Fake Agent",
    launch: () => ({ file: process.execPath, args: [FAKE_AGENT] }),
    env: () => ({ PATH: process.env["PATH"] ?? "", FAKE_ACP_LOG: log, ...options.env }),
    onAuthRequired: () => (authRequired += 1),
    startTimeoutMs: 20_000,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  runtimes.push(runtime);
  const abort = new AbortController();
  const events: RuntimeEventDraft[] = [];
  void (async () => {
    for await (const event of runtime.subscribe({ signal: abort.signal })) events.push(event);
  })();
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, JsonValue>) : []);
  const ofType = (type: string) => events.filter((event) => event.type === type);
  return { runtime, dir, events, ofType, calls, authRequired: () => authRequired };
}

const toolServer = { url: "http://127.0.0.1:8787/mcp", token: "tok-1", toolTimeoutSec: 600 };
const turn = (threadRef: ThreadRef, text: string, approvalMode: "ask" | "auto" | "full" | "readonly" = "ask") => ({
  sessionId: "s-1",
  threadRef,
  clientTurnId: "c",
  input: [{ type: "text" as const, text }],
  projectRoot: "/repo",
  workspaceRoots: ["/repo"],
  approvalMode,
});

async function create(context: ReturnType<typeof setup>, approvalMode: "ask" | "readonly" = "ask") {
  const result = await context.runtime.startThread({ mode: "create", sessionId: "s-1", projectRoot: context.dir, workspaceRoots: [context.dir], approvalMode, developerInstructions: "需求卡", toolServer });
  return result.primaryThread.threadRef;
}

describe("ACP 运行时（假 Agent 进程）", () => {
  it("建线程即建会话：带 SuDuo 工具服务与本机直连，线程 ID 是 Agent 的会话 ID；说明放在第一条消息前", async () => {
    const context = setup();
    const threadRef = await create(context);
    expect(threadRef).toMatchObject({ runtimeId: "acp-gemini", runtimeKind: "acp" });
    expect(threadRef.threadId).toMatch(/^fake-/);
    const created = context.calls().find((call) => call["method"] === "session/new")!;
    expect(created["mcpServers"]).toEqual([{ type: "http", name: "suduo", url: toolServer.url, headers: [{ name: "Authorization", value: "Bearer tok-1" }] }]);
    expect(created["env"]).toMatchObject({ NO_PROXY: "127.0.0.1,localhost,::1" });
    expect(context.calls().find((call) => call["method"] === "initialize")!["clientCapabilities"]).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    await context.runtime.startTurn(turn(threadRef, "hello"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    const prompts = context.calls().filter((call) => call["method"] === "session/prompt");
    expect(prompts[0]!["prompt"]).toEqual([{ type: "text", text: "<suduo_context>\n需求卡\n</suduo_context>" }, { type: "text", text: "hello" }]);
    expect(context.ofType("message.delta").map((event) => (event.payload as Record<string, JsonValue>)["text"])).toEqual(["Hi", " there"]);
    await context.runtime.startTurn(turn(threadRef, "again"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(2));
    // 第二条消息不再带说明
    expect(context.calls().filter((call) => call["method"] === "session/prompt")[1]!["prompt"]).toEqual([{ type: "text", text: "again" }]);
  });

  it("没登录：建线程报错并回调需要登录", async () => {
    const context = setup({ env: { FAKE_ACP_AUTH_REQUIRED: "1" } });
    await expect(create(context)).rejects.toThrow(/Authentication required/i);
    expect(context.authRequired()).toBe(1);
  });

  it("询问档：权限请求成确认卡（Agent 的选项 + 停止），按选项回给 Agent；拒绝记 declined", async () => {
    const context = setup();
    const threadRef = await create(context);
    await context.runtime.startTurn(turn(threadRef, "permission please"));
    await vi.waitFor(() => expect(context.ofType("approval.requested")).toHaveLength(1));
    const card = context.ofType("approval.requested")[0]!.payload as Record<string, JsonValue>;
    expect(card).toMatchObject({ kind: "command", subject: "command", display: { command: "rm -rf build" }, nativeMethod: "session/request_permission" });
    expect(card["options"]).toEqual([
      { id: "allow-once", decision: "accept", label: "Allow once" },
      { id: "allow-always", decision: "acceptAlways", label: "Always allow" },
      { id: "reject-once", decision: "decline", label: "Reject" },
      { id: "cancel", decision: "cancel" },
    ]);
    await context.runtime.approve({ sessionId: "s-1", threadRef, approvalRef: card["approvalRef"] as string, decision: "decline", optionId: "reject-once" });
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    expect(context.calls().find((call) => call["method"] === "permission-answer")!["outcome"]).toEqual({ outcome: "selected", optionId: "reject-once" });
    const done = context.ofType("item.completed").map((event) => (event.payload as Record<string, JsonValue>)["item"] as Record<string, JsonValue>);
    expect(done.find((item) => item["id"] === "call-rm")).toMatchObject({ status: "declined" });
  });

  it("完全访问直接放行、只读直接拒绝，都不出卡；切到对应模式", async () => {
    const context = setup();
    const threadRef = await create(context);
    await context.runtime.startTurn(turn(threadRef, "permission", "full"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    await context.runtime.startTurn(turn(threadRef, "permission", "readonly"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(2));
    expect(context.ofType("approval.requested")).toHaveLength(0);
    const answers = context.calls().filter((call) => call["method"] === "permission-answer").map((call) => call["outcome"]);
    expect(answers).toEqual([{ outcome: "selected", optionId: "allow-once" }, { outcome: "selected", optionId: "reject-once" }]);
    expect(context.calls().filter((call) => call["method"] === "session/set_mode").map((call) => call["modeId"])).toEqual(["default", "yolo", "plan"]);
  });

  it("中断：先把等着的权限请求答成取消、卡片作废，回合记 interrupted；之后照常", async () => {
    const context = setup();
    const threadRef = await create(context);
    const { turnRef } = await context.runtime.startTurn(turn(threadRef, "permission"));
    await vi.waitFor(() => expect(context.ofType("approval.requested")).toHaveLength(1));
    await context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: turnRef.turnId });
    // 与 Codex 一致：中断的回合是 turn.interrupted
    await vi.waitFor(() => expect(context.ofType("turn.interrupted")).toHaveLength(1));
    expect(context.ofType("approval.withdrawn")).toHaveLength(1);
    expect(context.ofType("turn.interrupted")[0]!.payload).toMatchObject({ turn: { status: "interrupted" } });
    const slow = await context.runtime.startTurn(turn(threadRef, "slow"));
    await vi.waitFor(() => expect(context.ofType("message.delta").length).toBeGreaterThan(2));
    await context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: slow.turnRef.turnId });
    await vi.waitFor(() => expect(context.ofType("turn.interrupted")).toHaveLength(2));
    await context.runtime.startTurn(turn(threadRef, "hello"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    await expect(context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: "gone" })).rejects.toThrow(/no active turn/);
  });

  it("续接期间点停止：消息不再发给 Agent；紧接着的回合只起一个进程（复核第 2 条）", async () => {
    const context = setup({ idleMs: 30 });
    const threadRef = await create(context);
    await vi.waitFor(() => expect(context.ofType("runtime.connection-closed")).toHaveLength(1), { timeout: 3_000 });
    const first = await context.runtime.startTurn(turn(threadRef, "hello"));
    await context.runtime.interrupt({ sessionId: "s-1", threadRef, turnId: first.turnRef.turnId });
    await context.runtime.startTurn(turn(threadRef, "again"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    expect(context.ofType("turn.interrupted")).toHaveLength(1);
    const prompts = context.calls().filter((call) => call["method"] === "session/prompt").map((call) => JSON.stringify(call["prompt"]));
    expect(prompts.some((prompt) => prompt.includes("hello"))).toBe(false);
    expect(context.calls().filter((call) => call["method"] === "session/load")).toHaveLength(1);
  });

  it("进程崩了：连接关闭、回合失败；下个回合重启进程并续接（回放的历史不进事件），工具服务照带", async () => {
    const context = setup();
    const threadRef = await create(context);
    await context.runtime.startTurn(turn(threadRef, "crash now"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    expect(context.ofType("turn.completed")[0]!.payload).toMatchObject({ turn: { status: "failed" } });
    expect(context.ofType("runtime.connection-closed")).toHaveLength(1);
    const deltasBefore = context.ofType("message.delta").length;
    await context.runtime.startTurn(turn(threadRef, "hello"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(2));
    const load = context.calls().find((call) => call["method"] === "session/load")!;
    expect(load).toMatchObject({ sessionId: threadRef.threadId, mcpServers: [{ name: "suduo" }] });
    expect(context.ofType("message.delta").slice(deltasBefore).map((event) => (event.payload as Record<string, JsonValue>)["text"])).toEqual(["Hi", " there"]);
  });

  it("本机服务重启后续接：用新令牌 load；闲置关掉进程后同样续接", async () => {
    const first = setup({ idleMs: 50 });
    const threadRef = await create(first);
    await vi.waitFor(() => expect(first.ofType("runtime.connection-closed")).toHaveLength(1), { timeout: 3_000 });
    await first.runtime.startTurn(turn(threadRef, "hello"));
    await vi.waitFor(() => expect(first.ofType("turn.completed")).toHaveLength(1));
    expect(first.calls().filter((call) => call["method"] === "session/load")).toHaveLength(1);

    const second = setup();
    await second.runtime.startThread({ mode: "resume", sessionId: "s-1", threadRef, projectRoot: second.dir, workspaceRoots: [second.dir], approvalMode: "ask", toolServer: { ...toolServer, token: "tok-2" } });
    await second.runtime.startTurn(turn(threadRef, "suduo please"));
    await vi.waitFor(() => expect(second.ofType("turn.completed")).toHaveLength(1));
    expect(second.calls().find((call) => call["method"] === "session/load")).toMatchObject({ mcpServers: [{ headers: [{ value: "Bearer tok-2" }] }] });
    const tool = second.ofType("item.completed").map((event) => (event.payload as Record<string, JsonValue>)["item"] as Record<string, JsonValue>).find((item) => item["type"] === "dynamicToolCall");
    expect(tool).toMatchObject({ tool: "suduo_requirement_get", success: true });
  });

  it("OpenCode：按档位在启动时注入权限规则，跨档位重启进程", async () => {
    const context = setup({ agentId: "opencode" });
    const threadRef = await create(context);
    expect(JSON.parse(String((context.calls().find((call) => call["method"] === "session/new")!["env"] as Record<string, JsonValue>)["OPENCODE_CONFIG_CONTENT"]))).toEqual({ permission: { edit: "ask", bash: "ask", webfetch: "ask" } });
    await context.runtime.startTurn(turn(threadRef, "hello", "readonly"));
    await vi.waitFor(() => expect(context.ofType("turn.completed")).toHaveLength(1));
    expect(context.calls().filter((call) => call["method"] === "session/load")).toHaveLength(1);
  });
});
