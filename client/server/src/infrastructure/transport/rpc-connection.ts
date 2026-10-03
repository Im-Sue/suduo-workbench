import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type {
  JsonRpcId,
  JsonValue,
  RpcConnection,
  RpcInbound,
  RpcRequestOptions,
} from "@suduo/client-contracts";
import {
  JsonRpcLineParser,
  JsonRpcProtocolError,
} from "./jsonrpc-line-parser.js";
import { terminateChildProcess } from "../platform/process-control.js";

interface PendingRequest {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  cleanupAbort(): void;
}

interface MessageWaiter {
  resolve(value: RpcInbound | null): void;
  reject(error: Error): void;
  cleanupAbort(): void;
}

export class RpcConnectionClosedError extends Error {
  constructor(message = "Codex RPC connection is closed") {
    super(message);
    this.name = "RpcConnectionClosedError";
  }
}

export class StdioRpcConnection implements RpcConnection {
  readonly transportKind = "stdio" as const;
  private readonly parser: JsonRpcLineParser;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly queuedMessages: RpcInbound[] = [];
  private readonly messageWaiters: MessageWaiter[] = [];
  private nextRequestId = 1;
  private closed = false;
  private terminalError: Error | null = null;

  constructor(
    readonly connectionId: string,
    private readonly child: ChildProcessWithoutNullStreams,
    options: {
      maxLineBytes?: number;
      onStderr?(text: string): void;
    } = {},
  ) {
    this.parser = new JsonRpcLineParser(options.maxLineBytes);
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.parser.push(chunk)) {
          this.handleMessage(message);
        }
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new JsonRpcProtocolError("unknown protocol error"),
        );
        terminateChildProcess(this.child, "force");
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      options.onStderr?.(chunk.toString("utf8"));
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      const detail =
        "codex app-server exited; code=" +
        String(code) +
        " signal=" +
        String(signal);
      this.fail(new RpcConnectionClosedError(detail));
    });
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async request(
    method: string,
    params: JsonValue | undefined,
    options: RpcRequestOptions,
  ): Promise<JsonValue> {
    this.assertOpen();
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const response = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout waiting for Codex RPC method " + method));
      }, options.timeoutMs);
      const cleanupAbort = attachAbort(options.signal, () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Codex RPC request aborted: " + method));
      });
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanupAbort,
      });
    });

    try {
      await this.writeLine({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        pending.reject(asError(error));
      }
    }
    return response;
  }

  async respond(id: JsonRpcId, result: JsonValue): Promise<void> {
    this.assertOpen();
    await this.writeLine({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  async respondError(id: JsonRpcId, code: number, message: string): Promise<void> {
    this.assertOpen();
    await this.writeLine({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  async notify(method: string, params: JsonValue | undefined): Promise<void> {
    this.assertOpen();
    await this.writeLine({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async *messages(options: {
    signal: AbortSignal;
  }): AsyncIterable<RpcInbound> {
    while (!options.signal.aborted) {
      const message = await this.nextMessage(options.signal);
      if (message === null) {
        return;
      }
      yield message;
    }
  }

  async close(reason = "client close"): Promise<void> {
    if (this.closed) {
      return;
    }
    terminateChildProcess(this.child, "graceful");
    await Promise.race([
      once(this.child, "exit"),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!this.closed) {
      terminateChildProcess(this.child, "force");
      this.fail(new RpcConnectionClosedError(reason));
    }
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (!this.closed) {
      terminateChildProcess(
        this.child,
        signal === "SIGKILL" ? "force" : "graceful",
      );
    }
  }

  private handleMessage(message: RpcInbound): void {
    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        if (message.error !== undefined) {
          pending.reject(
            new Error("Codex RPC error: " + JSON.stringify(message.error)),
          );
        } else {
          pending.resolve(message.result ?? null);
        }
      }
    }
    this.enqueueMessage(message);
  }

  private enqueueMessage(message: RpcInbound): void {
    const waiter = this.messageWaiters.shift();
    if (waiter) {
      waiter.cleanupAbort();
      waiter.resolve(message);
      return;
    }
    this.queuedMessages.push(message);
  }

  private nextMessage(signal: AbortSignal): Promise<RpcInbound | null> {
    const queued = this.queuedMessages.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return this.terminalError
        ? Promise.reject(this.terminalError)
        : Promise.resolve(null);
    }
    return new Promise<RpcInbound | null>((resolve, reject) => {
      const waiter: MessageWaiter = {
        resolve,
        reject,
        cleanupAbort: () => undefined,
      };
      waiter.cleanupAbort = attachAbort(signal, () => {
        const index = this.messageWaiters.indexOf(waiter);
        if (index >= 0) {
          this.messageWaiters.splice(index, 1);
        }
        resolve(null);
      });
      this.messageWaiters.push(waiter);
    });
  }

  private async writeLine(message: Record<string, JsonValue>): Promise<void> {
    this.assertOpen();
    const line = JSON.stringify(message) + "\n";
    if (!this.child.stdin.write(line, "utf8")) {
      await once(this.child.stdin, "drain");
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw this.terminalError ?? new RpcConnectionClosedError();
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.messageWaiters.splice(0)) {
      waiter.cleanupAbort();
      waiter.reject(error);
    }
  }
}

function attachAbort(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) {
    return () => undefined;
  }
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
