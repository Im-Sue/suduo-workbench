import { spawn } from "node:child_process";
import {
  isReasoningEffort,
  type CodexModelOptionDto,
  type JsonValue,
  type ModelProviderConfigOrigin,
  type ModelProviderSettingsDto,
  type UpdateModelProviderRequest,
  type UpdateModelProviderResult,
} from "@suduo/client-contracts";
import { ApiError } from "./api-error.js";
import { parseCodexModelCatalog } from "../infrastructure/runtime/codex/codex-model-overrides.js";
import { decodeWindowsCommandOutput } from "../infrastructure/platform/windows-command-output.js";

export interface ModelProviderControlPlane {
  configRead(input: {
    includeLayers: boolean;
    cwd?: string;
  }): Promise<{
    config: Record<string, JsonValue>;
    origins: Record<string, JsonValue>;
    layers: Array<{ name: JsonValue; version: string; config: JsonValue }>;
  }>;
  configBatchWrite(input: {
    edits: Array<{
      keyPath: string;
      mergeStrategy: "replace" | "upsert";
      value: JsonValue;
    }>;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<{
    status: "ok" | "okOverridden";
    version: string;
    overriddenMetadata: {
      effectiveValue: JsonValue;
      message: string;
      overridingLayer: JsonValue;
    } | null;
  }>;
  modelList(input?: {
    cursor?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<{ data: JsonValue[]; nextCursor: string | null }>;
}

export interface CodexCliCommand {
  bin: string;
  args: string[];
  input?: string;
  env: Record<string, string>;
}

export interface CodexCliResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: Error;
}

export type CodexCliRunner = (
  command: CodexCliCommand,
) => Promise<CodexCliResult>;

export interface ModelProviderServiceOptions {
  controlPlane: ModelProviderControlPlane;
  codexBin: string;
  /** 显式传入，避免 CLI 触及调用者的真实 CODEX_HOME。 */
  codexHome: string;
  cliRunner?: CodexCliRunner;
}

/** 第一次在界面里配置模型服务时建立的提供方（形状同 scripts/templates/codex-config.template.toml）。 */
const INITIAL_PROVIDER_ID = "suduo";
const INITIAL_PROVIDER_NAME = "SuDuo 模型服务";

interface ConfigState {
  /** 各层合并后的生效配置（读显示值用）。 */
  config: Record<string, JsonValue>;
  /**
   * 用户自己那一层（config.toml）的原文。写入与回滚都以它为准：还原要还原成「用户文件里原来的样子」，
   * 不能把别的层合并进来的值（或反序列化补出的 null 字段）写回用户文件。
   */
  userConfig: Record<string, JsonValue>;
  expectedVersion: string;
  /** null：Codex 里还没有模型服务（config 没有 model_provider）。 */
  providerId: string | null;
  settings: Omit<ModelProviderSettingsDto, "apiKeyMasked">;
}

interface ConfigEdit {
  keyPath: string;
  nextValue: JsonValue;
  previousValue: JsonValue;
}

/**
 * 模型服务配置只经官方 Codex 接口读写：app-server Config/Model RPC 与 login CLI。
 * 不解析或写入 Codex 的私有文件格式，也不把未保存的凭据用于模型探测。
 */
export class ModelProviderService {
  private readonly cliRunner: CodexCliRunner;
  private readonly cliEnvironment: Record<string, string>;

  constructor(private readonly options: ModelProviderServiceOptions) {
    this.cliRunner = options.cliRunner ?? runCodexCli;
    this.cliEnvironment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      CODEX_HOME: options.codexHome,
    };
  }

  async get(): Promise<ModelProviderSettingsDto> {
    const state = await this.readState();
    const credential = await this.credentialSource(state);
    return {
      ...state.settings,
      apiKeyMasked: credential?.label ?? null,
      apiKeySource: credential?.source ?? null,
    };
  }

  /**
   * 密钥从哪里来（只说来源，不回传密钥本身）：
   * - 提供方配置了 `auth.command`：Codex 每次运行这条本机命令取 Key（例如从 macOS 钥匙串读）；
   * - 提供方配置了 `env_key`：Codex 从这个环境变量取 Key；
   * - 否则看 Codex 自己的登录（codex login status）。
   * 都没有时返回 null（界面显示「未配置」）。
   */
  private async credentialSource(
    state: ConfigState,
  ): Promise<{ source: "command" | "env" | "codex-login"; label: string } | null> {
    const provider = state.providerId === null ? null : providerConfig(state.config, state.providerId);
    const command = stringValue(asObject(provider?.["auth"])?.["command"]);
    if (command) {
      // 只取程序名：整串写法（如 `printf sk-…`）里的参数不能带进标签。
      const program = command.trim().split(/\s+/)[0] ?? "";
      return { source: "command", label: "由本机命令提供（" + (program.split(/[\\/]/).pop() || "命令") + "）" };
    }
    const envKey = stringValue(provider?.["env_key"]);
    if (envKey) {
      // Codex 继承本机服务的环境：这里读不到，它也读不到。
      const present = (process.env[envKey] ?? "") !== "";
      return { source: "env", label: "来自环境变量 " + envKey + (present ? "" : "（本机服务启动时没有这个变量）") };
    }
    // Codex 官方 login status 不会回传密钥，UI 只显示受 Codex 管理的登录态。
    return (await this.isLoggedIn()) ? { source: "codex-login", label: "由 Codex 管理" } : null;
  }

  /** 保存配置后以官方 model/list 验证；验证失败时回写本次改动前的字段值。 */
  async update(
    input: UpdateModelProviderRequest,
  ): Promise<UpdateModelProviderResult> {
    const baseUrl = input.baseUrl === undefined ? undefined : requireBaseUrl(input.baseUrl);
    const apiKey = input.apiKey === undefined ? undefined : requireApiKey(input.apiKey);
    const model = input.model === undefined ? undefined : requireModel(input.model);
    const reasoningEffort =
      input.reasoningEffort === undefined
        ? undefined
        : requireReasoningEffort(input.reasoningEffort);
    const contextWindow =
      input.contextWindow === undefined
        ? undefined
        : requireContextWindow(input.contextWindow);
    if (
      baseUrl === undefined &&
      apiKey === undefined &&
      model === undefined &&
      reasoningEffort === undefined &&
      contextWindow === undefined
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", "没有提供任何要修改的字段");
    }

    const before = await this.readState();
    const user = before.userConfig;
    const edits: ConfigEdit[] = [];
    if (before.providerId === null) {
      // 还没有自定义模型服务（Codex 在用内置默认）：这次保存改用团队的模型服务，必须带地址。
      // - 用户文件里没有 [model_providers.suduo]：整表建立，还原时整表写 null 删掉
      //   （逐字段写 null 会留下空表，Codex 拒收：provider name must not be empty）；
      // - 已有这张表：只改地址，不动用户写的其余字段，还原时把地址写回原值。
      // 改前值一律取用户文件原文。密钥不写进配置，仍由下面的 codex login 交给 Codex 保管。
      if (baseUrl === undefined) {
        throw new ApiError(400, "VALIDATION_ERROR", "第一次配置模型服务需要填写服务地址");
      }
      const existing = providerConfig(user, INITIAL_PROVIDER_ID);
      if (existing === null) {
        edits.push({
          keyPath: "model_providers." + INITIAL_PROVIDER_ID,
          nextValue: { name: INITIAL_PROVIDER_NAME, base_url: baseUrl, wire_api: "responses" },
          previousValue: null,
        });
      } else {
        edits.push({
          keyPath: "model_providers." + INITIAL_PROVIDER_ID + ".base_url",
          nextValue: baseUrl,
          previousValue: existing["base_url"] ?? null,
        });
      }
      edits.push({ keyPath: "model_provider", nextValue: INITIAL_PROVIDER_ID, previousValue: user["model_provider"] ?? null });
    } else if (baseUrl !== undefined) {
      edits.push({
        keyPath: "model_providers." + before.providerId + ".base_url",
        nextValue: baseUrl,
        previousValue: readProviderString(user, before.providerId, "base_url"),
      });
    }
    if (model !== undefined) {
      edits.push({
        keyPath: "model",
        nextValue: model === "" ? null : model,
        previousValue: user["model"] ?? null,
      });
    }
    if (reasoningEffort !== undefined) {
      edits.push({
        keyPath: "model_reasoning_effort",
        nextValue: reasoningEffort,
        previousValue: user["model_reasoning_effort"] ?? null,
      });
    }
    if (contextWindow !== undefined) {
      edits.push({
        keyPath: "model_context_window",
        nextValue: contextWindow,
        previousValue: user["model_context_window"] ?? null,
      });
    }

    // login 的 stdin 是唯一包含 API key 的管道；不会在日志、命令行或 RPC 参数中出现。
    if (apiKey !== undefined) {
      await this.loginWithApiKey(apiKey);
    }

    let write:
      | Awaited<ReturnType<ModelProviderControlPlane["configBatchWrite"]>>
      | undefined;
    try {
      if (edits.length > 0) {
        write = await this.options.controlPlane.configBatchWrite({
          edits: edits.map((edit) => ({
            keyPath: edit.keyPath,
            mergeStrategy: "upsert",
            value: edit.nextValue,
          })),
          expectedVersion: before.expectedVersion,
          reloadUserConfig: true,
        });
      }
      // ModelListParams 无草稿 base_url/key；这里只验证已经保存进 Codex 的配置。
      await this.options.controlPlane.modelList({ limit: 1 });
    } catch (error) {
      if (write) {
        await this.rollback(edits, write.version, error);
      }
      throw error;
    }

    const settings = await this.get();
    if (write?.status === "okOverridden") {
      const metadata = write.overriddenMetadata;
      const effective = metadata ? formatEffectiveValue(metadata.effectiveValue) : "上层配置";
      return {
        settings,
        status: "okOverridden",
        message:
          "已写入你的配置，但被上层配置覆盖，当前生效值仍是 " +
          effective +
          (metadata?.message ? "。" + metadata.message : "。"),
      };
    }
    return {
      settings,
      status: "ok",
      // model/list 只说明 Codex 读得了新配置（它的清单可能来自内置目录、不经过网络），
      // 不代表服务地址连得上、Key 有效——那要靠「测试连接」实际连一次。
      message: "已保存，Codex 已读取新配置；新配置将在下一个回合生效。",
    };
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.options.controlPlane.modelList({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      for (const item of result.data) {
        const candidate = asObject(item);
        const id = candidate ? candidate["id"] : undefined;
        if (typeof id === "string" && id !== "") {
          models.push(id);
        }
      }
      if (result.nextCursor === null) {
        break;
      }
      cursor = result.nextCursor;
    }
    return [...new Set(models)];
  }

  /**
   * model/list 的产品化投影（展示名、是否默认、支持的推理强度），供会话级参数选择器使用。
   * 与 listModels 同一次分页读取口径；同 id 只保留第一条。
   */
  async listModelOptions(): Promise<CodexModelOptionDto[]> {
    const data: JsonValue[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.options.controlPlane.modelList({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      });
      data.push(...result.data);
      if (result.nextCursor === null) {
        break;
      }
      cursor = result.nextCursor;
    }
    const seen = new Set<string>();
    return parseCodexModelCatalog(data).filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }

  /** 仅读取当前生效模型网关地址，供代理连通性检查构造无副作用的 /models 请求。 */
  async modelGatewayBaseUrl(): Promise<string> {
    return (await this.readState()).settings.baseUrl;
  }

  private async readState(): Promise<ConfigState> {
    const result = await this.options.controlPlane.configRead({ includeLayers: true });
    // 没有 model_provider 是「还没配置」，不是错误：设置页据此显示空表单，第一次保存时建立模型服务。
    const providerId = stringValue(result.config["model_provider"]) || null;
    const provider = providerId === null ? null : providerConfig(result.config, providerId);
    const baseUrl = stringValue(provider?.["base_url"]) ?? "";
    const providerName = providerId === null ? "" : (stringValue(provider?.["name"]) ?? providerId);
    const contextWindow = result.config["model_context_window"];
    return {
      config: result.config,
      userConfig: userLayerConfig(result.layers),
      expectedVersion: userLayerVersion(result.layers),
      providerId,
      settings: {
        configured: providerId !== null,
        providerId: providerId ?? "",
        providerName,
        baseUrl,
        model: stringValue(result.config["model"]),
        reasoningEffort: stringValue(result.config["model_reasoning_effort"]),
        contextWindow:
          typeof contextWindow === "number" && Number.isInteger(contextWindow)
            ? contextWindow
            : null,
        origins: {
          providerId: originFor(result.origins, "model_provider"),
          baseUrl:
            (providerId === null
              ? null
              : originFor(result.origins, "model_providers." + providerId + ".base_url")) ??
            originFor(result.origins, "model_providers"),
          model: originFor(result.origins, "model"),
          reasoningEffort: originFor(result.origins, "model_reasoning_effort"),
          contextWindow: originFor(result.origins, "model_context_window"),
        },
      },
    };
  }

  private async rollback(
    edits: readonly ConfigEdit[],
    expectedVersion: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.options.controlPlane.configBatchWrite({
        edits: edits.map((edit) => ({
          keyPath: edit.keyPath,
          mergeStrategy: "upsert",
          value: edit.previousValue,
        })),
        expectedVersion,
        reloadUserConfig: true,
      });
    } catch (rollbackError) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Codex 模型验证失败，且自动还原遇到版本冲突：" +
          messageOf(originalError) +
          "；还原错误：" +
          messageOf(rollbackError),
      );
    }
  }

  private async loginWithApiKey(apiKey: string): Promise<void> {
    const result = await this.cliRunner({
      bin: this.options.codexBin,
      args: ["login", "--with-api-key"],
      input: apiKey + "\n",
      env: this.cliEnvironment,
    });
    if (result.status !== 0) {
      throw new ApiError(
        409,
        "RUNTIME_REQUEST_FAILED",
        "Codex API Key 登录失败：" + commandFailure(result),
      );
    }
  }

  private async isLoggedIn(): Promise<boolean> {
    const result = await this.cliRunner({
      bin: this.options.codexBin,
      args: ["login", "status"],
      env: this.cliEnvironment,
    });
    return result.status === 0;
  }
}

function userLayerVersion(
  layers: readonly { name: JsonValue; version: string; config: JsonValue }[],
): string {
  const user = layers.find((layer) => {
    const source = asObject(layer.name);
    return source?.["type"] === "user";
  });
  if (!user) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Codex 未返回可写 user 配置层版本，拒绝无版本保护的写入",
    );
  }
  return user.version;
}

/** 用户层（config.toml）的原文；没有这一层时视为空文件。 */
function userLayerConfig(
  layers: readonly { name: JsonValue; version: string; config: JsonValue }[],
): Record<string, JsonValue> {
  const user = layers.find((layer) => asObject(layer.name)?.["type"] === "user");
  return asObject(user?.config) ?? {};
}

function providerConfig(
  config: Record<string, JsonValue>,
  providerId: string,
): Record<string, JsonValue> | null {
  const providers = asObject(config["model_providers"]);
  return providers ? asObject(providers[providerId]) : null;
}

function readProviderString(
  config: Record<string, JsonValue>,
  providerId: string,
  key: string,
): JsonValue {
  return providerConfig(config, providerId)?.[key] ?? null;
}

function originFor(
  origins: Record<string, JsonValue>,
  key: string,
): ModelProviderConfigOrigin | null {
  const source = asObject(origins[key]);
  if (!source || typeof source["version"] !== "string" || !("name" in source)) {
    return null;
  }
  return { name: source["name"], version: source["version"] };
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function formatEffectiveValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function requireBaseUrl(value: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", "baseUrl 必须是字符串");
  }
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "baseUrl 不是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(400, "VALIDATION_ERROR", "baseUrl 仅支持 http/https");
  }
  return trimmed;
}

function requireApiKey(value: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", "apiKey 必须是字符串");
  }
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 512 || /[\r\n]/.test(trimmed)) {
    throw new ApiError(400, "VALIDATION_ERROR", "apiKey 格式无效");
  }
  return trimmed;
}

function requireModel(value: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", "model 必须是字符串");
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(trimmed)) {
    throw new ApiError(400, "VALIDATION_ERROR", "model 名称格式无效");
  }
  return trimmed;
}

/**
 * 推理强度是「模型声明的非空字符串」（新版模型有 max / ultra，也可能不支持 minimal）：
 * 与会话级一样只校验格式，某个模型支持哪几档由界面按模型清单给出。
 */
function requireReasoningEffort(value: string): string {
  if (!isReasoningEffort(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "reasoningEffort 格式无效");
  }
  return value;
}

function requireContextWindow(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 4_000 ||
    value > 100_000_000
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "contextWindow 必须是 4000 ~ 100000000 之间的整数（tokens）",
    );
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandFailure(result: CodexCliResult): string {
  const output = commandOutput(result.stderr) || commandOutput(result.stdout);
  return result.error?.message ?? (output || "exit=" + String(result.status));
}

/** 复用 Windows 字节双解码，避免 CLI 管道错误信息在旧 PowerShell 下乱码。 */
function commandOutput(value: Buffer): string {
  const decoded = decodeWindowsCommandOutput(value);
  return (process.platform === "win32" ? decoded.gbk : decoded.utf8).trim() ||
    decoded.utf8.trim();
}

async function runCodexCli(command: CodexCliCommand): Promise<CodexCliResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(command.bin, command.args, {
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command.bin),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let error: Error | undefined;
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (cause: Error) => {
      error = cause;
    });
    child.once("close", (status) => {
      resolveResult({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(error === undefined ? {} : { error }),
      });
    });
    child.stdin?.end(command.input ?? "");
  });
}
