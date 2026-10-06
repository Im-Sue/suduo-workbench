import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SystemActivityResponse } from "@suduo/client-contracts";
import { canBind, fetchHealth, isOwnServer } from "./ports.js";

/** 本机服务的拉起、就绪等待、停止与意外退出（技术设计 §4.1、§4.2）。 */
export const READY_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 15_000;
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const POLL_INTERVAL_MS = 300;

export type StartFailure =
  | { kind: "spawn"; message: string }
  | { kind: "exited"; code: number | null; signal: string | null }
  | { kind: "timeout"; seconds: number };

export interface ServerProcessOptions {
  nodeBinary: string;
  serverMain: string;
  cwd: string;
  env: Record<string, string>;
  port: number;
  instanceId: string;
  logFile: string;
  log(message: string): void;
  readyTimeoutMs?: number;
}

export class ServerProcess {
  private child: ChildProcess | null = null;
  private logStream: WriteStream | null = null;
  private stopping = false;
  private exitListeners: Array<(detail: { code: number | null; signal: string | null }) => void> = [];

  constructor(private readonly options: ServerProcessOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.options.port)}/`;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** 服务在外壳没要求的时候退出了（崩溃、被杀）。 */
  onUnexpectedExit(listener: (detail: { code: number | null; signal: string | null }) => void): void {
    this.exitListeners.push(listener);
  }

  async start(): Promise<{ ok: true } | { ok: false; failure: StartFailure }> {
    this.stopping = false;
    this.logStream = openLog(this.options.logFile);
    this.logStream.write(`\n--- ${new Date().toISOString()} SuDuo desktop: starting local service on port ${String(this.options.port)} ---\n`);
    let child: ChildProcess;
    try {
      child = spawn(this.options.nodeBinary, [this.options.serverMain], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, failure: { kind: "spawn", message: error instanceof Error ? error.message : String(error) } };
    }
    this.child = child;
    const stream = this.logStream;
    child.stdout?.on("data", (chunk: Buffer) => stream.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stream.write(chunk));

    let exited: { code: number | null; signal: string | null } | null = null;
    let spawnError: string | null = null;
    let readyReached = false;
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (this.child === child) this.child = null;
      stream.write(`--- local service exited (code ${String(code)}, signal ${String(signal)}) ---\n`);
      if (!this.stopping && readyReached) {
        for (const listener of this.exitListeners) listener(exited);
      }
    });

    const timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError !== null) return { ok: false, failure: { kind: "spawn", message: spawnError } };
      if (exited !== null) {
        const detail: { code: number | null; signal: string | null } = exited;
        return { ok: false, failure: { kind: "exited", code: detail.code, signal: detail.signal } };
      }
      const health = await fetchHealth(this.baseUrl);
      if (health.up && isOwnServer(health.body, this.options.instanceId)) {
        readyReached = true;
        this.options.log(`local service ready on ${this.baseUrl} (pid ${String(child.pid)})`);
        return { ok: true };
      }
      await delay(POLL_INTERVAL_MS);
    }
    this.options.log("local service not ready in time; stopping it");
    await this.stop();
    return { ok: false, failure: { kind: "timeout", seconds: Math.round(timeoutMs / 1_000) } };
  }

  /** 先请求优雅停止（与 pnpm start 相同的关闭接口），超时再强制结束。 */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      this.closeLog();
      return;
    }
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await requestShutdown(this.baseUrl);
    const graceful = await Promise.race([exited.then(() => true), delay(STOP_TIMEOUT_MS).then(() => false)]);
    if (!graceful) {
      this.options.log("local service did not stop in time; terminating it");
      terminateTree(child);
      await Promise.race([exited, delay(5_000)]);
    }
    this.closeLog();
  }

  /** 进行中的会话数；问不到时按 0（退出时不该因为查询失败就卡住）。 */
  async runningSessions(): Promise<number> {
    try {
      const response = await fetch(new URL("api/v1/system/activity", this.baseUrl), { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return 0;
      const body = (await response.json()) as Partial<SystemActivityResponse>;
      return typeof body.runningSessions === "number" ? body.runningSessions : 0;
    } catch {
      return 0;
    }
  }

  private closeLog(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}

/** 停掉上次外壳异常退出时留下的本机服务，等端口空出来；停不掉返回 false。 */
export async function stopOrphan(port: number, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
  await requestShutdown(`http://127.0.0.1:${String(port)}/`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBind(port)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

async function requestShutdown(baseUrl: string): Promise<void> {
  const origin = baseUrl.replace(/\/$/, "");
  try {
    await fetch(new URL("api/v1/admin/shutdown", baseUrl), {
      method: "POST",
      headers: { Origin: origin },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // 服务可能已经在退出；超时后由强制结束兜底。
  }
}

function terminateTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // 连同它启动的 Codex 一起结束。
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  child.kill("SIGKILL");
}

function openLog(file: string): WriteStream {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, file + ".1");
  } catch {
    // 还没有日志文件。
  }
  return createWriteStream(file, { flags: "a" });
}

/**
 * 运行中意外退出后的自动重启（技术设计 §4.1）：5 分钟内最多 3 次，依次隔 1、5、15 秒；超过就不再重启，交给失败页。
 * history 是此前几次重启的时间。
 */
export function nextRestartDelay(history: readonly number[], now: number): number | null {
  const delays = [1_000, 5_000, 15_000];
  const recent = history.filter((time) => now - time < 5 * 60_000).length;
  return recent < delays.length ? (delays[recent] ?? null) : null;
}
