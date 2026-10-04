import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  JsonValue,
  ModelProviderSettingsDto,
  ProxyConnectivityDto,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
  UpdateModelProviderResult,
} from "@suduo/client-contracts";
import { McpService, type McpCliCommand, type McpControlPlane } from "../src/application/mcp-service.js";
import {
  ModelProviderService,
  type ModelProviderControlPlane,
} from "../src/application/model-provider-service.js";
import { ProxyConnectivityService } from "../src/application/proxy-connectivity-service.js";
import { SettingsService } from "../src/application/settings-service.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * `config` 分区：MCP、模型服务、网络代理与试连、Skill、Codex 配置文件、设置读写的报错与提示按请求语言生成。
 * 带 `x-suduo-locale: en` 出英文；不带时用夹具记下的 zh-CN，与迁移前逐字一致。
 * 字段在报错里用界面上的叫法（与以前前端把字段名换成界面叫法后的中文逐字相同）。
 * 请求头里的语言会被记下来，所以每个用例先断言不带头的中文，之后的中文断言显式带 zh-CN。
 */

const HOST = "127.0.0.1:8787";
const EN = { "x-suduo-locale": "en" };
const ZH = { "x-suduo-locale": "zh-CN" };

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    throw new Error("not used");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("not used");
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

const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

function setup(overrides: Parameters<typeof createMinimalHttpContext>[1] = {}) {
  const context = createMinimalHttpContext(new IdleRuntime(), overrides);
  contexts.push(context);
  const send = (method: "POST" | "PUT" | "PATCH", url: string, body: unknown, headers: Record<string, string> = {}) =>
    context.server.inject({
      method,
      url,
      headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", ...headers },
      payload: JSON.stringify(body),
    });
  const get = (url: string, headers: Record<string, string> = {}) =>
    context.server.inject({ method: "GET", url, headers: { host: HOST, ...headers } });
  return { ...context, send, get };
}

const errorOf = (response: { json(): unknown }) => (response.json() as { error: { code: string; message: string } }).error;

describe("网络代理与本机设置", () => {
  it("代理校验用界面上的字段叫法", async () => {
    const { send } = setup();
    expect(errorOf(await send("PATCH", "/api/v1/settings", { httpsProxy: "not a url" })).message).toBe(
      "HTTPS 代理 不是合法代理 URL",
    );
    expect(errorOf(await send("PATCH", "/api/v1/settings", { httpsProxy: "not a url" }, EN)).message).toBe(
      "HTTPS proxy isn't a valid proxy URL",
    );
    expect(errorOf(await send("PATCH", "/api/v1/settings", { allProxy: "http://user:pass@proxy.test" }, EN)).message).toBe(
      "Proxy for other connections can't include a username or password yet",
    );
    expect(errorOf(await send("PATCH", "/api/v1/settings", { noProxy: "a\nb" }, EN)).message).toBe(
      "No-proxy addresses can't contain line breaks",
    );
    expect(errorOf(await send("PATCH", "/api/v1/settings", { noProxy: 1 }, ZH)).message).toBe("不走代理的地址 必须是字符串");
    // 试连的草稿同样校验。
    expect(errorOf(await send("POST", "/api/v1/settings/proxy/test", { httpProxy: "ftp://proxy.test" }, EN)).message).toBe(
      "HTTP proxy supports only http, https, socks5, and socks5h",
    );
  });

  it("设置读写的其它报错", async () => {
    const { send } = setup();
    expect(errorOf(await send("PATCH", "/api/v1/settings", { defaultApprovalMode: "never" })).message).toBe(
      "defaultApprovalMode 仅允许 ask / auto / full",
    );
    expect(errorOf(await send("PATCH", "/api/v1/settings", { gitAutoCheckpointDefault: "yes" }, EN)).message).toBe(
      "gitAutoCheckpointDefault must be a boolean",
    );
  });

  it("环境变量锁定全局 Skill 时的说明", async () => {
    const context = setup();
    const settings = new SettingsService(join(context.projectRoot, "locked-settings.json"), { SUDUO_GLOBAL_SKILLS: "1" });
    await expect(settings.update({ globalSkills: false })).rejects.toMatchObject({
      statusCode: 409,
      message: "globalSkills 已被环境变量 SUDUO_GLOBAL_SKILLS 锁定",
    });
    const error = await settings.update({ globalSkills: false }).catch((cause: unknown) => cause);
    expect((error as { localizedMessage(locale: "en"): string }).localizedMessage("en")).toBe(
      "globalSkills is locked by the SUDUO_GLOBAL_SKILLS environment variable",
    );
  });

  it("试连结论的说明按请求语言（界面另按 failure 渲染）", async () => {
    const context = createMinimalHttpContext(new IdleRuntime());
    contexts.push(context);
    const settings = new SettingsService(join(context.projectRoot, "probe-settings.json"));
    const service = new ProxyConnectivityService(settings, { modelGatewayBaseUrl: async () => "ftp://models.example" });
    const zh = await service.test({}, "zh-CN");
    const en = await service.test({}, "en");
    expect(zh).toMatchObject({ failure: { reason: "invalid-base-url" }, message: "当前模型网关地址无效，无法进行连通性检查" });
    expect(en).toMatchObject({
      failure: { reason: "invalid-base-url" },
      message: "The model service URL is invalid, so the connection can't be checked",
    } satisfies Partial<ProxyConnectivityDto>);
  });
});

describe("模型服务", () => {
  it("字段校验用界面上的叫法", async () => {
    const { send } = setup();
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { baseUrl: "ftp://models.example" })).message).toBe(
      "服务地址 仅支持 http/https",
    );
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { baseUrl: "ftp://models.example" }, EN)).message).toBe(
      "Service URL must use http or https",
    );
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { model: 'bad"model' }, EN)).message).toBe(
      "Default model isn't a valid model name",
    );
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { contextWindow: 10 }, ZH)).message).toBe(
      "上下文上限 必须是 4000 ~ 100000000 之间的整数（tokens）",
    );
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { contextWindow: 10 }, EN)).message).toBe(
      "Context limit must be a whole number from 4,000 to 100,000,000 (tokens)",
    );
    // 夹具里的 Codex 没给用户配置层版本。
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { model: "gpt-x" }, EN)).message).toBe(
      "Codex didn't return a version for your user config layer, so SuDuo didn't write the change: it can't be written safely without one",
    );
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { model: "gpt-x" }, ZH)).message).toBe(
      "Codex 未返回可写 user 配置层版本，拒绝无版本保护的写入",
    );
  });

  it("第一次配置没填地址：句中的普通单词 model 不会被换成界面叫法（以前前端按单词改写会误伤）", async () => {
    const control = new OverriddenControlPlane();
    control.configured = false;
    const modelProvider = new ModelProviderService({
      controlPlane: control,
      codexBin: "/fixture/codex",
      codexHome: "/tmp/suduo-codex-home",
      cliRunner: async () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    });
    const { send } = setup({ modelProvider });
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { model: "gpt-x" })).message).toBe(
      "第一次配置模型服务需要填写服务地址",
    );
    expect(errorOf(await send("PUT", "/api/v1/settings/model-provider", { model: "gpt-x" }, EN)).message).toBe(
      "Enter a service URL to set up the model service for the first time",
    );
  });

  it("密钥来源与保存结果的说明按请求语言", async () => {
    const control = new OverriddenControlPlane();
    const modelProvider = new ModelProviderService({
      controlPlane: control,
      codexBin: "/fixture/codex",
      codexHome: "/tmp/suduo-codex-home",
      cliRunner: async () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    });
    const { get, send } = setup({ modelProvider });
    const envKey = "SUDUO_TEST_MISSING_KEY_FOR_I18N";
    delete process.env[envKey];
    control.envKey = envKey;

    const zh = (await get("/api/v1/settings/model-provider")).json() as ModelProviderSettingsDto;
    expect(zh.apiKeyMasked).toBe(`来自环境变量 ${envKey}（本机服务启动时没有这个变量）`);
    const en = (await get("/api/v1/settings/model-provider", EN)).json() as ModelProviderSettingsDto;
    expect(en.apiKeyMasked).toBe(`From the environment variable ${envKey} (not set when the local service started)`);

    const savedEn = (await send("PUT", "/api/v1/settings/model-provider", { model: "gpt-x" }, EN)).json() as UpdateModelProviderResult;
    expect(savedEn).toMatchObject({
      status: "okOverridden",
      message: "Saved to your config, but a higher-level config overrides it. The value in effect is still gpt-managed. managed policy",
      settings: { apiKeyMasked: `From the environment variable ${envKey} (not set when the local service started)` },
    });
    const savedZh = (await send("PUT", "/api/v1/settings/model-provider", { model: "gpt-x" }, ZH)).json() as UpdateModelProviderResult;
    expect(savedZh.message).toBe("已写入你的配置，但被上层配置覆盖，当前生效值仍是 gpt-managed。managed policy");
  });
});

describe("MCP", () => {
  it("校验报错与保存结果的说明按请求语言", async () => {
    const mcp = new McpService({
      controlPlane: new QuietMcpControlPlane(),
      codexBin: "/fixture/codex",
      codexHome: "/tmp/suduo-codex-home",
      cliRunner: async (command: McpCliCommand) => {
        if (command.args[1] === "get") {
          return {
            status: 0,
            stdout: Buffer.from(
              JSON.stringify({ name: "files", enabled: true, transport: { type: "stdio", command: "node", args: [], env_vars: [] } }),
            ),
            stderr: Buffer.alloc(0),
          };
        }
        return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    const { send } = setup({ mcp });
    const create = (body: unknown, headers: Record<string, string> = {}) =>
      send("POST", "/api/v1/mcp/servers", body, headers);

    expect(errorOf(await create({ name: "1bad", transport: { type: "stdio", command: "node" } })).message).toBe(
      "MCP 名称仅允许字母开头的字母、数字、下划线或连字符（最多 64 位）",
    );
    expect(errorOf(await create({ name: "1bad", transport: { type: "stdio", command: "node" } }, EN)).message).toBe(
      "MCP names must start with a letter and use only letters, digits, underscores, or hyphens (up to 64 characters)",
    );
    expect(errorOf(await create({ name: "files", transport: { type: "ws" } }, EN)).message).toBe(
      "transport.type must be stdio or http",
    );
    expect(((await create({ name: "files", transport: { type: "stdio", command: "node" } }, EN)).json() as { message: string }).message).toBe(
      "Added the MCP server through Codex's official interface and reloaded it.",
    );
    expect(((await create({ name: "files", transport: { type: "stdio", command: "node" } }, ZH)).json() as { message: string }).message).toBe(
      "已通过 Codex 官方接口新增并重载 MCP 服务器。",
    );
  });
});

describe("Skill 与 Codex 配置文件", () => {
  it("安装报错按请求语言", async () => {
    const { send } = setup();
    const install = (headers: Record<string, string> = {}) =>
      send("POST", "/api/v1/skills/install", { source: "folder", path: "/nonexistent-suduo-skill" }, headers);
    expect(errorOf(await install()).message).toBe("文件夹不存在：/nonexistent-suduo-skill");
    expect(errorOf(await install(EN)).message).toBe("Folder not found: /nonexistent-suduo-skill");
    expect(errorOf(await send("POST", "/api/v1/skills/install", { source: "zip", fileName: "a.zip", dataBase64: "" }, EN)).message).toBe(
      "The zip has no content",
    );
  });

  it("只能打开当前 CODEX_HOME 的 config.toml", async () => {
    const { send } = setup({ codexHome: "/tmp/suduo-codex-home", openCodexConfigFile: async () => undefined });
    const open = (headers: Record<string, string> = {}) =>
      send("POST", "/api/v1/codex/config-file/open", { path: "/etc/other.toml" }, headers);
    expect(errorOf(await open()).message).toBe("只能打开当前 CODEX_HOME 的 config.toml");
    expect(errorOf(await open(EN)).message).toBe("Only config.toml in the current CODEX_HOME can be opened");
  });
});

/** 已有模型服务（密钥从环境变量取），保存时被上层配置覆盖。 */
class OverriddenControlPlane implements ModelProviderControlPlane {
  envKey = "";
  /** false：Codex 里还没有模型服务。 */
  configured = true;

  async configRead() {
    const config: Record<string, JsonValue> = this.configured
      ? {
          model_provider: "relay",
          model_providers: { relay: { name: "Relay", base_url: "https://relay.example/v1", env_key: this.envKey } },
        }
      : {};
    return { config, origins: {}, layers: [{ name: { type: "user" }, version: "v1", config: {} }] };
  }

  async configBatchWrite() {
    return {
      status: "okOverridden" as const,
      version: "v2",
      overriddenMetadata: {
        effectiveValue: "gpt-managed",
        message: "managed policy",
        overridingLayer: { type: "enterpriseManaged" },
      },
    };
  }

  async modelList() {
    return { data: [], nextCursor: null };
  }
}

class QuietMcpControlPlane implements McpControlPlane {
  async configRead() {
    return { config: {}, origins: {}, layers: [] };
  }
  async configBatchWrite(): Promise<never> {
    throw new Error("not used");
  }
  async mcpServerStatusList() {
    return { data: [], nextCursor: null };
  }
  async mcpServerOauthLogin(): Promise<never> {
    throw new Error("not used");
  }
  async mcpServerRefresh() {
    return undefined;
  }
}
