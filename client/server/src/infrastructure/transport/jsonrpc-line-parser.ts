import { StringDecoder } from "node:string_decoder";
import type { JsonValue, RpcInbound } from "@suduo/client-contracts";

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class JsonRpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonRpcProtocolError";
  }
}

export class JsonRpcLineParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly maxLineBytes = DEFAULT_MAX_LINE_BYTES) {}

  push(chunk: Uint8Array | string): RpcInbound[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    this.assertBufferLimit();
    return this.drainCompleteLines();
  }

  finish(): RpcInbound[] {
    this.buffer += this.decoder.end();
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    return [parseJsonRpcLine(line)];
  }

  private drainCompleteLines(): RpcInbound[] {
    const messages: RpcInbound[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        throw new JsonRpcProtocolError("JSON-RPC line exceeds maximum size");
      }
      if (line.trim().length > 0) {
        messages.push(parseJsonRpcLine(line));
      }
      newline = this.buffer.indexOf("\n");
    }
    this.assertBufferLimit();
    return messages;
  }

  private assertBufferLimit(): void {
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      throw new JsonRpcProtocolError(
        "JSON-RPC unterminated line exceeds maximum size",
      );
    }
  }
}

export function parseJsonRpcLine(line: string): RpcInbound {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new JsonRpcProtocolError("invalid JSON-RPC JSON line", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new JsonRpcProtocolError("JSON-RPC message must be an object");
  }

  const hasId =
    typeof value["id"] === "string" || typeof value["id"] === "number";
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");

  if (hasId && (hasResult || hasError)) {
    return {
      kind: "response",
      id: value["id"] as string | number,
      ...(hasResult ? { result: value["result"] as JsonValue } : {}),
      ...(hasError ? { error: value["error"] as JsonValue } : {}),
    };
  }

  if (typeof value["method"] === "string") {
    if (hasId) {
      return {
        kind: "server-request",
        id: value["id"] as string | number,
        method: value["method"],
        ...(Object.prototype.hasOwnProperty.call(value, "params")
          ? { params: value["params"] as JsonValue }
          : {}),
      };
    }
    return {
      kind: "notification",
      method: value["method"],
      ...(Object.prototype.hasOwnProperty.call(value, "params")
        ? { params: value["params"] as JsonValue }
        : {}),
    };
  }

  throw new JsonRpcProtocolError("unrecognized JSON-RPC message shape");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
