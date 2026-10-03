import type { McpServerDto } from "@suduo/client-contracts";
import { describe, expect, it } from "vitest";
import { buildMcpUpdate, draftFor, formatArgs, parseArgs } from "../src/features/settings/mcp-edit.js";

const server = (patch: Partial<McpServerDto> = {}): McpServerDto =>
  ({
    name: "db",
    transport: "stdio",
    command: "/opt/db-mcp/server",
    args: ["--root", "/Users/me/My Projects", "", 'say "hi"', "a\\b"],
    envVars: ["DB_TOKEN"],
    url: null,
    bearerTokenEnvVar: null,
    enabled: true,
    ...patch,
  }) as McpServerDto;

describe("MCP 参数的显示与解析", () => {
  it("含空格、空串、引号、反斜杠的参数往返无损", () => {
    const args = server().args;
    const text = formatArgs(args);
    expect(text).toBe('--root "/Users/me/My Projects" "" "say \\"hi\\"" "a\\\\b"');
    expect(parseArgs(text)).toEqual({ ok: true, args });
  });

  it("单引号原样、引号外反斜杠转义、多余空白忽略", () => {
    expect(parseArgs("  -x   'a b'  c\\ d ")).toEqual({ ok: true, args: ["-x", "a b", "c d"] });
  });

  it("引号没闭合时报错，不猜", () => {
    expect(parseArgs('--root "/Users/me')).toMatchObject({ ok: false });
  });
});

describe("编辑 MCP 服务时只发改了的部分", () => {
  it("什么都没改：不发请求", () => {
    expect(buildMcpUpdate(server(), draftFor(server()))).toEqual({ ok: true, body: null });
  });

  it("只改环境变量名：envVars 放在顶层，不动 transport（参数原样保留）", () => {
    const draft = { ...draftFor(server()), envVars: "DB_TOKEN, DB_HOST" };
    expect(buildMcpUpdate(server(), draft)).toEqual({ ok: true, body: { envVars: ["DB_TOKEN", "DB_HOST"] } });
  });

  it("只改命令：参数沿用原数组，不经过文本解析", () => {
    const draft = { ...draftFor(server()), command: "/opt/db-mcp/v2" };
    expect(buildMcpUpdate(server(), draft)).toEqual({
      ok: true,
      body: { transport: { type: "stdio", command: "/opt/db-mcp/v2", args: server().args } },
    });
  });

  it("改了参数：按引号规则解析", () => {
    const draft = { ...draftFor(server()), args: '--root "/tmp/a b"' };
    expect(buildMcpUpdate(server(), draft)).toEqual({
      ok: true,
      body: { transport: { type: "stdio", command: "/opt/db-mcp/server", args: ["--root", "/tmp/a b"] } },
    });
  });

  it("从远程服务改成本机命令：发完整 transport，变量名放顶层", () => {
    const remote = server({ transport: "http", command: null, args: [], envVars: [], url: "https://mcp.example.com", bearerTokenEnvVar: null });
    const draft = { ...draftFor(remote), transport: "stdio" as const, command: "/bin/mcp", args: "", envVars: "TOKEN" };
    expect(buildMcpUpdate(remote, draft)).toEqual({
      ok: true,
      body: { transport: { type: "stdio", command: "/bin/mcp", args: [] }, envVars: ["TOKEN"] },
    });
  });

  it("远程服务只改令牌变量名", () => {
    const remote = server({ transport: "http", command: null, args: [], envVars: [], url: "https://mcp.example.com", bearerTokenEnvVar: null });
    const draft = { ...draftFor(remote), bearerEnv: "MCP_TOKEN" };
    expect(buildMcpUpdate(remote, draft)).toEqual({
      ok: true,
      body: { transport: { type: "http", url: "https://mcp.example.com", bearerTokenEnvVar: "MCP_TOKEN" } },
    });
  });
});
