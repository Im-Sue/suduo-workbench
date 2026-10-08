import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodexTransportFactory,
  JsonRpcId,
  JsonValue,
  RpcConnection,
  RpcInbound,
  RpcRequestOptions,
} from "@suduo/client-contracts";
import { withLoopbackNoProxy } from "../src/infrastructure/mcp/loopback-no-proxy.js";
import { createSuDuoApplication } from "../src/server-application.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("G 应用层代理热生效", () => {
  it("保存代理注入新 app-server；清空后还原继承环境并重连", async () => {
    const root = mkdtempSync(join(tmpdir(), "suduo-proxy-app-"));
    temporaryPaths.push(root);
    const settingsFile = join(root, "settings.json");
    const configuredProxy = "socks5h://127.0.0.1:17891";
    writeFileSync(
      settingsFile,
      JSON.stringify({
        schemaVersion: 1,
        globalSkills: true,
        gitAutoCheckpointDefault: true,
        defaultApprovalMode: "ask",
        httpProxy: "",
        httpsProxy: "",
        allProxy: configuredProxy,
        noProxy: "localhost",
      }),
    );
    const environments: Record<string, string>[] = [];
    const first = new FakeConnection();
    const second = new FakeConnection();
    const connections = [first, second];
    const transport: CodexTransportFactory = {
      kind: "stdio",
      connect: async (options) => {
        environments.push({ ...options.env });
        const next = connections.shift();
        if (!next) throw new Error("unexpected Codex connection");
        return next;
      },
    };
    const application = createSuDuoApplication({
      databasePath: join(root, "suduo.sqlite"),
      settingsFile,
      codexHome: join(root, "codex-home"),
      codexBin: "fixture-codex",
      runtimeTransport: transport,
      webRoot: root,
    });
    try {
      await application.runtime.modelList({ limit: 1 });
      expect(environments[0]).toMatchObject({
        ALL_PROXY: configuredProxy,
        all_proxy: configuredProxy,
        // 本机地址总是直连（SuDuo 本机 MCP 工具服务，ADR-0015）
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
      });

      const updated = await application.server.inject({
        method: "PATCH",
        url: "/api/v1/settings",
        headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
        payload: { allProxy: "", noProxy: "" },
      });
      expect(updated.statusCode).toBe(200);
      expect(first.closeReasons).toEqual(["egress proxy settings changed"]);

      await application.runtime.modelList({ limit: 1 });
      expect(environments[1]?.["ALL_PROXY"]).toBe(process.env["ALL_PROXY"]);
      expect(environments[1]?.["all_proxy"]).toBe(process.env["all_proxy"]);
      const inherited = withLoopbackNoProxy(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
      expect(environments[1]?.["NO_PROXY"]).toBe(inherited["NO_PROXY"]);
      expect(environments[1]?.["no_proxy"]).toBe(inherited["no_proxy"]);
      expect(environments[1]?.["ALL_PROXY"]).not.toBe(configuredProxy);
    } finally {
      await application.close();
    }
  });
});

class FakeConnection implements RpcConnection {
  readonly connectionId = "proxy-application-test";
  readonly transportKind = "stdio" as const;
  readonly closeReasons: string[] = [];

  async request(
    method: string,
    params: JsonValue | undefined,
    options: RpcRequestOptions,
  ): Promise<JsonValue> {
    void params;
    void options;
    if (method === "initialize") return { userAgent: "fixture" };
    if (method === "model/list") return { data: [], nextCursor: null };
    return {};
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
  async notify(method: string, params: JsonValue | undefined): Promise<void> {
    void method;
    void params;
  }
  async *messages(options: { signal: AbortSignal }): AsyncIterable<RpcInbound> {
    void options;
    yield* [] as RpcInbound[];
  }
  async close(reason?: string): Promise<void> {
    this.closeReasons.push(reason ?? "");
  }
}
