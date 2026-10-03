import { spawn } from "node:child_process";
import type { JsonValue, McpServerDto, McpServerStatusDto } from "@suduo/client-contracts";
import { decodeWindowsCommandOutput } from "../infrastructure/platform/windows-command-output.js";
import { ApiError } from "./api-error.js";

const DEFAULT_CLI_TIMEOUT_MS = 20_000;
const DEFAULT_CLI_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_MCP_STATUS_PAGES = 10;

export interface McpControlPlane {
  configRead(input: { includeLayers: boolean }): Promise<{
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
  mcpServerStatusList(input?: {
    cursor?: string;
    limit?: number;
    detail?: "full" | "toolsAndAuthOnly";
  }): Promise<{ data: JsonValue[]; nextCursor: string | null }>;
  mcpServerOauthLogin(input: {
    name: string;
    scopes?: string[];
    timeoutSecs?: number;
  }): Promise<{ authorizationUrl: string }>;
  mcpServerRefresh(): Promise<void>;
}

export interface McpCliCommand {
  bin: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface McpCliResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
  error?: Error;
}

export type McpCliRunner = (command: McpCliCommand) => Promise<McpCliResult>;

export interface McpServiceOptions {
  controlPlane: McpControlPlane;
  codexBin: string;
  /** 显式传入，确保 CLI 与 app-server 使用同一份 SuDuo 隔离配置。 */
  codexHome: string;
  cliRunner?: McpCliRunner;
  cliTimeoutMs?: number;
  cliOutputLimitBytes?: number;
}

export type McpTransportInput =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      envVars?: string[];
    }
  | {
      type: "http";
      url: string;
      bearerTokenEnvVar?: string | null;
    };

export type CreateMcpServerInput = {
  name: string;
  transport: McpTransportInput;
  enabled?: boolean;
  startupTimeoutSeconds?: number;
  toolTimeoutSeconds?: number;
};

export type UpdateMcpServerInput = {
  transport?: McpTransportInput;
  enabled?: boolean;
  envVars?: string[];
  startupTimeoutSeconds?: number;
  toolTimeoutSeconds?: number;
};

export interface McpUpdateResult {
  server: McpServerDto;
  atomic: boolean;
  message: string;
}

export interface McpListResult {
  items: McpServerDto[];
  /** app-server 不可用时仍返回 CLI 配置，并显式标记运行态未知。 */
  statusAvailable: boolean;
}

interface NormalizedServer {
  name: string;
  transport:
    | {
        type: "stdio";
        command: string;
        args: string[];
      }
    | {
        type: "http";
        url: string;
        bearerTokenEnvVar: string | null;
      };
  enabled: boolean;
  envVars: string[];
  startupTimeoutSeconds: number | null;
  toolTimeoutSeconds: number | null;
}

type CliServer = NormalizedServer;

/**
 * MCP 薄封装：配置只通过 Codex CLI / app-server 官方入口读写。
 * 绝不读取或写入 config.toml，也不承载任何密钥值。
 */
export class McpService {
  private readonly cliRunner: McpCliRunner;
  private readonly cliEnvironment: Record<string, string>;
  private readonly cliTimeoutMs: number;
  private readonly cliOutputLimitBytes: number;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: McpServiceOptions) {
    this.cliRunner = options.cliRunner ?? runMcpCli;
    this.cliTimeoutMs = options.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.cliOutputLimitBytes =
      options.cliOutputLimitBytes ?? DEFAULT_CLI_OUTPUT_LIMIT_BYTES;
    this.cliEnvironment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      CODEX_HOME: options.codexHome,
    };
  }

  async list(): Promise<McpListResult> {
    const servers = await this.listCli();
    try {
      const statuses = await this.listStatuses();
      return {
        items: servers.map((server) => toDto(server, statuses.get(server.name))),
        statusAvailable: true,
      };
    } catch {
      return {
        items: servers.map((server) => toDto(server, undefined)),
        statusAvailable: false,
      };
    }
  }

  async get(name: string): Promise<McpServerDto> {
    const server = await this.getCli(requireName(name));
    try {
      const statuses = await this.listStatuses();
      return toDto(server, statuses.get(server.name));
    } catch {
      return toDto(server, undefined);
    }
  }

  async create(input: CreateMcpServerInput): Promise<McpUpdateResult> {
    const server = normalizeCreate(input);
    return await this.withWriteMutex(async () => {
      await this.runCliOrThrow(this.addCommand(server));
      try {
        if (server.transport.type === "stdio" && server.envVars.length > 0) {
          await this.writeEnvVars(server.name, server.envVars);
        }
        await this.options.controlPlane.mcpServerRefresh();
      } catch (error) {
        // add 成功而 env_vars 写入失败时不留下一个看似可用、实则缺关键引用的半成品。
        await this.removeAfterFailedCreate(server.name, error);
      }
      return {
        server: await this.get(server.name),
        atomic: true,
        message: "已通过 Codex 官方接口新增并重载 MCP 服务器。",
      };
    });
  }

  async update(name: string, input: UpdateMcpServerInput): Promise<McpUpdateResult> {
    const serverName = requireName(name);
    const patch = normalizeUpdate(input);
    return await this.withWriteMutex(async () => {
      const current = await this.get(serverName);
      const next = mergeServer(current, patch);
      try {
        const config = await this.options.controlPlane.configRead({ includeLayers: true });
        assertConfigContainsServer(config.config, serverName);
        await this.options.controlPlane.configBatchWrite({
          edits: [
            {
              keyPath: "mcp_servers." + serverName,
              mergeStrategy: "upsert",
              value: toConfigValue(next),
            },
          ],
          expectedVersion: userLayerVersion(config.layers),
          reloadUserConfig: true,
        });
        await this.options.controlPlane.mcpServerRefresh();
        return {
          server: await this.get(serverName),
          atomic: true,
          message: "已通过 Codex config/batchWrite 原子更新并重载 MCP 服务器。",
        };
      } catch (error) {
        if (!isControlPlaneUnavailable(error)) {
          throw toRuntimeError(error, "Codex MCP 原子更新失败");
        }
        if (!canFallbackToCli(next)) {
          throw new ApiError(
            503,
            "RUNTIME_UNAVAILABLE",
            "Codex RPC 不可用，且本次修改含 CLI 无法安全表达的字段；未执行非原子替换。",
          );
        }
        await this.runCliOrThrow({
          bin: this.options.codexBin,
          args: ["mcp", "remove", serverName],
          env: this.cliEnvironment,
          timeoutMs: this.cliTimeoutMs,
          maxOutputBytes: this.cliOutputLimitBytes,
        });
        await this.runCliOrThrow(this.addCommand(next));
        return {
          server: await this.get(serverName),
          atomic: false,
          message: "已用 Codex CLI 非原子替换；若后续步骤失败，请按原配置重建服务器。",
        };
      }
    });
  }

  async remove(name: string): Promise<{ removed: true }> {
    const serverName = requireName(name);
    return await this.withWriteMutex(async () => {
      await this.runCliOrThrow({
        bin: this.options.codexBin,
        args: ["mcp", "remove", serverName],
        env: this.cliEnvironment,
        timeoutMs: this.cliTimeoutMs,
        maxOutputBytes: this.cliOutputLimitBytes,
      });
      await this.options.controlPlane.mcpServerRefresh();
      return { removed: true };
    });
  }

  async login(
    name: string,
    input: { scopes?: string[]; timeoutSeconds?: number } = {},
  ): Promise<{ authorizationUrl: string }> {
    const serverName = requireName(name);
    const scopes = input.scopes === undefined ? undefined : requireScopes(input.scopes);
    const timeoutSecs =
      input.timeoutSeconds === undefined
        ? undefined
        : requireTimeoutSeconds(input.timeoutSeconds, "timeoutSeconds");
    return await this.withWriteMutex(async () =>
      await this.options.controlPlane.mcpServerOauthLogin({
        name: serverName,
        ...(scopes === undefined ? {} : { scopes }),
        ...(timeoutSecs === undefined ? {} : { timeoutSecs }),
      }),
    );
  }

  async logout(name: string): Promise<{ loggedOut: true }> {
    const serverName = requireName(name);
    return await this.withWriteMutex(async () => {
      await this.runCliOrThrow({
        bin: this.options.codexBin,
        args: ["mcp", "logout", serverName],
        env: this.cliEnvironment,
        timeoutMs: this.cliTimeoutMs,
        maxOutputBytes: this.cliOutputLimitBytes,
      });
      await this.options.controlPlane.mcpServerRefresh();
      return { loggedOut: true };
    });
  }

  async refresh(): Promise<McpListResult> {
    return await this.withWriteMutex(async () => {
      await this.options.controlPlane.mcpServerRefresh();
      return await this.list();
    });
  }

  private async listCli(): Promise<CliServer[]> {
    const result = await this.runCliOrThrow({
      bin: this.options.codexBin,
      args: ["mcp", "list", "--json"],
      env: this.cliEnvironment,
      timeoutMs: this.cliTimeoutMs,
      maxOutputBytes: this.cliOutputLimitBytes,
    });
    const parsed = parseJson(result.stdout, "Codex MCP 列表");
    if (!Array.isArray(parsed)) {
      throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 列表返回了无效 JSON");
    }
    return parsed.map((entry) => parseCliServer(entry));
  }

  private async getCli(name: string): Promise<CliServer> {
    const result = await this.runCliOrThrow({
      bin: this.options.codexBin,
      args: ["mcp", "get", name, "--json"],
      env: this.cliEnvironment,
      timeoutMs: this.cliTimeoutMs,
      maxOutputBytes: this.cliOutputLimitBytes,
    });
    const server = parseCliServer(parseJson(result.stdout, "Codex MCP 详情"));
    if (server.name !== name) {
      throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 详情名称不匹配");
    }
    return server;
  }

  private async listStatuses(): Promise<Map<string, JsonValue>> {
    const results = new Map<string, JsonValue>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MCP_STATUS_PAGES; page += 1) {
      const response = await this.options.controlPlane.mcpServerStatusList({
        detail: "full",
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of response.data) {
        const value = asObject(item);
        const name = value ? value["name"] : undefined;
        if (typeof name === "string") {
          results.set(name, item);
        }
      }
      if (response.nextCursor === null) {
        return results;
      }
      cursor = response.nextCursor;
    }
    throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 状态分页未结束");
  }

  private async writeEnvVars(name: string, envVars: string[]): Promise<void> {
    const config = await this.options.controlPlane.configRead({ includeLayers: true });
    assertConfigContainsServer(config.config, name);
    await this.options.controlPlane.configBatchWrite({
      edits: [
        {
          keyPath: "mcp_servers." + name + ".env_vars",
          mergeStrategy: "upsert",
          value: envVars,
        },
      ],
      expectedVersion: userLayerVersion(config.layers),
      reloadUserConfig: true,
    });
  }

  private async removeAfterFailedCreate(name: string, originalError: unknown): Promise<never> {
    try {
      await this.runCliOrThrow({
        bin: this.options.codexBin,
        args: ["mcp", "remove", name],
        env: this.cliEnvironment,
        timeoutMs: this.cliTimeoutMs,
        maxOutputBytes: this.cliOutputLimitBytes,
      });
    } catch {
      throw new ApiError(
        503,
        "RUNTIME_REQUEST_FAILED",
        "MCP 新增后的官方配置写入失败，且自动清理失败；请检查 Codex 配置后手动删除该服务器。",
      );
    }
    throw toRuntimeError(originalError, "MCP 新增后的官方配置写入失败，已自动清理");
  }

  private async runCliOrThrow(command: McpCliCommand): Promise<McpCliResult> {
    const result = await this.cliRunner(command);
    if (result.timedOut) {
      throw new ApiError(504, "RUNTIME_REQUEST_FAILED", "Codex MCP 命令执行超时");
    }
    if (result.outputLimitExceeded) {
      throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 命令输出超过安全上限");
    }
    if (result.status !== 0) {
      throw new ApiError(
        503,
        "RUNTIME_REQUEST_FAILED",
        "Codex MCP 命令失败：" + safeCommandFailure(result),
      );
    }
    return result;
  }

  private addCommand(server: NormalizedServer): McpCliCommand {
    const args = ["mcp", "add", server.name];
    if (server.transport.type === "stdio") {
      // --env 接受 KEY=VALUE；绝不能把仅有的变量名错误地传给它。
      args.push("--", server.transport.command, ...server.transport.args);
    } else {
      args.push("--url", server.transport.url);
      if (server.transport.bearerTokenEnvVar !== null) {
        args.push("--bearer-token-env-var", server.transport.bearerTokenEnvVar);
      }
    }
    return {
      bin: this.options.codexBin,
      args,
      env: this.cliEnvironment,
      timeoutMs: this.cliTimeoutMs,
      maxOutputBytes: this.cliOutputLimitBytes,
    };
  }

  private async withWriteMutex<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.writeTail;
    this.writeTail = next;
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

/** 异步 CLI runner：超时与 stdout/stderr 都有硬上限，避免异常服务拖垮 BFF。 */
export async function runMcpCli(command: McpCliCommand): Promise<McpCliResult> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_CLI_OUTPUT_LIMIT_BYTES;
  return await new Promise((resolveResult) => {
    const child = spawn(command.bin, command.args, {
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command.bin),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let error: Error | undefined;
    let complete = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    const collect = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        target.push(chunk.subarray(0, remaining));
        outputBytes += Math.min(remaining, chunk.length);
      }
      if (chunk.length > remaining) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (cause: Error) => {
      error = cause;
    });
    child.once("close", (status) => {
      if (complete) {
        return;
      }
      complete = true;
      clearTimeout(timer);
      resolveResult({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(timedOut ? { timedOut: true } : {}),
        ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        ...(error === undefined ? {} : { error }),
      });
    });
  });
}

function normalizeCreate(input: CreateMcpServerInput): NormalizedServer {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "VALIDATION_ERROR", "MCP 新增请求必须是 JSON object");
  }
  return {
    name: requireName(input.name),
    transport: normalizeTransport(input.transport),
    enabled: input.enabled === undefined ? true : requireBoolean(input.enabled, "enabled"),
    envVars:
      input.transport?.type === "stdio"
        ? requireEnvVars(input.transport.envVars ?? [])
        : [],
    startupTimeoutSeconds:
      input.startupTimeoutSeconds === undefined
        ? null
        : requireTimeoutSeconds(input.startupTimeoutSeconds, "startupTimeoutSeconds"),
    toolTimeoutSeconds:
      input.toolTimeoutSeconds === undefined
        ? null
        : requireTimeoutSeconds(input.toolTimeoutSeconds, "toolTimeoutSeconds"),
  };
}

function normalizeUpdate(input: UpdateMcpServerInput): UpdateMcpServerInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "VALIDATION_ERROR", "MCP 编辑请求必须是 JSON object");
  }
  if (
    input.transport === undefined &&
    input.enabled === undefined &&
    input.envVars === undefined &&
    input.startupTimeoutSeconds === undefined &&
    input.toolTimeoutSeconds === undefined
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "没有提供任何要修改的 MCP 字段");
  }
  return {
    ...(input.transport === undefined
      ? {}
      : { transport: normalizeTransport(input.transport) }),
    ...(input.enabled === undefined
      ? {}
      : { enabled: requireBoolean(input.enabled, "enabled") }),
    ...(input.envVars === undefined ? {} : { envVars: requireEnvVars(input.envVars) }),
    ...(input.startupTimeoutSeconds === undefined
      ? {}
      : {
          startupTimeoutSeconds: requireTimeoutSeconds(
            input.startupTimeoutSeconds,
            "startupTimeoutSeconds",
          ),
        }),
    ...(input.toolTimeoutSeconds === undefined
      ? {}
      : { toolTimeoutSeconds: requireTimeoutSeconds(input.toolTimeoutSeconds, "toolTimeoutSeconds") }),
  };
}

function normalizeTransport(
  transport: McpTransportInput,
): NormalizedServer["transport"] {
  if (transport === null || typeof transport !== "object" || Array.isArray(transport)) {
    throw new ApiError(400, "VALIDATION_ERROR", "transport 必须是 JSON object");
  }
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: requireCommand(transport.command),
      args: requireArgs(transport.args ?? []),
    };
  }
  if (transport.type === "http") {
    return {
      type: "http",
      url: requireHttpUrl(transport.url),
      bearerTokenEnvVar:
        transport.bearerTokenEnvVar === undefined || transport.bearerTokenEnvVar === null
          ? null
          : requireEnvVar(transport.bearerTokenEnvVar),
    };
  }
  throw new ApiError(400, "VALIDATION_ERROR", "transport.type 仅允许 stdio 或 http");
}

function mergeServer(current: McpServerDto, patch: UpdateMcpServerInput): NormalizedServer {
  const transport =
    patch.transport === undefined
      ? transportFromDto(current)
      : normalizeTransport(patch.transport);
  const envVars =
    patch.envVars === undefined ? current.envVars : requireEnvVars(patch.envVars);
  if (transport.type !== "stdio" && patch.envVars !== undefined) {
    throw new ApiError(400, "VALIDATION_ERROR", "HTTP MCP 服务器不支持 envVars");
  }
  return {
    name: current.name,
    transport,
    enabled: patch.enabled === undefined ? current.enabled : requireBoolean(patch.enabled, "enabled"),
    envVars: transport.type === "stdio" ? envVars : [],
    startupTimeoutSeconds:
      patch.startupTimeoutSeconds === undefined
        ? current.startupTimeoutSeconds
        : requireTimeoutSeconds(patch.startupTimeoutSeconds, "startupTimeoutSeconds"),
    toolTimeoutSeconds:
      patch.toolTimeoutSeconds === undefined
        ? current.toolTimeoutSeconds
        : requireTimeoutSeconds(patch.toolTimeoutSeconds, "toolTimeoutSeconds"),
  };
}

function transportFromDto(dto: McpServerDto): NormalizedServer["transport"] {
  if (dto.transport === "stdio" && dto.command !== null) {
    return { type: "stdio", command: dto.command, args: dto.args };
  }
  if (dto.transport === "http" && dto.url !== null) {
    return {
      type: "http",
      url: dto.url,
      bearerTokenEnvVar: dto.bearerTokenEnvVar,
    };
  }
  throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 配置缺少传输字段");
}

function toConfigValue(server: NormalizedServer): JsonValue {
  const advanced = {
    enabled: server.enabled,
    ...(server.startupTimeoutSeconds === null
      ? {}
      : { startup_timeout_sec: server.startupTimeoutSeconds }),
    ...(server.toolTimeoutSeconds === null
      ? {}
      : { tool_timeout_sec: server.toolTimeoutSeconds }),
  };
  if (server.transport.type === "stdio") {
    return {
      ...advanced,
      command: server.transport.command,
      args: server.transport.args,
      env_vars: server.envVars,
    };
  }
  return {
    ...advanced,
    url: server.transport.url,
    bearer_token_env_var: server.transport.bearerTokenEnvVar,
  };
}

function canFallbackToCli(server: NormalizedServer): boolean {
  return server.enabled &&
    server.envVars.length === 0 &&
    server.startupTimeoutSeconds === null &&
    server.toolTimeoutSeconds === null;
}

function parseCliServer(value: unknown): CliServer {
  const root = asObjectUnknown(value);
  if (!root) {
    throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 返回项不是 object");
  }
  const name = requireProtocolString(root["name"], "Codex MCP name");
  const transport = asObjectUnknown(root["transport"]);
  if (!transport) {
    throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 返回项缺少 transport");
  }
  const enabled = root["enabled"];
  if (typeof enabled !== "boolean") {
    throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 返回项缺少 enabled");
  }
  const transportType = transport["type"];
  if (transportType === "stdio") {
    return {
      name,
      transport: {
        type: "stdio",
        command: requireProtocolString(transport["command"], "Codex MCP command"),
        args: protocolStringArray(transport["args"], "Codex MCP args"),
      },
      enabled,
      envVars: protocolStringArray(transport["env_vars"], "Codex MCP env_vars"),
      startupTimeoutSeconds: protocolNullableInteger(root["startup_timeout_sec"]),
      toolTimeoutSeconds: protocolNullableInteger(root["tool_timeout_sec"]),
    };
  }
  if (transportType === "streamable_http") {
    return {
      name,
      transport: {
        type: "http",
        url: requireProtocolString(transport["url"], "Codex MCP url"),
        bearerTokenEnvVar: protocolNullableString(transport["bearer_token_env_var"]),
      },
      enabled,
      envVars: [],
      startupTimeoutSeconds: protocolNullableInteger(root["startup_timeout_sec"]),
      toolTimeoutSeconds: protocolNullableInteger(root["tool_timeout_sec"]),
    };
  }
  throw new ApiError(502, "RUNTIME_REQUEST_FAILED", "Codex MCP 返回了未知 transport");
}

function toDto(server: CliServer, statusValue: JsonValue | undefined): McpServerDto {
  const status = mapStatus(server.name, statusValue);
  return {
    name: server.name,
    transport: server.transport.type,
    enabled: server.enabled,
    command: server.transport.type === "stdio" ? server.transport.command : null,
    args: server.transport.type === "stdio" ? server.transport.args : [],
    url: server.transport.type === "http" ? server.transport.url : null,
    envVars: server.envVars,
    bearerTokenEnvVar:
      server.transport.type === "http" ? server.transport.bearerTokenEnvVar : null,
    startupTimeoutSeconds: server.startupTimeoutSeconds,
    toolTimeoutSeconds: server.toolTimeoutSeconds,
    status,
  };
}

function mapStatus(name: string, value: JsonValue | undefined): McpServerStatusDto {
  const status = asObject(value);
  if (!status) {
    return unavailableStatus(name);
  }
  const tools = asObject(status["tools"]);
  const authStatus = status["authStatus"];
  const authenticationStatus =
    authStatus === "unsupported" ||
    authStatus === "notLoggedIn" ||
    authStatus === "bearerToken" ||
    authStatus === "oAuth"
      ? authStatus
      : "unknown";
  // 新版 Codex 在 toolsError 里给出启动失败的原文（如「MCP startup failed: …」），有就据此判为失败并原样透出；
  // 没有时 serverInfo=null 仍不是可靠的 failed 信号，保持 unknown，不把猜测伪装成官方诊断。
  const toolsError = typeof status["toolsError"] === "string" && status["toolsError"].trim() !== "" ? status["toolsError"] : null;
  const runtimeStatus = status["runtimeStatus"];
  return {
    name,
    startupState:
      toolsError !== null || runtimeStatus === "failed"
        ? "failed"
        : runtimeStatus === "starting"
          ? "starting"
          : runtimeStatus === "cancelled"
            ? "cancelled"
            : status["serverInfo"] === null
              ? "unknown"
              : "ready",
    startupFailureReason: toolsError,
    authenticationStatus,
    toolCount: tools ? Object.keys(tools).length : 0,
  };
}

function unavailableStatus(name: string): McpServerStatusDto {
  return {
    name,
    startupState: "unknown",
    startupFailureReason: null,
    authenticationStatus: "unknown",
    toolCount: 0,
  };
}

function requireName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "MCP 名称仅允许字母开头的字母、数字、下划线或连字符（最多 64 位）",
    );
  }
  return value;
}

function requireCommand(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 1024 || /[\r\n]/.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "MCP stdio command 格式无效");
  }
  return value;
}

function requireArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ApiError(400, "VALIDATION_ERROR", "MCP args 必须是不超过 64 项的字符串数组");
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 2048 || /[\r\n]/.test(item)) {
      throw new ApiError(400, "VALIDATION_ERROR", "MCP args 含有无效字符串");
    }
    if (/^(?:--?(?:token|api[-_]?key|password|secret)(?:=|$)|(?:token|api[-_]?key|password|secret)=)/iu.test(item)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "敏感值必须来自系统环境变量；stdio 参数不能传 token/key/password/secret",
      );
    }
    return item;
  });
}

function requireHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\r\n]/.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "MCP HTTP URL 格式无效");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "MCP HTTP URL 格式无效");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ApiError(400, "VALIDATION_ERROR", "MCP HTTP URL 仅支持无凭据的 http/https 地址");
  }
  return value;
}

function requireEnvVars(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ApiError(400, "VALIDATION_ERROR", "envVars 必须是不超过 32 项的环境变量名数组");
  }
  return [...new Set(value.map(requireEnvVar))];
}

function requireEnvVar(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "环境变量必须是合法变量名，不能传入变量值");
  }
  return value;
}

function requireScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ApiError(400, "VALIDATION_ERROR", "scopes 必须是不超过 32 项的字符串数组");
  }
  return value.map((scope) => {
    if (typeof scope !== "string" || scope.trim() === "" || scope.length > 256) {
      throw new ApiError(400, "VALIDATION_ERROR", "OAuth scope 格式无效");
    }
    return scope;
  });
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError(400, "VALIDATION_ERROR", label + " 必须是 boolean");
  }
  return value;
}

function requireTimeoutSeconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 86_400) {
    throw new ApiError(400, "VALIDATION_ERROR", label + " 必须是 1~86400 的整数秒数");
  }
  return value;
}

function parseJson(value: Buffer, label: string): unknown {
  try {
    return JSON.parse(commandOutput(value));
  } catch {
    throw new ApiError(502, "RUNTIME_REQUEST_FAILED", label + " 返回了无效 JSON");
  }
}

function assertConfigContainsServer(config: Record<string, JsonValue>, name: string): void {
  const servers = asObject(config["mcp_servers"]);
  if (!servers || !asObject(servers[name])) {
    throw new ApiError(404, "NOT_FOUND", "Codex MCP 服务器不存在：" + name);
  }
}

function userLayerVersion(
  layers: readonly { name: JsonValue; version: string; config: JsonValue }[],
): string {
  const user = layers.find((layer) => asObject(layer.name)?.["type"] === "user");
  if (!user) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Codex 未返回可写 user 配置层版本，拒绝无版本保护的写入",
    );
  }
  return user.version;
}

function isControlPlaneUnavailable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.statusCode === 503 || error.statusCode === 504;
  }
  return /(?:connection|closed|timeout|unavailable|econn|app-server)/iu.test(messageOf(error));
}

function toRuntimeError(error: unknown, prefix: string): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  return new ApiError(503, "RUNTIME_REQUEST_FAILED", prefix + "：" + messageOf(error));
}

function safeCommandFailure(result: McpCliResult): string {
  if (result.error) {
    return redactSensitiveText(result.error.message);
  }
  const output = commandOutput(result.stderr) || commandOutput(result.stdout);
  return output === "" ? "exit=" + String(result.status) : redactSensitiveText(output).slice(0, 2_000);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s]+/giu, "$1[redacted]")
    .replace(/((?:api[-_]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]");
}

function commandOutput(value: Buffer): string {
  const decoded = decodeWindowsCommandOutput(value);
  return (process.platform === "win32" ? decoded.gbk : decoded.utf8).trim() ||
    decoded.utf8.trim();
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function asObjectUnknown(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireProtocolString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ApiError(502, "RUNTIME_REQUEST_FAILED", label + " 无效");
  }
  return value;
}

function protocolStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ApiError(502, "RUNTIME_REQUEST_FAILED", label + " 无效");
  }
  return value;
}

function protocolNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : null;
}

function protocolNullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
