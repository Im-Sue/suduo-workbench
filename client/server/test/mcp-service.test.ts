import { describe, expect, it } from "vitest";
import type { JsonValue } from "@suduo/client-contracts";
import {
  McpService,
  runMcpCli,
  type McpCliCommand,
  type McpControlPlane,
} from "../src/application/mcp-service.js";

const SERVER = {
  name: "filesystem",
  enabled: true,
  disabled_reason: null,
  transport: {
    type: "stdio",
    command: "node",
    args: ["server.mjs"],
    env: null,
    env_vars: [],
    cwd: null,
  },
  startup_timeout_sec: null,
  tool_timeout_sec: null,
  auth_status: "unsupported",
};

describe("McpService · Codex 官方 MCP 控制面", () => {
  it("stdio add 从不带 --env，变量名仅由 config/batchWrite 写入", async () => {
    const control = new FakeControlPlane();
    const commands: McpCliCommand[] = [];
    const service = createService(control, async (command) => {
      commands.push(command);
      return cliResult(command);
    });

    await expect(
      service.create({
        name: "filesystem",
        transport: {
          type: "stdio",
          command: "node",
          args: ["server.mjs"],
          envVars: ["LOCAL_TOKEN"],
        },
      }),
    ).resolves.toMatchObject({ atomic: true });

    const add = commands.find((command) => command.args.slice(0, 3).join(" ") === "mcp add filesystem");
    expect(add).toMatchObject({
      bin: "/fixture/codex",
      args: ["mcp", "add", "filesystem", "--", "node", "server.mjs"],
      env: { CODEX_HOME: "/isolated/codex-home" },
    });
    expect(add?.args).not.toContain("--env");
    expect(control.writeCalls).toContainEqual(
      expect.objectContaining({
        edits: [
          expect.objectContaining({
            keyPath: "mcp_servers.filesystem.env_vars",
            value: ["LOCAL_TOKEN"],
          }),
        ],
      }),
    );
    expect(JSON.stringify(commands)).not.toContain("LOCAL_TOKEN=");
  });

  it("HTTP add 仅传 bearer token 的环境变量名，并读取 streamable_http 输出", async () => {
    const control = new FakeControlPlane();
    const commands: McpCliCommand[] = [];
    const httpServer = {
      name: "httpfixture",
      enabled: true,
      disabled_reason: null,
      transport: {
        type: "streamable_http",
        url: "https://mcp.example.test/mcp",
        bearer_token_env_var: "MCP_TOKEN",
        http_headers: null,
        env_http_headers: null,
      },
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: "bearer_token",
    };
    const service = createService(control, async (command) => {
      commands.push(command);
      return {
        status: 0,
        stdout: Buffer.from(JSON.stringify(command.args[1] === "list" ? [httpServer] : httpServer)),
        stderr: Buffer.alloc(0),
      };
    });

    await expect(
      service.create({
        name: "httpfixture",
        transport: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          bearerTokenEnvVar: "MCP_TOKEN",
        },
      }),
    ).resolves.toMatchObject({
      server: { transport: "http", bearerTokenEnvVar: "MCP_TOKEN", envVars: [] },
    });
    expect(commands.find((command) => command.args[1] === "add")?.args).toEqual([
      "mcp",
      "add",
      "httpfixture",
      "--url",
      "https://mcp.example.test/mcp",
      "--bearer-token-env-var",
      "MCP_TOKEN",
    ]);
  });

  it("通过官方状态 RPC 映射认证态与工具数；无官方失败原文时保持 null", async () => {
    const control = new FakeControlPlane();
    control.statusData = [
      {
        name: "filesystem",
        serverInfo: { name: "filesystem", version: "1" },
        tools: { read: { name: "read" }, write: { name: "write" } },
        resources: [],
        resourceTemplates: [],
        authStatus: "oAuth",
      },
    ];
    const service = createService(control);

    await expect(service.list()).resolves.toMatchObject({
      statusAvailable: true,
      items: [
        {
          name: "filesystem",
          transport: "stdio",
          status: {
            startupState: "ready",
            startupFailureReason: null,
            authenticationStatus: "oAuth",
            toolCount: 2,
          },
        },
      ],
    });
    expect(control.statusCalls).toEqual([{ detail: "full" }]);

    control.statusData = [
      {
        name: "filesystem",
        serverInfo: null,
        tools: {},
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
      },
    ];
    await expect(service.list()).resolves.toMatchObject({
      items: [
        { status: { startupState: "unknown", startupFailureReason: null } },
      ],
    });

    // 新版 Codex 在 toolsError 里给出启动失败原文：判为失败并原样透出。
    control.statusData = [
      {
        name: "filesystem",
        serverInfo: null,
        tools: {},
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
        toolsError: "MCP startup failed: No such file or directory (os error 2)",
        runtimeStatus: null,
      },
    ];
    await expect(service.list()).resolves.toMatchObject({
      items: [
        {
          status: {
            startupState: "failed",
            startupFailureReason: "MCP startup failed: No such file or directory (os error 2)",
          },
        },
      ],
    });
  });

  it("RPC 可用时 PATCH 用一次 config/batchWrite 原子替换，且带 user 版本", async () => {
    const control = new FakeControlPlane();
    const service = createService(control);

    await expect(
      service.update("filesystem", { envVars: ["LOCAL_TOKEN"], enabled: false }),
    ).resolves.toMatchObject({ atomic: true });
    expect(control.writeCalls).toHaveLength(1);
    expect(control.writeCalls[0]).toMatchObject({
      expectedVersion: "user-v1",
      reloadUserConfig: true,
      edits: [
        {
          keyPath: "mcp_servers.filesystem",
          mergeStrategy: "upsert",
          value: expect.objectContaining({
            enabled: false,
            env_vars: ["LOCAL_TOKEN"],
          }),
        },
      ],
    });
  });

  it("RPC 不可用时仅在 CLI 能无损表达时降级，并明确返回非原子", async () => {
    const control = new FakeControlPlane();
    control.readError = new Error("Codex app-server connection unavailable");
    const commands: McpCliCommand[] = [];
    const service = createService(control, async (command) => {
      commands.push(command);
      return cliResult(command);
    });

    await expect(
      service.update("filesystem", {
        transport: { type: "stdio", command: "node", args: ["new-server.mjs"] },
      }),
    ).resolves.toMatchObject({ atomic: false, message: expect.stringContaining("非原子") });
    expect(commands.map((command) => command.args.slice(0, 3))).toContainEqual([
      "mcp",
      "remove",
      "filesystem",
    ]);
    expect(commands.map((command) => command.args.slice(0, 3))).toContainEqual([
      "mcp",
      "add",
      "filesystem",
    ]);
  });

  it("串行 mutex 使并发写配置的 add 不会重叠", async () => {
    const control = new FakeControlPlane();
    let releaseFirst: (() => void) | undefined;
    const firstAdd = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const commands: McpCliCommand[] = [];
    const service = createService(control, async (command) => {
      commands.push(command);
      if (command.args[1] === "add" && command.args[2] === "alpha") {
        await firstAdd;
      }
      return cliResult(command);
    });

    const alpha = service.create({
      name: "alpha",
      transport: { type: "stdio", command: "node", args: ["alpha.mjs"] },
    });
    const beta = service.create({
      name: "beta",
      transport: { type: "stdio", command: "node", args: ["beta.mjs"] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.filter((command) => command.args[1] === "add")).toHaveLength(1);
    releaseFirst?.();
    await Promise.all([alpha, beta]);
    expect(commands.filter((command) => command.args[1] === "add").map((command) => command.args[2])).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("官方 CLI runner 实际截断超量输出并终止超时进程", async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    await expect(
      runMcpCli({
        bin: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(8192))"],
        env,
        maxOutputBytes: 1024,
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ outputLimitExceeded: true, stdout: expect.any(Buffer) });
    await expect(
      runMcpCli({
        bin: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 10000)"],
        env,
        maxOutputBytes: 1024,
        timeoutMs: 25,
      }),
    ).resolves.toMatchObject({ timedOut: true });
  });

  it("OAuth / logout / refresh 逐件走官方 RPC 或 CLI", async () => {
    const control = new FakeControlPlane();
    const commands: McpCliCommand[] = [];
    const service = createService(control, async (command) => {
      commands.push(command);
      return cliResult(command);
    });

    await expect(service.login("filesystem", { scopes: ["tools.read"] })).resolves.toEqual({
      authorizationUrl: "https://login.fixture/authorize",
    });
    await service.logout("filesystem");
    await service.refresh();

    expect(control.oauthCalls).toEqual([{ name: "filesystem", scopes: ["tools.read"] }]);
    expect(control.refreshes).toBeGreaterThanOrEqual(2);
    expect(commands).toContainEqual(
      expect.objectContaining({ args: ["mcp", "logout", "filesystem"] }),
    );
  });
});

function createService(
  control: FakeControlPlane,
  cliRunner: (command: McpCliCommand) => Promise<ReturnType<typeof cliResult>> = async (command) =>
    cliResult(command),
): McpService {
  return new McpService({
    controlPlane: control,
    codexBin: "/fixture/codex",
    codexHome: "/isolated/codex-home",
    cliRunner,
  });
}

function cliResult(command: McpCliCommand) {
  const action = command.args[1];
  const server =
    action === "get" && typeof command.args[2] === "string"
      ? { ...SERVER, name: command.args[2] }
      : SERVER;
  const payload = action === "list" ? [SERVER] : server;
  return {
    status: 0,
    stdout: Buffer.from(JSON.stringify(payload)),
    stderr: Buffer.alloc(0),
  };
}

class FakeControlPlane implements McpControlPlane {
  config: Record<string, JsonValue> = {
    mcp_servers: { filesystem: { command: "node", args: ["server.mjs"] } },
  };
  readError: Error | null = null;
  statusData: JsonValue[] = [];
  statusCalls: Array<{ cursor?: string; limit?: number; detail?: "full" | "toolsAndAuthOnly" }> = [];
  writeCalls: Array<{
    edits: Array<{ keyPath: string; mergeStrategy: "replace" | "upsert"; value: JsonValue }>;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }> = [];
  oauthCalls: Array<{ name: string; scopes?: string[]; timeoutSecs?: number }> = [];
  refreshes = 0;

  async configRead() {
    if (this.readError) {
      throw this.readError;
    }
    return {
      config: structuredClone(this.config),
      origins: {},
      layers: [
        {
          name: { type: "user", file: "/isolated/config.toml" },
          version: "user-v1",
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
    return { status: "ok" as const, version: "user-v2", overriddenMetadata: null };
  }

  async mcpServerStatusList(input: {
    cursor?: string;
    limit?: number;
    detail?: "full" | "toolsAndAuthOnly";
  } = {}) {
    this.statusCalls.push(input);
    return { data: this.statusData, nextCursor: null };
  }

  async mcpServerOauthLogin(input: {
    name: string;
    scopes?: string[];
    timeoutSecs?: number;
  }) {
    this.oauthCalls.push(input);
    return { authorizationUrl: "https://login.fixture/authorize" };
  }

  async mcpServerRefresh(): Promise<void> {
    this.refreshes += 1;
  }
}
