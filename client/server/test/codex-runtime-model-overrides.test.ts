import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexTransportFactory,
  type JsonRpcId,
  type JsonValue,
  type RpcConnection,
  type RpcInbound,
  type RpcRequestOptions,
  type ThreadRef,
} from "@suduo/client-contracts";
import { ModelProviderService } from "../src/application/model-provider-service.js";
import { CodexRuntime } from "../src/infrastructure/runtime/codex/codex-runtime.js";
import { parseCodexModelCatalog } from "../src/infrastructure/runtime/codex/codex-model-overrides.js";

interface FakeOptions {
  /** thread/start|resume 回报的生效模型与强度。 */
  threadModel?: string;
  threadEffort?: string | null;
  config?: Record<string, JsonValue>;
  configFails?: boolean;
  catalog?: JsonValue[];
  catalogFails?: boolean;
}

class ModelFakeConnection implements RpcConnection {
  readonly connectionId = "fake-connection";
  readonly transportKind = "stdio" as const;
  readonly requests: Array<{ method: string; params: JsonValue | undefined }> = [];
  inbound: RpcInbound[] = [];
  failNextTurn = false;
  private turnOrdinal = 0;

  constructor(readonly options: FakeOptions = {}) {}

  async request(method: string, params: JsonValue | undefined, options: RpcRequestOptions): Promise<JsonValue> {
    void options;
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: "fake" };
    if (method === "thread/start" || method === "thread/resume") {
      return {
        thread: { id: "thread-1" },
        model: this.options.threadModel ?? "gpt-default",
        reasoningEffort: this.options.threadEffort === undefined ? null : this.options.threadEffort,
      };
    }
    if (method === "turn/start") {
      if (this.failNextTurn) {
        this.failNextTurn = false;
        throw new Error("turn/start timed out");
      }
      this.turnOrdinal += 1;
      return { turn: { id: "turn-" + String(this.turnOrdinal) } };
    }
    if (method === "config/read") {
      if (this.options.configFails) throw new Error("config/read failed");
      return { config: this.options.config ?? {}, origins: {}, layers: [] };
    }
    if (method === "model/list") {
      if (this.options.catalogFails) throw new Error("model/list failed");
      return { data: this.options.catalog ?? [], nextCursor: null };
    }
    return {};
  }

  async notify(method: string, params: JsonValue | undefined): Promise<void> {
    void method;
    void params;
  }

  async respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    void id;
    void result;
  }
  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    void id;
    void code;
    void message;
  }

  async *messages(options: { signal: AbortSignal }): AsyncIterable<RpcInbound> {
    void options;
    yield* this.inbound;
  }

  async close(): Promise<void> {
    return undefined;
  }

  turnStarts(): Array<Record<string, JsonValue>> {
    return this.requests
      .filter((request) => request.method === "turn/start")
      .map((request) => request.params as Record<string, JsonValue>);
  }

  count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }
}

function createRuntime(connection: RpcConnection): CodexRuntime {
  const transport: CodexTransportFactory = {
    kind: "stdio",
    connect: async () => connection,
  };
  return new CodexRuntime({ transport, codexBin: "codex", env: {} });
}

async function startThread(runtime: CodexRuntime, mode: "create" | "resume" = "create"): Promise<ThreadRef> {
  const common = {
    sessionId: "session-1",
    projectRoot: "/tmp/project",
    workspaceRoots: ["/tmp/project"],
    approvalMode: "ask" as const,
  };
  const started = await runtime.startThread(
    mode === "create"
      ? { ...common, mode: "create" }
      : { ...common, mode: "resume", threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" } },
  );
  return started.primaryThread.threadRef;
}

async function turn(
  runtime: CodexRuntime,
  threadRef: ThreadRef,
  selection: { model?: string | null; reasoningEffort?: string | null },
): Promise<void> {
  await runtime.startTurn({
    sessionId: "session-1",
    threadRef,
    clientTurnId: "client-" + String(Math.random()),
    input: [{ type: "text", text: "hi" }],
    projectRoot: "/tmp/project",
    workspaceRoots: ["/tmp/project"],
    approvalMode: "ask" as const,
    ...selection,
  });
}

function modelFields(params: Record<string, JsonValue> | undefined) {
  return {
    model: params?.["model"],
    effort: params?.["effort"],
  };
}

const CATALOG: JsonValue[] = [
  {
    id: "gpt-default",
    model: "gpt-default",
    displayName: "GPT Default",
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "medium", description: "" }],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-b",
    model: "gpt-b",
    displayName: "GPT B",
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
    defaultReasoningEffort: "high",
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("turn/start 会话级模型与推理强度（粘性覆盖）", () => {
  it("跟随默认且从未覆盖：不传 model / effort，也不去解析默认值", async () => {
    const connection = new ModelFakeConnection({ catalog: CATALOG });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: undefined, effort: undefined },
      { model: undefined, effort: undefined },
    ]);
    expect(connection.count("config/read")).toBe(0);
    expect(connection.count("model/list")).toBe(0);
  });

  it("调用方不管理（undefined）时保持旧行为：永不下发", async () => {
    const connection = new ModelFakeConnection();
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, {});
    expect(modelFields(connection.turnStarts()[0])).toEqual({ model: undefined, effort: undefined });
  });

  it("显式指定只在与线程现值不同时下发，相同值不重复传", async () => {
    const connection = new ModelFakeConnection({ threadModel: "gpt-default", threadEffort: "medium" });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    // 与线程创建时的生效值相同：无需下发。
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: "gpt-b", effort: "high" },
      { model: undefined, effort: undefined },
      { model: undefined, effort: undefined },
    ]);
    // 审批档每回合都显式下发。
    for (const params of connection.turnStarts()) {
      expect(params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } });
    }
  });

  it("改回跟随默认：显式下发 config 默认模型；未配置强度时下发模型自身默认强度，之后不再重复", async () => {
    const connection = new ModelFakeConnection({
      threadModel: "gpt-default",
      threadEffort: null,
      config: { model: "gpt-default" },
      catalog: CATALOG,
    });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: "gpt-b", effort: "high" },
      { model: "gpt-default", effort: "medium" },
      { model: undefined, effort: undefined },
    ]);
    expect(connection.requests.find((request) => request.method === "config/read")?.params).toEqual({
      includeLayers: false,
      cwd: "/tmp/project",
    });
  });

  it("config 配了推理强度时回退到它；config 没配模型时回退到 model/list 默认模型", async () => {
    const connection = new ModelFakeConnection({
      threadModel: "gpt-default",
      config: { model_reasoning_effort: "low" },
      catalog: CATALOG,
    });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)[1]).toEqual({ model: "gpt-default", effort: "low" });
  });

  it("只改回模型：强度保持显式值不动", async () => {
    const connection = new ModelFakeConnection({ config: { model: "gpt-default" }, catalog: CATALOG });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await turn(runtime, threadRef, { model: null, reasoningEffort: "high" });
    expect(connection.turnStarts().map(modelFields)[1]).toEqual({ model: "gpt-default", effort: undefined });
  });

  it("默认值解析失败时退到新建线程回报的生效值", async () => {
    const connection = new ModelFakeConnection({
      threadModel: "gpt-default",
      threadEffort: "medium",
      configFails: true,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)[1]).toEqual({ model: "gpt-default", effort: "medium" });
    expect(warn).toHaveBeenCalled();
  });

  it("resume 线程且默认值完全拿不到：不下发、记告警，沿用上次显式值", async () => {
    const connection = new ModelFakeConnection({ threadModel: "gpt-default", configFails: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime, "resume");
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: null });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: "gpt-b", effort: undefined },
      { model: undefined, effort: undefined },
    ]);
    expect(warn.mock.calls.some(([line]) => String(line).includes("codex.turn_model_default_unresolved"))).toBe(true);
  });

  it("resume 后线程带着旧覆盖（与默认不同）时，跟随默认会把它改回来；与默认相同则不传", async () => {
    const stale = new ModelFakeConnection({ threadModel: "gpt-b", threadEffort: null, config: { model: "gpt-default" }, catalog: CATALOG });
    const staleRuntime = createRuntime(stale);
    const staleThread = await startThread(staleRuntime, "resume");
    await turn(staleRuntime, staleThread, { model: null, reasoningEffort: null });
    expect(modelFields(stale.turnStarts()[0])).toEqual({ model: "gpt-default", effort: undefined });

    const clean = new ModelFakeConnection({ threadModel: "gpt-default", threadEffort: null, config: { model: "gpt-default" }, catalog: CATALOG });
    const cleanRuntime = createRuntime(clean);
    const cleanThread = await startThread(cleanRuntime, "resume");
    await turn(cleanRuntime, cleanThread, { model: null, reasoningEffort: null });
    await turn(cleanRuntime, cleanThread, { model: null, reasoningEffort: null });
    expect(clean.turnStarts().map(modelFields)).toEqual([
      { model: undefined, effort: undefined },
      { model: undefined, effort: undefined },
    ]);
    // 确认一次后不再重复解析默认值。
    expect(clean.count("config/read")).toBe(1);
  });

  it("turn/start 结果不确定时，下回合重新下发同一显式值", async () => {
    const connection = new ModelFakeConnection();
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    connection.failNextTurn = true;
    await expect(turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" })).rejects.toThrow("timed out");
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: "gpt-b", effort: "high" },
      { model: "gpt-b", effort: "high" },
    ]);
  });

  it("thread/settings/updated 回报的现值参与判断", async () => {
    const connection = new ModelFakeConnection({ threadModel: "gpt-default" });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    connection.inbound = [
      {
        kind: "notification",
        method: "thread/settings/updated",
        params: { threadId: "thread-1", threadSettings: { model: "gpt-b", effort: "high" } },
      },
    ];
    const types: string[] = [];
    for await (const event of runtime.subscribe({ signal: new AbortController().signal })) {
      types.push(event.type);
    }
    expect(types).toEqual(["thread.settings-updated"]);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    expect(modelFields(connection.turnStarts()[0])).toEqual({ model: undefined, effort: undefined });
  });

  it("配置写入后清空默认值缓存，下次回退重新解析", async () => {
    const connection = new ModelFakeConnection({ config: { model: "gpt-default", model_reasoning_effort: "low" } });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await runtime.configBatchWrite({ edits: [], expectedVersion: "v1", reloadUserConfig: true }).catch(() => undefined);
    connection.options.config = { model: "gpt-new", model_reasoning_effort: "medium" };
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: "gpt-b", effort: "high" },
      { model: "gpt-default", effort: "low" },
      { model: "gpt-b", effort: "high" },
      { model: "gpt-new", effort: "medium" },
    ]);
  });

  it("显式值等于新建线程回报的生效值时不下发", async () => {
    const connection = new ModelFakeConnection({ threadModel: "gpt-default", threadEffort: "medium" });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-default", reasoningEffort: "medium" });
    expect(modelFields(connection.turnStarts()[0])).toEqual({ model: undefined, effort: undefined });
  });
});

describe("model/list 目录解析", () => {
  it("取 id / model / 展示名 / 默认标记 / 支持强度，跳过无 id 的条目", () => {
    expect(
      parseCodexModelCatalog([
        ...CATALOG,
        { model: "no-id" },
        { id: "bare" },
        "junk",
      ]),
    ).toEqual([
      { id: "gpt-default", model: "gpt-default", displayName: "GPT Default", isDefault: true, supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "medium" },
      { id: "gpt-b", model: "gpt-b", displayName: "GPT B", isDefault: false, supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" },
      { id: "bare", model: "bare", displayName: "bare", isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: null },
    ]);
  });

  it("ModelProviderService.listModelOptions 分页读取并按 id 去重", async () => {
    const pages: Array<{ data: JsonValue[]; nextCursor: string | null }> = [
      { data: [CATALOG[0]!], nextCursor: "next" },
      { data: [CATALOG[1]!, CATALOG[0]!], nextCursor: null },
    ];
    const service = new ModelProviderService({
      controlPlane: {
        configRead: async () => ({ config: {}, origins: {}, layers: [] }),
        configBatchWrite: async () => ({ status: "ok", version: "v1", overriddenMetadata: null }),
        modelList: async () => pages.shift() ?? { data: [], nextCursor: null },
      },
      codexBin: "/fixture/codex",
      codexHome: "/tmp/codex-home",
      cliRunner: async () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    });
    const options = await service.listModelOptions();
    expect(options.map((option) => option.id)).toEqual(["gpt-default", "gpt-b"]);
    expect(options[0]?.isDefault).toBe(true);
  });
});

describe("粘性覆盖的不确定状态与配置改写", () => {
  it("显式强度下发结果不确定后改回跟随默认：仍下发默认强度（未知 ≠ 模型默认）", async () => {
    const connection = new ModelFakeConnection({ threadModel: "gpt-default", threadEffort: null, config: {}, catalog: CATALOG });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    connection.failNextTurn = true;
    await expect(turn(runtime, threadRef, { model: null, reasoningEffort: "high" })).rejects.toThrow();
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: undefined, effort: "high" },
      { model: undefined, effort: "medium" },
      { model: undefined, effort: undefined },
    ]);
  });

  it("已生效的显式强度再改值失败，随后改回跟随默认：下发默认强度把线程改回来", async () => {
    const connection = new ModelFakeConnection({ threadModel: "gpt-default", threadEffort: null, config: {}, catalog: CATALOG });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: null, reasoningEffort: "high" });
    connection.failNextTurn = true;
    await expect(turn(runtime, threadRef, { model: null, reasoningEffort: "low" })).rejects.toThrow();
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: undefined, effort: "high" },
      { model: undefined, effort: "low" },
      { model: undefined, effort: "medium" },
    ]);
  });

  it("改写模型相关配置后：显式会话重新下发，从未覆盖的维度仍不下发，覆盖过的跟随默认会话下发新默认", async () => {
    const connection = new ModelFakeConnection({
      threadModel: "gpt-default",
      threadEffort: "medium",
      config: { model: "gpt-default", model_reasoning_effort: "medium" },
    });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: null });
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: null });
    await runtime
      .configBatchWrite({ edits: [{ keyPath: "model", mergeStrategy: "upsert", value: "gpt-new" }], expectedVersion: "v1", reloadUserConfig: true })
      .catch(() => undefined);
    connection.options.config = { model: "gpt-new", model_reasoning_effort: "medium" };
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: null });
    await turn(runtime, threadRef, { model: null, reasoningEffort: null });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: "gpt-b", effort: undefined },
      { model: undefined, effort: undefined },
      // 现值未知：显式模型重新下发；强度从未覆盖过，交给 Codex。
      { model: "gpt-b", effort: undefined },
      // 模型覆盖过、现在跟随默认：下发新的全局默认。
      { model: "gpt-new", effort: undefined },
    ]);
  });

  it("与模型无关的配置改写（如 MCP）不影响追踪", async () => {
    const connection = new ModelFakeConnection({ threadModel: "gpt-default" });
    const runtime = createRuntime(connection);
    const threadRef = await startThread(runtime);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    await runtime
      .configBatchWrite({ edits: [{ keyPath: "mcp_servers.docs", mergeStrategy: "upsert", value: {} }], expectedVersion: "v1", reloadUserConfig: true })
      .catch(() => undefined);
    await turn(runtime, threadRef, { model: "gpt-b", reasoningEffort: "high" });
    expect(connection.turnStarts().map(modelFields)).toEqual([
      { model: "gpt-b", effort: "high" },
      { model: undefined, effort: undefined },
    ]);
  });
});
