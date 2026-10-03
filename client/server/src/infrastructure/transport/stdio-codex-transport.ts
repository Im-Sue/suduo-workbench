import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { CodexTransportFactory, JsonValue, RpcConnection } from "@suduo/client-contracts";
import { StdioRpcConnection } from "./rpc-connection.js";

export interface StdioCodexTransportOptions {
  args?: string[];
  maxLineBytes?: number;
  onStderr?(text: string): void;
}

export class StdioCodexTransport implements CodexTransportFactory {
  readonly kind = "stdio" as const;

  constructor(private readonly options: StdioCodexTransportOptions = {}) {}

  async connect(options: {
    codexBin: string;
    env: Record<string, string>;
    signal: AbortSignal;
  }): Promise<RpcConnection> {
    if (options.signal.aborted) {
      throw new Error("Codex transport connect aborted");
    }
    const child = spawn(
      options.codexBin,
      this.options.args ?? ["app-server", "--stdio"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: options.env,
        windowsHide: true,
        shell:
          process.platform === "win32" && /\.(?:cmd|bat)$/i.test(options.codexBin),
      },
    );
    const connection = new StdioRpcConnection(randomUUID(), child, {
      ...(this.options.maxLineBytes === undefined
        ? {}
        : { maxLineBytes: this.options.maxLineBytes }),
      ...(this.options.onStderr === undefined
        ? {}
        : { onStderr: this.options.onStderr }),
    });
    const abort = () => connection.kill("SIGTERM");
    options.signal.addEventListener("abort", abort, { once: true });
    return connection;
  }
}

export async function initializeCodexConnection(
  connection: RpcConnection,
  options: {
    clientName?: string;
    clientTitle?: string;
    clientVersion?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<JsonValue> {
  const result = await connection.request(
    "initialize",
    {
      clientInfo: {
        name: options.clientName ?? "suduo",
        title: options.clientTitle ?? "SuDuo",
        version: options.clientVersion ?? "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
    {
      timeoutMs: options.timeoutMs ?? 20_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  // app-server 以此 notification 完成连接级握手；后续 RPC 才在已初始化状态运行。
  await connection.notify("initialized", {});
  return result;
}
