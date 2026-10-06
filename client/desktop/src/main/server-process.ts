import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HealthzResponse, SystemActivityResponse } from "@suduo/client-contracts";
import { canBind, fetchHealth, isOwnServer } from "./ports.js";

/** 本机服务的拉起、就绪等待、停止与意外退出（技术设计 §4.1、§4.2）。 */
export const READY_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 15_000;
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const POLL_INTERVAL_MS = 300;

export type StartFailure =
  | { kind: "spawn"; message: string }
  | { kind: "exited"; code: number | null; signal: string | null }
  | { kind: "timeout"; seconds: number }
  /** 启动途中外壳要求停止（例如正在退出）：不是故障，不显示失败页。 */
  | { kind: "stopped" };

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
  private stopping = false;
  private exitListeners: Array<(detail: { code: number | null; signal: string | null }) => void> = [];

  constructor(private readonly options: ServerProcessOptions) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.options.port)}/`;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** 服务在就绪之后、外壳没要求的时候退出了（崩溃、被杀）。 */
  onUnexpectedExit(listener: (detail: { code: number | null; signal: string | null }) => void): void {
    this.exitListeners.push(listener);
  }

  async start(): Promise<{ ok: true } | { ok: false; failure: StartFailure }> {
    this.stopping = false;
    const log = openLog(this.options.logFile, this.options.log);
    log.write(`\n--- ${new Date().toISOString()} SuDuo desktop: starting local service on port ${String(this.options.port)} ---\n`);
    let child: ChildProcess;
    try {
      child = spawn(this.options.nodeBinary, [this.options.serverMain], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // macOS / Linux：放进独立进程组，强制结束时能连同它启动的 Codex 一起结束；
        // 开发态在终端按 Ctrl+C 时也只到外壳，由外壳走退出流程，服务不会先自己退掉。
        detached: process.platform !== "win32",
      });
    } catch (error) {
      log.end();
      return { ok: false, failure: { kind: "spawn", message: error instanceof Error ? error.message : String(error) } };
    }
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));

    let exited: { code: number | null; signal: string | null } | null = null;
    let spawnError: string | null = null;
    let readyReached = false;
    child.once("error", (error) => {
      spawnError = error.message;
      log.end();
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (this.child === child) this.child = null;
      log.write(`--- local service exited (code ${String(code)}, signal ${String(signal)}) ---\n`);
      if (!this.stopping && readyReached) {
        for (const listener of this.exitListeners) listener(exited);
      }
    });
    // 'close' 在子进程的输出都读完之后才到，这时再关日志，exit 之后迟到的输出也不会写到已关的流上。
    child.once("close", () => log.end());

    const timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopping) return { ok: false, failure: { kind: "stopped" } };
      if (spawnError !== null) return { ok: false, failure: { kind: "spawn", message: spawnError } };
      if (exited !== null) {
        const detail: { code: number | null; signal: string | null } = exited;
        return { ok: false, failure: { kind: "exited", code: detail.code, signal: detail.signal } };
      }
      const health = await fetchHealth(this.baseUrl);
      // 还要核对 pid：端口上可能是上次留下、恰好抢先绑上端口的同一实例服务，不能把它当成刚拉起的这个。
      if (health.up && isOwnServer(health.body, this.options.instanceId) && (health.body as HealthzResponse).pid === child.pid) {
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

  /**
   * 先请求优雅停止（与 pnpm start 相同的关闭接口）；连不上（还没开始监听）时 macOS / Linux 直接发 SIGTERM（服务同样会优雅关闭），
   * 都超时再强制结束整个进程树。可以重复调用，也可以在启动途中调用。
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const accepted = await requestShutdown(this.baseUrl);
    if (!accepted) {
      if (process.platform === "win32") terminateTree(child);
      else signalGroup(child, "SIGTERM");
    }
    const graceful = await Promise.race([exited.then(() => true), delay(STOP_TIMEOUT_MS).then(() => false)]);
    if (!graceful) {
      this.options.log("local service did not stop in time; terminating it");
      terminateTree(child);
      await Promise.race([exited, delay(5_000)]);
    }
  }

  /** 进行中的会话数；问不到时按 0（退出时不该因为查询失败就卡住）。 */
  runningSessions(): Promise<number> {
    return runningSessionsAt(this.baseUrl);
  }
}

/** 某个本机服务上进行中的会话数；问不到按 0。 */
export async function runningSessionsAt(baseUrl: string): Promise<number> {
  try {
    const response = await fetch(new URL("api/v1/system/activity", baseUrl), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return 0;
    const body = (await response.json()) as Partial<SystemActivityResponse>;
    return typeof body.runningSessions === "number" ? body.runningSessions : 0;
  } catch {
    return 0;
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

/** 关闭接口受理了返回 true；连不上（还没监听、已经退出）返回 false。 */
async function requestShutdown(baseUrl: string): Promise<boolean> {
  const origin = baseUrl.replace(/\/$/, "");
  try {
    const response = await fetch(new URL("api/v1/admin/shutdown", baseUrl), {
      method: "POST",
      headers: { Origin: origin },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // detached 拉起，pid 即进程组号；负数表示整个进程组。
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminateTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // 连同它启动的 Codex 一起结束；用绝对路径，不依赖 PATH。
    const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  signalGroup(child, "SIGKILL");
}

/** 日志写不进去（权限、磁盘满）不能让外壳崩掉：记一次外壳日志，之后的写入丢弃。 */
interface LogSink {
  write(chunk: string | Buffer): void;
  end(): void;
}

function openLog(file: string, report: (message: string) => void): LogSink {
  let stream: WriteStream | null = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, file + ".1");
    } catch {
      // 还没有日志文件。
    }
    stream = createWriteStream(file, { flags: "a" });
    stream.on("error", (error) => {
      report(`local service log unavailable: ${error.message}`);
      stream = null;
    });
  } catch (error) {
    report(`local service log unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    write(chunk) {
      if (stream !== null && !stream.writableEnded && !stream.destroyed) stream.write(chunk);
    },
    end() {
      if (stream !== null && !stream.writableEnded) stream.end();
    },
  };
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
