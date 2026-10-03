import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
} from "@suduo/client-contracts";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

const HOST = "127.0.0.1:8787";

class RecordingRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  readonly turns: StartTurnInput[] = [];
  private threadOrdinal = 0;
  async startThread(): Promise<StartThreadResult> {
    const thread = {
      threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: `thread-${String(++this.threadOrdinal)}` },
      role: "primary",
      metadata: {},
    };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    this.turns.push(input);
    return { turnRef: { threadId: input.threadRef.threadId, turnId: `turn-${String(this.turns.length)}` }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> { return { acknowledged: true }; }
  async interrupt(): Promise<void> { return undefined; }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> { yield* []; }
}

const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close();
  }
});

function setup() {
  const runtime = new RecordingRuntime();
  const context = createMinimalHttpContext(runtime);
  contexts.push(context);
  let keyOrdinal = 0;
  const send = (method: "POST" | "PATCH", url: string, body: unknown, headers: Record<string, string> = {}) =>
    context.server.inject({
      method,
      url,
      headers: {
        host: HOST,
        origin: `http://${HOST}`,
        "idempotency-key": `key-${String(++keyOrdinal)}`,
        "content-type": "application/json",
        ...headers,
      },
      payload: JSON.stringify(body),
    });
  const get = (url: string) => context.server.inject({ method: "GET", url, headers: { host: HOST } });
  const createSession = async () => {
    const project = await send("POST", "/api/v1/projects", { rootPath: context.projectRoot, name: "params" });
    const session = await send("POST", `/api/v1/projects/${String(project.json().id)}/sessions`, {});
    expect(session.statusCode).toBe(201);
    return session.json() as { id: string; version: number; model: unknown; reasoningEffort: unknown };
  };
  return { runtime, context, send, get, createSession };
}

describe("会话级模型与推理强度（PATCH /api/v1/sessions/:sessionId）", () => {
  it("新会话两项均为 null（跟随全局默认）", async () => {
    const { createSession, get } = setup();
    const session = await createSession();
    expect(session.model).toBeNull();
    expect(session.reasoningEffort).toBeNull();
    const fetched = await get(`/api/v1/sessions/${session.id}`);
    expect(fetched.json()).toMatchObject({ model: null, reasoningEffort: null });
  });

  it("不带 If-Match 时后写生效，可设置、单独改回 null，且不影响其它字段", async () => {
    const { createSession, send } = setup();
    const session = await createSession();
    const first = await send("PATCH", `/api/v1/sessions/${session.id}`, { model: " gpt-5.2-codex ", reasoningEffort: "high" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ model: "gpt-5.2-codex", reasoningEffort: "high", approvalMode: "ask", title: "新会话" });
    // 两次都不带版本：后一次直接覆盖，不会因版本号已变被拒。
    const second = await send("PATCH", `/api/v1/sessions/${session.id}`, { reasoningEffort: "xhigh" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ model: "gpt-5.2-codex", reasoningEffort: "xhigh" });
    const reset = await send("PATCH", `/api/v1/sessions/${session.id}`, { model: null });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ model: null, reasoningEffort: "xhigh" });
    const resetEffort = await send("PATCH", `/api/v1/sessions/${session.id}`, { reasoningEffort: null });
    expect(resetEffort.json()).toMatchObject({ model: null, reasoningEffort: null });
  });

  it("校验：推理强度须为格式合法的档位名（模型新声明的档位也接受），模型为 1–128 位合法模型名", async () => {
    const { createSession, send } = setup();
    const session = await createSession();
    for (const body of [
      { reasoningEffort: "Turbo" },
      { reasoningEffort: "very high" },
      { reasoningEffort: "" },
      { reasoningEffort: 3 },
      { model: "" },
      { model: "   " },
      { model: "bad model!" },
      { model: "x".repeat(129) },
      { model: 42 },
    ]) {
      const response = await send("PATCH", `/api/v1/sessions/${session.id}`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    const ok = await send("PATCH", `/api/v1/sessions/${session.id}`, { model: "qwen/qwen3:32b", reasoningEffort: "none" });
    expect(ok.statusCode).toBe(200);
    const future = await send("PATCH", `/api/v1/sessions/${session.id}`, { reasoningEffort: "turbo" });
    expect(future.statusCode).toBe(200);
    expect(future.json()).toMatchObject({ reasoningEffort: "turbo" });
  });

  it("旧客户端带 If-Match 也后写生效（ADR-0004）：过期版本不再 409", async () => {
    const { createSession, send } = setup();
    const session = await createSession();
    const ok = await send("PATCH", `/api/v1/sessions/${session.id}`, { title: "改名" }, { "if-match": `"${String(session.version)}"` });
    expect(ok.statusCode).toBe(200);
    const stale = await send("PATCH", `/api/v1/sessions/${session.id}`, { title: "再改" }, { "if-match": `"${String(session.version)}"` });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ title: "再改" });
  });

  it("发消息时把会话级参数交给 runtime（null = 跟随默认）", async () => {
    const { createSession, send, runtime } = setup();
    const session = await createSession();
    const first = await send("POST", `/api/v1/sessions/${session.id}/messages`, { content: [{ type: "text", text: "hi" }] });
    expect(first.statusCode).toBe(202);
    await send("PATCH", `/api/v1/sessions/${session.id}`, { model: "gpt-b", reasoningEffort: "low" });
    await send("POST", `/api/v1/sessions/${session.id}/messages`, { content: [{ type: "text", text: "again" }] });
    expect(runtime.turns.map((turn) => ({ model: turn.model, reasoningEffort: turn.reasoningEffort }))).toEqual([
      { model: null, reasoningEffort: null },
      { model: "gpt-b", reasoningEffort: "low" },
    ]);
  });
});
