import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  JsonValue,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
} from "@suduo/client-contracts";
import type { AgentDto } from "@suduo/cloud-contracts";
import { AgentPresence, renderAgentState } from "../src/application/agent-presence.js";
import { ApiError } from "../src/application/api-error.js";
import { describeActivity } from "../src/application/session-activity.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * `activity` 分区：会话卡片上「正在做什么」与本机 Agent 状态说明按请求语言生成。
 * 英文与中文并排断言：中文与迁移前逐字一致。
 */

const en = messagesFor("en");
const zh = messagesFor("zh-CN");

describe("「正在做什么」按语言生成", () => {
  it("命令、文件、工具、网页、思考与回复", () => {
    const command = { type: "commandExecution", command: "/bin/zsh -lc \"npm test\"" };
    expect(describeActivity(command, en)).toBe("Running npm test");
    expect(describeActivity(command, zh)).toBe("运行命令：npm test");
    expect(describeActivity({ type: "commandExecution" }, en)).toBe("Running a command");
    expect(describeActivity({ type: "fileChange", changes: [] }, en)).toBe("Editing files");
    expect(describeActivity({ type: "fileChange", changes: [{ path: "/a/cart.js" }] }, en)).toBe("Editing cart.js");
    expect(describeActivity({ type: "fileChange", changes: [{ path: "/a/b.ts" }, { path: "/a/c.ts" }] }, en)).toBe(
      "Editing b.ts and 1 more file",
    );
    expect(
      describeActivity({ type: "fileChange", changes: [{ path: "/a/b.ts" }, { path: "/a/c.ts" }, { path: "/a/d.ts" }] }, en),
    ).toBe("Editing b.ts and 2 more files");
    expect(describeActivity({ type: "fileChange", changes: [{ path: "/a/b.ts" }, { path: "/a/c.ts" }, { path: "/a/d.ts" }] }, zh)).toBe(
      "修改 b.ts 等 3 个文件",
    );
    expect(describeActivity({ type: "mcpToolCall", tool: "search_docs" }, en)).toBe("Calling search_docs");
    expect(describeActivity({ type: "mcpToolCall" }, en)).toBe("Calling a tool");
    expect(describeActivity({ type: "webSearch" }, en)).toBe("Searching the web");
    expect(describeActivity({ type: "reasoning" }, en)).toBe("Thinking");
    expect(describeActivity({ type: "agentMessage", text: "" }, en)).toBe("Replying");
  });

  it("做完的步骤说「刚完成」；思考与回复做完不显示（按类型判断，两种语言一致）", () => {
    const done = { item: { type: "commandExecution", command: "npm test" }, completed: true };
    expect(describeActivity(done, en)).toBe("Just finished running npm test");
    expect(describeActivity(done, zh)).toBe("刚完成：运行命令：npm test");
    for (const t of [en, zh]) {
      expect(describeActivity({ item: { type: "reasoning" }, completed: true }, t)).toBeNull();
      expect(describeActivity({ item: { type: "agentMessage", text: "ok" }, completed: true }, t)).toBeNull();
    }
  });

  it("会话列表（GET /api/v1/sessions）按请求语言给出 runStatus.activity", async () => {
    const context = createMinimalHttpContext(new FixtureRuntime());
    try {
      const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "content-type": "application/json" };
      const project = await context.server.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...headers, "idempotency-key": "p" },
        payload: JSON.stringify({ rootPath: context.projectRoot, name: "activity" }),
      });
      const session = await context.server.inject({
        method: "POST",
        url: `/api/v1/projects/${String(project.json<{ id: string }>().id)}/sessions`,
        headers: { ...headers, "idempotency-key": "s" },
        payload: JSON.stringify({ title: "Checkout" }),
      });
      const sessionId = String(session.json<{ id: string }>().id);
      let ordinal = 0;
      const append = (type: string, payload: JsonValue) => {
        ordinal += 1;
        context.ledger.append({
          sessionId,
          sessionThreadId: null,
          event: {
            source: "runtime:codex-local",
            type,
            payload,
            threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
            turnRef: { threadId: "thread-1", turnId: "t1" },
            ts: 1_000 + ordinal,
            dedupeKey: "activity:" + String(ordinal),
          },
        });
      };
      append("turn.started", {});
      append("item.started", { item: { type: "commandExecution", id: "c1", command: "pnpm test" } });
      const activity = async (extra: Record<string, string>) => {
        const response = await context.server.inject({ method: "GET", url: "/api/v1/sessions", headers: { host: headers.host, ...extra } });
        const items = response.json<{ items: Array<{ id: string; runStatus: { activity: string | null } }> }>().items;
        return items.find((item) => item.id === sessionId)?.runStatus.activity;
      };
      // 不带头先发：夹具记下的 zh-CN（带头的请求会把语言记下来，之后不带头的请求沿用它）。
      expect(await activity({})).toBe("运行命令：pnpm test");
      expect(await activity({ "x-suduo-locale": "en" })).toBe("Running pnpm test");
    } finally {
      await context.close();
    }
  });
});

describe("本机 Agent 状态说明按请求语言渲染", () => {
  const directories: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function presence(options: { userId: string | null; heartbeat?: () => Promise<AgentDto> }) {
    const dataDirectory = mkdtempSync(join(tmpdir(), "suduo-activity-en-"));
    directories.push(dataDirectory);
    return new AgentPresence({
      dataDirectory,
      remote: {
        registerAgent: async () => agentFixture(),
        heartbeatAgent: options.heartbeat ?? (async () => agentFixture()),
      },
      currentUserId: () => options.userId,
      browserActive: () => false,
      hostname: () => "MacBook-Pro.local",
      log: () => undefined,
    });
  }

  it("没登录、登记中、心跳失败（拼接的远程报错也跟着语言走）", async () => {
    const signedOut = presence({ userId: null });
    signedOut.restart();
    expect(renderAgentState(signedOut.state(), en).message).toBe("Not signed in to the requirements service yet");
    expect(renderAgentState(signedOut.state(), zh).message).toBe("还没有登录需求服务");

    let failure: Error | null = null;
    const flaky = presence({
      userId: "user-dev",
      heartbeat: async () => {
        if (failure !== null) throw failure;
        return agentFixture();
      },
    });
    flaky.restart();
    expect(renderAgentState(flaky.state(), en).message).toBe("Registering your local agent");
    await vi.advanceTimersByTimeAsync(0);
    expect(renderAgentState(flaky.state(), en)).toMatchObject({ status: "ready", message: null });

    failure = new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.common.internalError);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renderAgentState(flaky.state(), en)).toMatchObject({
      status: "unavailable",
      message: "Local agent heartbeat failed: Something went wrong on the local service",
    });
    expect(renderAgentState(flaky.state(), zh).message).toBe("本机 Agent 心跳失败：服务端处理请求失败");

    // 不是 ApiError 的报错（网络、系统）原样拼进去。
    failure = new Error("ECONNREFUSED");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renderAgentState(flaky.state(), en).message).toBe("Local agent heartbeat failed: ECONNREFUSED");

    failure = new ApiError(401, "AUTH_INVALID", "expired");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renderAgentState(flaky.state(), en)).toMatchObject({
      status: "unregistered",
      message: "Your sign-in to the requirements service has expired. Sign in again.",
    });
    expect(renderAgentState(flaky.state(), zh).message).toBe("需求服务登录已过期，请重新登录");
    flaky.stop();
  });
});

class FixtureRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    const thread = {
      threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: "thread-1" },
      role: "primary",
      metadata: {},
    };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    return { turnRef: { threadId: input.threadRef.threadId, turnId: "turn-1" }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> { return { acknowledged: true }; }
  async interrupt(): Promise<void> { return undefined; }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> { yield* []; }
}

function agentFixture(): AgentDto {
  return {
    id: "agent-1",
    kind: "codex",
    owner: { id: "user-dev", displayName: "Alex Chen" },
    deviceName: "MacBook-Pro",
    label: "Alex Chen's Codex · MacBook-Pro",
    online: true,
    lastSeenAt: null,
    activeShareCount: 0,
  };
}
