import type { JsonValue } from "./events.js";

export type JsonRpcId = string | number;

export type RpcInbound =
  | {
      kind: "response";
      id: JsonRpcId;
      result?: JsonValue;
      error?: JsonValue;
    }
  | {
      kind: "server-request";
      id: JsonRpcId;
      method: string;
      params?: JsonValue;
    }
  | {
      kind: "notification";
      method: string;
      params?: JsonValue;
    };

export interface RpcRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RpcConnection {
  readonly connectionId: string;
  readonly transportKind: "stdio" | "daemon-proxy";

  request(
    method: string,
    params: JsonValue | undefined,
    options: RpcRequestOptions,
  ): Promise<JsonValue>;

  notify(method: string, params: JsonValue | undefined): Promise<void>;
  respond(id: JsonRpcId, result: JsonValue): Promise<void>;
  /** 以 JSON-RPC 错误回应服务端请求（例如不支持的方法）。 */
  respondError(id: JsonRpcId, code: number, message: string): Promise<void>;
  messages(options: { signal: AbortSignal }): AsyncIterable<RpcInbound>;
  close(reason?: string): Promise<void>;
}

export interface CodexTransportFactory {
  readonly kind: "stdio" | "daemon-proxy";

  connect(options: {
    codexBin: string;
    env: Record<string, string>;
    signal: AbortSignal;
  }): Promise<RpcConnection>;
}
