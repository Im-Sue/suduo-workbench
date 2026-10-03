import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@suduo/client-contracts";
import {
  ModelProviderService,
  type CodexCliCommand,
  type ModelProviderControlPlane,
} from "../src/application/model-provider-service.js";

const TEST_ENV_KEY = "SUDUO_TEST_MODEL_PROVIDER_KEY";

const CONFIG: Record<string, JsonValue> = {
  model_provider: "myapi",
  model: "gpt-5.5",
  model_reasoning_effort: "high",
  model_context_window: 400_000,
  model_providers: {
    myapi: {
      name: "My API",
      base_url: "https://old.example.com/v1",
      wire_api: "responses",
    },
  },
};

describe("ModelProviderService · Codex 官方控制面", () => {
  let home: string;
  let controlPlane: FakeControlPlane;
  let commands: CodexCliCommand[];

  beforeEach(() => {
    // 每个夹具都有独立 CODEX_HOME；CLI 被 stub，不会写真实登录态或发起模型调用。
    home = mkdtempSync(join(tmpdir(), "suduo-mp-official-"));
    controlPlane = new FakeControlPlane();
    commands = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const service = () =>
    new ModelProviderService({
      controlPlane,
      codexBin: "/fixture/codex",
      codexHome: home,
      cliRunner: async (command) => {
        commands.push(command);
        return { status: 0, stdout: Buffer.from("logged in"), stderr: Buffer.alloc(0) };
      },
    });

  it("以 includeLayers 读取嵌套 provider，并保留逐字段来源", async () => {
    const dto = await service().get();
    expect(dto).toMatchObject({
      providerId: "myapi",
      providerName: "My API",
      baseUrl: "https://old.example.com/v1",
      apiKeyMasked: "由 Codex 管理",
      model: "gpt-5.5",
      reasoningEffort: "high",
      contextWindow: 400_000,
      origins: {
        baseUrl: { version: "user-v1" },
        model: { version: "user-v1" },
      },
    });
    expect(controlPlane.readCalls).toEqual([{ includeLayers: true }]);
    expect(commands).toMatchObject([{ args: ["login", "status"], env: { CODEX_HOME: home } }]);
  });

  it("用一次 batchWrite 保存逐字段配置，再用 model/list 验证", async () => {
    const result = await service().update({
      baseUrl: "https://new.example.com/v1",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      contextWindow: 1_000_000,
    });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("Codex 已读取新配置");
    expect(controlPlane.writeCalls).toHaveLength(1);
    expect(controlPlane.writeCalls[0]).toMatchObject({
      expectedVersion: "user-v1",
      reloadUserConfig: true,
      edits: [
        {
          keyPath: "model_providers.myapi.base_url",
          mergeStrategy: "upsert",
          value: "https://new.example.com/v1",
        },
        { keyPath: "model", value: "gpt-5.6-sol" },
        { keyPath: "model_reasoning_effort", value: "medium" },
        { keyPath: "model_context_window", value: 1_000_000 },
      ],
    });
    expect(controlPlane.modelListCalls).toEqual([{ limit: 1 }]);
    expect(result.settings).toMatchObject({
      baseUrl: "https://new.example.com/v1",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      contextWindow: 1_000_000,
    });
  });

  it("密钥来源：提供方的取 Key 命令、环境变量优先于 Codex 登录，只说来源不回传密钥", async () => {
    controlPlane.config = {
      model_provider: "relay",
      model_providers: {
        relay: { name: "Relay", base_url: "https://relay.example.com/v1", wire_api: "responses", auth: { command: "/usr/bin/security", args: ["find-generic-password", "-w"] } },
      },
    };
    expect(await service().get()).toMatchObject({ apiKeyMasked: "由本机命令提供（security）", apiKeySource: "command" });
    controlPlane.config = {
      model_provider: "relay",
      model_providers: { relay: { name: "Relay", base_url: "https://relay.example.com/v1", wire_api: "responses", env_key: TEST_ENV_KEY } },
    };
    // 用测试专用的变量名，并先确保它不在：开发机或 CI 上碰巧设了同名变量也不影响结果。
    const saved = process.env[TEST_ENV_KEY];
    delete process.env[TEST_ENV_KEY];
    try {
      expect(await service().get()).toMatchObject({ apiKeyMasked: `来自环境变量 ${TEST_ENV_KEY}（本机服务启动时没有这个变量）`, apiKeySource: "env" });
      process.env[TEST_ENV_KEY] = "set-for-test";
      expect(await service().get()).toMatchObject({ apiKeyMasked: `来自环境变量 ${TEST_ENV_KEY}`, apiKeySource: "env" });
    } finally {
      if (saved === undefined) delete process.env[TEST_ENV_KEY];
      else process.env[TEST_ENV_KEY] = saved;
    }
    controlPlane.config = {
      model_provider: "relay",
      model_providers: { relay: { name: "Relay", base_url: "https://relay.example.com/v1", wire_api: "responses", auth: { command: "printf sk-should-not-leak" } } },
    };
    expect((await service().get()).apiKeyMasked).toBe("由本机命令提供（printf）");
    // 都是配置自带的来源，不需要去问 codex login status。
    expect(commands.filter((command) => command.args[1] === "status")).toHaveLength(0);
  });

  it("还没有模型服务时报告「未配置」，不再当作错误", async () => {
    controlPlane.config = {};
    const dto = await service().get();
    expect(dto).toMatchObject({ configured: false, providerId: "", providerName: "", baseUrl: "" });
  });

  it("第一次保存建立 SuDuo 的模型服务并设为当前使用，再用 model/list 验证", async () => {
    controlPlane.config = {};
    const result = await service().update({ baseUrl: "https://gateway.example.com/v1", apiKey: "sk-test-1234567890" });
    expect(commands.find((command) => command.args[1] === "--with-api-key")).toBeDefined();
    expect(controlPlane.writeCalls[0]?.edits).toEqual([
      {
        keyPath: "model_providers.suduo",
        mergeStrategy: "upsert",
        value: { name: "SuDuo 模型服务", base_url: "https://gateway.example.com/v1", wire_api: "responses" },
      },
      { keyPath: "model_provider", mergeStrategy: "upsert", value: "suduo" },
    ]);
    expect(controlPlane.modelListCalls).toEqual([{ limit: 1 }]);
    expect(result.settings).toMatchObject({ configured: true, providerId: "suduo", baseUrl: "https://gateway.example.com/v1" });
  });

  it("第一次保存没填地址时说明原因；验证失败时把建立的模型服务撤掉", async () => {
    controlPlane.config = {};
    await expect(service().update({ model: "gpt-5.5" })).rejects.toMatchObject({ statusCode: 400, message: "第一次配置模型服务需要填写服务地址" });
    controlPlane.modelListError = new Error("401 Unauthorized");
    await expect(service().update({ baseUrl: "https://gateway.example.com/v1" })).rejects.toThrow("401");
    expect(controlPlane.config["model_provider"] ?? null).toBeNull();
    expect((controlPlane.config["model_providers"] as Record<string, JsonValue> | undefined)?.["suduo"] ?? null).toBeNull();
  });

  it("用户文件里已有 suduo 表（但没设为当前）：只补地址与当前指向，不改用户写的字段；失败时逐字段还原成原样", async () => {
    controlPlane.config = {
      model_providers: {
        suduo: { name: "我自己的网关", base_url: "https://mine.example.com/v1", wire_api: "responses", env_key: "MY_KEY" },
      },
    };
    controlPlane.modelListError = new Error("config reload failed");
    await expect(service().update({ baseUrl: "https://gateway.example.com/v1" })).rejects.toThrow("config reload failed");
    expect(controlPlane.writeCalls[0]?.edits).toEqual([
      { keyPath: "model_providers.suduo.base_url", mergeStrategy: "upsert", value: "https://gateway.example.com/v1" },
      { keyPath: "model_provider", mergeStrategy: "upsert", value: "suduo" },
    ]);
    expect(controlPlane.writeCalls[1]?.edits).toEqual([
      { keyPath: "model_providers.suduo.base_url", mergeStrategy: "upsert", value: "https://mine.example.com/v1" },
      { keyPath: "model_provider", mergeStrategy: "upsert", value: null },
    ]);
    expect(controlPlane.config).toEqual({
      model_provider: null,
      model_providers: {
        suduo: { name: "我自己的网关", base_url: "https://mine.example.com/v1", wire_api: "responses", env_key: "MY_KEY" },
      },
    });
  });

  it("okOverridden 走独立返回路径，绝不显示已生效", async () => {
    controlPlane.nextWrite = {
      status: "okOverridden",
      version: "user-v2",
      overriddenMetadata: {
        effectiveValue: "gpt-managed",
        message: "managed policy",
        overridingLayer: { type: "enterpriseManaged", id: "policy", name: "Corp" },
      },
    };
    const result = await service().update({ model: "gpt-5.6-sol" });
    expect(result).toMatchObject({
      status: "okOverridden",
      message: expect.stringContaining("已写入你的配置，但被上层配置覆盖，当前生效值仍是 gpt-managed"),
    });
    expect(result.message).not.toContain("已保存并通过");
  });

  it("官方模型验证失败后按写入后的 version 一键还原保存前字段", async () => {
    controlPlane.modelListError = new Error("provider unavailable");
    await expect(service().update({ baseUrl: "https://new.example.com/v1" })).rejects.toThrow(
      "provider unavailable",
    );
    expect(controlPlane.writeCalls).toHaveLength(2);
    expect(controlPlane.writeCalls[1]).toMatchObject({
      expectedVersion: "user-v2",
      reloadUserConfig: true,
      edits: [
        {
          keyPath: "model_providers.myapi.base_url",
          value: "https://old.example.com/v1",
        },
      ],
    });
  });

  it("API key 仅通过 codex login --with-api-key 的 stdin 提交", async () => {
    await service().update({ apiKey: "sk-isolated-12345678" });
    expect(commands[0]).toMatchObject({
      bin: "/fixture/codex",
      args: ["login", "--with-api-key"],
      input: "sk-isolated-12345678\n",
      env: { CODEX_HOME: home },
    });
    expect(controlPlane.writeCalls).toHaveLength(0);
    expect(controlPlane.modelListCalls).toEqual([{ limit: 1 }]);
  });

  it("Codex login 失败时不会写配置或进入模型验证", async () => {
    const failed = new ModelProviderService({
      controlPlane,
      codexBin: "/fixture/codex",
      codexHome: home,
      cliRunner: async () => ({
        status: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("login rejected"),
      }),
    });
    await expect(failed.update({ apiKey: "sk-isolated-12345678" })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("login rejected"),
    });
    expect(controlPlane.writeCalls).toHaveLength(0);
    expect(controlPlane.modelListCalls).toHaveLength(0);
  });

  it("官方模型清单分页去重，不自 fetch provider /models", async () => {
    controlPlane.pages = [
      { data: [{ id: "gpt-5.5" }, { id: "gpt-5.6-sol" }], nextCursor: "next" },
      { data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }], nextCursor: null },
    ];
    await expect(service().listModels()).resolves.toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(controlPlane.modelListCalls).toEqual([{ limit: 100 }, { cursor: "next", limit: 100 }]);
  });

  it("拒绝空更新、非法 URL、带换行 key 与非法模型字段", async () => {
    await expect(service().update({})).rejects.toMatchObject({ statusCode: 400 });
    await expect(service().update({ baseUrl: "not-a-url" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service().update({ apiKey: "bad\nkey-123456" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service().update({ model: 'bad"model' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service().update({ contextWindow: 100 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service().update({ reasoningEffort: "Bad Effort" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("推理强度按格式校验：新版模型的 max / ultra 也能设为默认", async () => {
    await service().update({ reasoningEffort: "ultra" });
    const edit = controlPlane.writeCalls.at(-1)?.edits.find((item) => item.keyPath === "model_reasoning_effort");
    expect(edit?.value).toBe("ultra");
  });
});

class FakeControlPlane implements ModelProviderControlPlane {
  config = structuredClone(CONFIG);
  readCalls: Array<{ includeLayers: boolean; cwd?: string }> = [];
  writeCalls: Array<{
    edits: Array<{ keyPath: string; mergeStrategy: "replace" | "upsert"; value: JsonValue }>;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }> = [];
  modelListCalls: Array<{ cursor?: string; includeHidden?: boolean; limit?: number }> = [];
  nextWrite: {
    status: "ok" | "okOverridden";
    version: string;
    overriddenMetadata: {
      effectiveValue: JsonValue;
      message: string;
      overridingLayer: JsonValue;
    } | null;
  } | null = null;
  modelListError: Error | null = null;
  pages: Array<{ data: JsonValue[]; nextCursor: string | null }> | null = null;
  private userVersion = "user-v1";

  async configRead(input: { includeLayers: boolean; cwd?: string }) {
    this.readCalls.push(input);
    return {
      config: structuredClone(this.config),
      origins: {
        model_provider: origin(this.userVersion),
        model: origin(this.userVersion),
        model_reasoning_effort: origin(this.userVersion),
        model_context_window: origin(this.userVersion),
        "model_providers.myapi.base_url": origin(this.userVersion),
      },
      layers: [
        {
          name: { type: "user", file: "/isolated/config.toml" },
          version: this.userVersion,
          config: structuredClone(this.config),
        },
      ],
    };
  }

  async configBatchWrite(input: {
    edits: Array<{ keyPath: string; mergeStrategy: "replace" | "upsert"; value: JsonValue }>;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }) {
    this.writeCalls.push(structuredClone(input));
    if (input.expectedVersion !== this.userVersion) {
      throw new Error("version conflict");
    }
    for (const edit of input.edits) {
      writePath(this.config, edit.keyPath, edit.value);
    }
    this.userVersion = "user-v" + String(this.writeCalls.length + 1);
    const result = this.nextWrite ?? {
      status: "ok" as const,
      version: this.userVersion,
      overriddenMetadata: null,
    };
    this.nextWrite = null;
    return result;
  }

  async modelList(input: { cursor?: string; includeHidden?: boolean; limit?: number } = {}) {
    this.modelListCalls.push(input);
    if (this.modelListError) {
      throw this.modelListError;
    }
    if (this.pages) {
      return this.pages[this.modelListCalls.length - 1] ?? { data: [], nextCursor: null };
    }
    return { data: [{ id: "gpt-5.5" }], nextCursor: null };
  }
}

function origin(version: string): JsonValue {
  return { name: { type: "user", file: "/isolated/config.toml" }, version };
}

function writePath(root: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) {
    throw new Error("invalid key path");
  }
  let target = root;
  for (const part of parts) {
    const current = target[part];
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      target[part] = {};
    }
    target = target[part] as Record<string, JsonValue>;
  }
  target[key] = value;
}
