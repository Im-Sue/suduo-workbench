import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DaemonProxyCodexTransport } from "../src/infrastructure/transport/daemon-proxy-transport.js";
import {
  JsonRpcLineParser,
  parseJsonRpcLine,
} from "../src/infrastructure/transport/jsonrpc-line-parser.js";
import {
  initializeCodexConnection,
  StdioCodexTransport,
} from "../src/infrastructure/transport/stdio-codex-transport.js";

describe("T3 JSON-RPC transport", () => {
  it("容忍 response 缺少 jsonrpc 字段", () => {
    expect(parseJsonRpcLine('{"id":1,"result":{"ok":true}}')).toEqual({
      kind: "response",
      id: 1,
      result: { ok: true },
    });
  });

  it("按换行解析跨 chunk 消息", () => {
    const parser = new JsonRpcLineParser();
    expect(parser.push('{"method":"turn/sta')).toEqual([]);
    expect(
      parser.push(
        'rted","params":{"threadId":"t","turnId":"u"}}\n{"id":"a","error":{"code":1}}\n',
      ),
    ).toEqual([
      {
        kind: "notification",
        method: "turn/started",
        params: { threadId: "t", turnId: "u" },
      },
      {
        kind: "response",
        id: "a",
        error: { code: 1 },
      },
    ]);
  });

  it("spawn stdio、initialize 并接收通知", async () => {
    const fixture = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "fixtures",
      "fake-codex.mjs",
    );
    const controller = new AbortController();
    const transport = new StdioCodexTransport({ args: [fixture] });
    const connection = await transport.connect({
      codexBin: process.execPath,
      env: currentEnvironment(),
      signal: controller.signal,
    });

    try {
      const initialized = await initializeCodexConnection(connection);
      expect(initialized).toEqual({ userAgent: "fake-codex" });

      const messages = connection.messages({
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      expect((await messages.next()).value).toMatchObject({
        kind: "response",
      });
      expect((await messages.next()).value).toEqual({
        kind: "notification",
        method: "thread/started",
        params: {
          thread: {
            id: "fake-thread",
          },
        },
      });
    } finally {
      controller.abort();
      await connection.close();
    }
  });

  it("daemon-proxy 在 M1 明确拒绝", async () => {
    const transport = new DaemonProxyCodexTransport();
    await expect(
      transport.connect({
        codexBin: "codex",
        env: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("reserved for M2");
  });
});

function currentEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
