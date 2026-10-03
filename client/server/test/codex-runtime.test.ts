import { describe, expect, it } from "vitest";
import {
  M1_RUNTIME_SECURITY_POLICY,
  ROOM_AGENT_SECURITY_POLICY,
  type CodexTransportFactory,
  type JsonRpcId,
  type JsonValue,
  type RpcConnection,
  type RpcInbound,
  type RpcRequestOptions,
} from "@suduo/client-contracts";
import { CodexRuntime } from "../src/infrastructure/runtime/codex/codex-runtime.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";

describe("T4 CodexRuntime", () => {
  it("双层显式传递安全策略并映射四类输入", async () => {
    const connection = new FakeRpcConnection();
    const runtime = createRuntime(connection);
    const started = await runtime.startThread({
      mode: "create",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: M1_RUNTIME_SECURITY_POLICY,
    });
    await runtime.startTurn({
      sessionId: "session-1",
      threadRef: started.primaryThread.threadRef,
      clientTurnId: "client-turn-1",
      input: [
        { type: "text", text: "hello" },
        { type: "local-image", path: "/tmp/project/image.png" },
        { type: "image-url", url: "https://example.test/image.png" },
        { type: "skill", name: "req", path: "/tmp/project/SKILL.md" },
      ],
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: M1_RUNTIME_SECURITY_POLICY,
    });

    expect(connection.notifications).toEqual([
      { method: "initialized", params: {} },
    ]);

    const threadStart = connection.requests.find(
      (request) => request.method === "thread/start",
    );
    const turnStart = connection.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
      input: [
        { type: "text", text: "hello", text_elements: [] },
        { type: "localImage", path: "/tmp/project/image.png" },
        { type: "image", url: "https://example.test/image.png" },
        { type: "skill", name: "req", path: "/tmp/project/SKILL.md" },
      ],
    });
  });

  it("房间 Agent 档：建线程与续接都按生效配置逐个关掉 MCP、连接器默认关；读不到配置不建线程", async () => {
    const connection = new FakeRpcConnection();
    connection.config = {
      model_provider: "fixture",
      mcp_servers: { figma: { command: "x" }, "corp.jira": { url: "https://jira" } },
      apps: { _default: { enabled: false }, gmail: { enabled: true } },
    };
    const runtime = createRuntime(connection);
    const base = {
      sessionId: "session-room",
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: ROOM_AGENT_SECURITY_POLICY,
    };
    await runtime.startThread({ ...base, mode: "create" });
    await runtime.startThread({
      ...base,
      mode: "resume",
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
    });
    const expected = {
      mcp_servers: { figma: { enabled: false }, "corp.jira": { enabled: false } },
      apps: { _default: { enabled: false }, gmail: { enabled: false } },
    };
    expect(asObject(connection.requests.find((request) => request.method === "thread/start")?.params)["config"]).toEqual(expected);
    expect(asObject(connection.requests.find((request) => request.method === "thread/resume")?.params)["config"]).toEqual(expected);
    // 生效配置按项目目录读（含项目级配置）。
    expect(connection.requests.find((request) => request.method === "config/read")?.params).toMatchObject({ cwd: "/tmp/project" });

    // 普通会话不带覆盖。
    await runtime.startThread({ ...base, sessionId: "session-normal", security: M1_RUNTIME_SECURITY_POLICY, mode: "create" });
    expect(asObject(connection.requests.filter((request) => request.method === "thread/start").at(-1)?.params)["config"]).toBeUndefined();

    connection.failConfigRead = true;
    await expect(runtime.startThread({ ...base, mode: "create" })).rejects.toThrow("无法确认已关闭所有者的 MCP 工具");
  });

  it("全局通知不挂到唯一的会话上；currentTime/read 回当前时间，其余非审批请求回「不支持」", async () => {
    const connection = new FakeRpcConnection();
    const runtime = createRuntime(connection);
    await runtime.startThread({
      mode: "create",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: M1_RUNTIME_SECURITY_POLICY,
    });
    connection.inbound = [
      { kind: "notification", method: "configWarning", params: { summary: "Codex is ignoring 1 unrecognized configuration settings.", details: null } },
      { kind: "server-request", id: 51, method: "currentTime/read", params: { threadId: "thread-1" } },
      { kind: "server-request", id: 52, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1" } },
    ];
    const before = Math.floor(Date.now() / 1000);
    const events = [];
    for await (const event of runtime.subscribe({ signal: new AbortController().signal })) {
      events.push(event);
    }
    expect(events[0]?.sessionHint).toBeUndefined();
    const time = connection.responses.find((response) => response.id === 51)?.result as { currentTimeAt: number } | undefined;
    expect(time?.currentTimeAt).toBeGreaterThanOrEqual(before);
    expect(connection.errors).toEqual([{ id: 52, code: -32601, message: expect.stringContaining("item/tool/requestUserInput") }]);
    // 回了「不支持」的请求在时间线上有说明。
    expect(events.filter((event) => event.type === "runtime.warning").map((event) => asObject(event.payload)["message"])).toEqual([
      expect.stringContaining("Codex 想请你回答一个问题"),
    ]);
    // 仍记为 runtime.unknown，便于排查。
    const requestIds = events
      .filter((event) => event.type === "runtime.unknown")
      .map((event) => asObject(event.payload)["requestId"])
      .filter((id) => id !== undefined);
    expect(requestIds).toEqual(["51", "52"]);
  });

  it("归一化通知并通过不透明 approvalRef 回应审批", async () => {
    const connection = new FakeRpcConnection();
    const runtime = createRuntime(connection);
    const started = await runtime.startThread({
      mode: "create",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: M1_RUNTIME_SECURITY_POLICY,
    });
    connection.inbound = [
      {
        kind: "notification",
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "hello",
        },
      },
      {
        kind: "server-request",
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-2",
          startedAtMs: 1,
          environmentId: null,
          command: "printf ok",
        },
      },
    ];

    const events = [];
    for await (const event of runtime.subscribe({
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "message.delta",
      "approval.requested",
    ]);
    expect(events[0]).toMatchObject({
      source: "runtime:codex-local",
      payload: { text: "hello" },
      sessionHint: "session-1",
    });
    const approvalPayload = asObject(events[1]?.payload);
    const approvalRef = String(approvalPayload["approvalRef"]);
    expect(approvalRef).not.toBe("");

    await runtime.approve({
      sessionId: "session-1",
      threadRef: started.primaryThread.threadRef,
      approvalRef,
      decision: "decline",
    });
    expect(connection.responses).toEqual([
      {
        id: 41,
        result: { decision: "decline" },
      },
    ]);
  });

  it("resume、interrupt 与 registry 保持 AgentRuntime 契约", async () => {
    const connection = new FakeRpcConnection();
    const runtime = createRuntime(connection);
    const threadRef = {
      runtimeId: "codex-local",
      runtimeKind: "codex",
      threadId: "thread-1",
    };
    await runtime.startThread({
      mode: "resume",
      sessionId: "session-1",
      threadRef,
      projectRoot: "/tmp/project",
      workspaceRoots: ["/tmp/project"],
      security: M1_RUNTIME_SECURITY_POLICY,
    });
    await runtime.interrupt({
      sessionId: "session-1",
      threadRef,
      turnId: "turn-1",
    });

    expect(
      connection.requests.find((request) => request.method === "thread/resume")
        ?.params,
    ).toMatchObject({
      threadId: "thread-1",
      sandbox: "read-only",
    });
    expect(
      connection.requests.find(
        (request) => request.method === "turn/interrupt",
      )?.params,
    ).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const registry = new RuntimeRegistry();
    registry.register(runtime);
    expect(registry.get("codex-local")).toBe(runtime);
    expect(() => registry.register(runtime)).toThrow("duplicate runtime id");
  });

  it("透传官方 Config/Model RPC 的参数，并保留层级与覆盖信息", async () => {
    const connection = new FakeRpcConnection();
    const runtime = createRuntime(connection);
    const read = await runtime.configRead({ includeLayers: true, cwd: "/tmp/project" });
    const write = await runtime.configBatchWrite({
      edits: [{ keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-sol" }],
      expectedVersion: "user-v1",
      reloadUserConfig: true,
    });
    const models = await runtime.modelList({ limit: 100 });

    expect(connection.requests).toContainEqual({
      method: "config/read",
      params: { includeLayers: true, cwd: "/tmp/project" },
    });
    expect(connection.requests).toContainEqual({
      method: "config/batchWrite",
      params: {
        edits: [{ keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-sol" }],
        expectedVersion: "user-v1",
        reloadUserConfig: true,
      },
    });
    expect(connection.requests).toContainEqual({ method: "model/list", params: { limit: 100 } });
    expect(read.layers).toMatchObject([{ version: "user-v1", name: { type: "user" } }]);
    expect(write).toMatchObject({
      status: "okOverridden",
      version: "user-v2",
      overriddenMetadata: { effectiveValue: "gpt-managed" },
    });
    expect(models).toEqual({ data: [{ id: "gpt-5.6-sol" }], nextCursor: null });
  });

  it("透传官方 MCP 状态、OAuth 与重载 RPC 的精确方法名", async () => {
    const connection = new FakeRpcConnection();
    const runtime = createRuntime(connection);

    await expect(runtime.mcpServerStatusList({ detail: "full" })).resolves.toEqual({
      data: [
        {
          name: "fixture",
          serverInfo: { name: "fixture", version: "1" },
          tools: {},
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported",
        },
      ],
      nextCursor: null,
    });
    await expect(
      runtime.mcpServerOauthLogin({ name: "fixture", scopes: ["tools.read"] }),
    ).resolves.toEqual({ authorizationUrl: "https://login.fixture/authorize" });
    await expect(runtime.mcpServerRefresh()).resolves.toBeUndefined();

    expect(connection.requests).toContainEqual({
      method: "mcpServerStatus/list",
      params: { detail: "full" },
    });
    expect(connection.requests).toContainEqual({
      method: "mcpServer/oauth/login",
      params: { name: "fixture", scopes: ["tools.read"] },
    });
    expect(connection.requests).toContainEqual({
      method: "config/mcpServer/reload",
      params: undefined,
    });
  });

  it("代理配置热重连后重放额外 skill roots", async () => {
    const first = new FakeRpcConnection();
    const second = new FakeRpcConnection();
    const connections = [first, second];
    const runtime = new CodexRuntime({
      transport: {
        kind: "stdio",
        connect: async () => {
          const connection = connections.shift();
          if (!connection) throw new Error("unexpected connection");
          return connection;
        },
      },
      codexBin: "fake-codex",
    });

    await runtime.setExtraSkillRoots(["/tmp/global-skills"]);
    await runtime.restartConnection("egress proxy settings changed");
    await runtime.listSkills("/tmp/project");

    expect(first.requests).toContainEqual({
      method: "skills/extraRoots/set",
      params: { extraRoots: ["/tmp/global-skills"] },
    });
    expect(second.requests).toContainEqual({
      method: "skills/extraRoots/set",
      params: { extraRoots: ["/tmp/global-skills"] },
    });
  });
});

class FakeRpcConnection implements RpcConnection {
  readonly connectionId = "fake-connection";
  readonly transportKind = "stdio" as const;
  readonly requests: Array<{ method: string; params: JsonValue | undefined }> =
    [];
  readonly responses: Array<{ id: JsonRpcId; result: JsonValue }> = [];
  readonly errors: Array<{ id: JsonRpcId; code: number; message: string }> = [];
  readonly notifications: Array<{
    method: string;
    params: JsonValue | undefined;
  }> = [];
  inbound: RpcInbound[] = [];
  /** config/read 回的生效配置。 */
  config: Record<string, JsonValue> = { model_provider: "fixture" };
  failConfigRead = false;

  async request(
    method: string,
    params: JsonValue | undefined,
    options: RpcRequestOptions,
  ): Promise<JsonValue> {
    void options;
    this.requests.push({ method, params });
    if (method === "initialize") {
      return { userAgent: "fake" };
    }
    if (method === "thread/start" || method === "thread/resume") {
      return {
        thread: {
          id: "thread-1",
        },
      };
    }
    if (method === "turn/start") {
      return {
        turn: {
          id: "turn-1",
        },
      };
    }
    if (method === "config/read") {
      if (this.failConfigRead) throw new Error("config/read timed out");
      return {
        config: this.config,
        origins: { model_provider: { name: { type: "user" }, version: "user-v1" } },
        layers: [{ name: { type: "user" }, version: "user-v1", config: {} }],
      };
    }
    if (method === "config/batchWrite") {
      return {
        status: "okOverridden",
        version: "user-v2",
        overriddenMetadata: {
          effectiveValue: "gpt-managed",
          message: "managed policy",
          overridingLayer: { name: { type: "enterpriseManaged" }, version: "managed-v1" },
        },
      };
    }
    if (method === "model/list") {
      return { data: [{ id: "gpt-5.6-sol" }], nextCursor: null };
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: [
          {
            name: "fixture",
            serverInfo: { name: "fixture", version: "1" },
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "mcpServer/oauth/login") {
      return { authorizationUrl: "https://login.fixture/authorize" };
    }
    if (method === "config/mcpServer/reload") {
      return {};
    }
    return {};
  }

  async respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    this.responses.push({ id, result });
  }
  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    this.errors.push({ id, code, message });
  }

  async notify(method: string, params: JsonValue | undefined): Promise<void> {
    this.notifications.push({ method, params });
  }

  async *messages(options: {
    signal: AbortSignal;
  }): AsyncIterable<RpcInbound> {
    void options;
    yield* this.inbound;
  }

  async close(): Promise<void> {}
}

function createRuntime(connection: FakeRpcConnection): CodexRuntime {
  const transport: CodexTransportFactory = {
    kind: "stdio",
    connect: async () => connection,
  };
  return new CodexRuntime({
    transport,
    codexBin: "fake-codex",
  });
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== "object") {
    throw new Error("expected object");
  }
  return value as Record<string, JsonValue>;
}
