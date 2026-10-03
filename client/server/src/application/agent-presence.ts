import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { LocalAgentStateDto } from "@suduo/client-contracts";
import type {
  AgentDto,
  AgentHeartbeatRequest,
  AgentRunSummaryDto,
  RegisterAgentRequest,
} from "@suduo/cloud-contracts";
import {
  readPrivateJson,
  writePrivateJson,
} from "../infrastructure/requirements-v2/local-json-store.js";
import { ApiError } from "./api-error.js";

/**
 * 本机 Agent 的登记与在线（技术设计二、3「离线判定在远程」）：
 * - 本机安装标识存 `<v2 数据目录>/agent-device.json`（`{deviceKey}`，没有就生成）；
 * - 登录后 `POST /v2/agents` 登记（同一所有者 + 设备重复登记合并成同一个 Agent）；
 * - 每 30 秒心跳，带「有没有打开着的 SuDuo 页面」（真人在线）；
 * - 心跳返回的开着的共享数 > 0 时持有 `retainStream()`：共享期间本机服务常驻，不空闲退出。
 */
export interface AgentPresenceDependencies {
  dataDirectory: string;
  remote: {
    registerAgent(input: RegisterAgentRequest): Promise<AgentDto>;
    heartbeatAgent(agentId: string, input: AgentHeartbeatRequest): Promise<AgentDto>;
  };
  /** 已登录的用户 ID；没登录为 null。 */
  currentUserId(): string | null;
  /** 有没有打开着的页面（RemoteEventsHub.browserClientCount() > 0）。 */
  browserActive(): boolean;
  activity?: { retainStream(): () => void };
  /** 正在执行与排队的任务（RoomAgentRunner）。 */
  runs?(): { activeRun: AgentRunSummaryDto | null; queuedRuns: number };
  /** 登记成功（接收器据此补拉排队任务、清理重启前中断的任务）。 */
  onRegistered?(agent: AgentDto): void;
  hostname?(): string;
  intervalMs?: number;
  log?(line: Record<string, unknown>): void;
}

const DEVICE_FILE = "agent-device.json";

export class AgentPresence {
  private agent: AgentDto | null = null;
  private status: LocalAgentStateDto["status"] = "unregistered";
  private message: string | null = "还没有登录需求服务";
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;
  private releaseStream: (() => void) | null = null;
  private registeredUserId: string | null = null;
  /** 正在进行的登记 / 心跳（按代记，restart 后新一代不被旧请求挡住）。 */
  private inFlight: { generation: number; work: Promise<void> } | null = null;
  private readonly intervalMs: number;

  constructor(private readonly deps: AgentPresenceDependencies) {
    this.intervalMs = deps.intervalMs ?? 30_000;
  }

  /** 登录 / 退出 / 改服务地址后重新登记（没登录则停在 unregistered）。 */
  restart(): void {
    this.generation += 1;
    this.clearTimer();
    this.setRetained(false);
    this.agent = null;
    this.registeredUserId = null;
    const userId = this.deps.currentUserId();
    if (userId === null) {
      this.status = "unregistered";
      this.message = "还没有登录需求服务";
      return;
    }
    this.status = "unregistered";
    this.message = "正在登记本机 Agent";
    const generation = this.generation;
    this.timer = setInterval(() => {
      void this.tick(generation);
    }, this.intervalMs);
    this.timer.unref();
    void this.tick(generation);
  }

  stop(): void {
    this.generation += 1;
    this.clearTimer();
    this.setRetained(false);
  }

  /** 浏览器从无到有（或反过来）时尽快发一次心跳，不等 30 秒。 */
  nudge(): void {
    if (this.agent !== null) {
      void this.tick(this.generation);
    }
  }

  currentAgent(): AgentDto | null {
    return this.agent;
  }

  agentId(): string | null {
    return this.agent?.id ?? null;
  }

  state(): LocalAgentStateDto {
    const runs = this.deps.runs?.() ?? { activeRun: null, queuedRuns: 0 };
    return {
      status: this.status,
      agent: this.agent,
      message: this.status === "ready" ? null : this.message,
      activeRun: runs.activeRun,
      queuedRuns: runs.queuedRuns,
    };
  }

  /** 本机安装标识：没有就生成并保存（0600）。 */
  deviceKey(): string {
    const path = join(this.deps.dataDirectory, DEVICE_FILE);
    const stored = readPrivateJson<{ deviceKey?: unknown }>(path);
    if (stored !== null && typeof stored.deviceKey === "string" && stored.deviceKey.trim() !== "") {
      return stored.deviceKey;
    }
    const deviceKey = randomUUID();
    writePrivateJson(path, { deviceKey });
    return deviceKey;
  }

  deviceName(): string {
    return deviceNameOf((this.deps.hostname ?? hostname)());
  }

  private async tick(generation: number): Promise<void> {
    // 同一时刻只跑一个登记 / 心跳；慢请求期间的定时器跳过。
    if (generation !== this.generation || this.inFlight?.generation === generation) return;
    const work = this.agent === null ? this.register(generation) : this.heartbeat(generation);
    const entry = { generation, work };
    this.inFlight = entry;
    try {
      await work;
    } finally {
      if (this.inFlight === entry) this.inFlight = null;
    }
  }

  private async register(generation: number): Promise<void> {
    const userId = this.deps.currentUserId();
    if (userId === null) {
      this.toUnregistered("还没有登录需求服务");
      return;
    }
    try {
      const agent = await this.deps.remote.registerAgent({
        deviceKey: this.deviceKey(),
        deviceName: this.deviceName(),
        kind: "codex",
      });
      if (generation !== this.generation) return;
      this.agent = agent;
      this.registeredUserId = userId;
      this.status = "ready";
      this.message = null;
      this.log({ event: "suduo.agent.registered", agentId: agent.id });
      try {
        this.deps.onRegistered?.(agent);
      } catch (error) {
        this.log({ event: "suduo.agent.on_registered_failed", message: messageOf(error) });
      }
      await this.heartbeat(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (isUnauthorized(error)) {
        this.toUnregistered("需求服务登录已过期，请重新登录");
        return;
      }
      this.status = "unavailable";
      this.message = `登记本机 Agent 失败：${messageOf(error)}`;
      this.log({ event: "suduo.agent.register_failed", message: messageOf(error) });
    }
  }

  private async heartbeat(generation: number): Promise<void> {
    const agent = this.agent;
    if (agent === null) return;
    if (this.deps.currentUserId() !== this.registeredUserId) {
      // 换了账号：下次 tick 重新登记。
      this.agent = null;
      this.setRetained(false);
      return;
    }
    try {
      const result = await this.deps.remote.heartbeatAgent(agent.id, {
        browserActive: this.deps.browserActive(),
      });
      if (generation !== this.generation) return;
      const updated = agentOf(result);
      if (updated !== null) {
        this.agent = updated;
      }
      this.status = "ready";
      this.message = null;
      this.setRetained((this.agent?.activeShareCount ?? 0) > 0);
    } catch (error) {
      if (generation !== this.generation) return;
      if (isUnauthorized(error)) {
        this.toUnregistered("需求服务登录已过期，请重新登录");
        return;
      }
      if (error instanceof ApiError && error.statusCode === 404) {
        // 远程没有这个 Agent 了（例如换了库）：下次 tick 重新登记。
        this.agent = null;
        this.setRetained(false);
        this.status = "unregistered";
        this.message = "本机 Agent 需要重新登记";
        return;
      }
      this.status = "unavailable";
      this.message = `本机 Agent 心跳失败：${messageOf(error)}`;
      this.log({ event: "suduo.agent.heartbeat_failed", message: messageOf(error) });
    }
  }

  private toUnregistered(message: string): void {
    this.clearTimer();
    this.agent = null;
    this.registeredUserId = null;
    this.status = "unregistered";
    this.message = message;
    this.setRetained(false);
  }

  /** 共享期间持有一个「流」：IdleMonitor 看到有流就不空闲退出。 */
  private setRetained(retained: boolean): void {
    if (retained && this.releaseStream === null) {
      this.releaseStream = this.deps.activity?.retainStream() ?? (() => undefined);
      this.log({ event: "suduo.agent.keep_alive", retained: true });
    } else if (!retained && this.releaseStream !== null) {
      this.releaseStream();
      this.releaseStream = null;
      this.log({ event: "suduo.agent.keep_alive", retained: false });
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.info(JSON.stringify(value))))(line);
  }
}

/** 设备名：主机名去掉 macOS 的 `.local` 后缀。 */
export function deviceNameOf(host: string): string {
  const name = host.trim().replace(/\.local$/iu, "");
  return name === "" ? "本机" : name.slice(0, 120);
}

/** 心跳按契约返回 AgentDto；也容忍 `{agent}` 包一层。认不出返回 null（保留上次的）。 */
function agentOf(value: unknown): AgentDto | null {
  if (isAgent(value)) return value;
  if (value !== null && typeof value === "object" && isAgent((value as { agent?: unknown }).agent)) {
    return (value as { agent: AgentDto }).agent;
  }
  return null;
}

function isAgent(value: unknown): value is AgentDto {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AgentDto).id === "string" &&
    typeof (value as AgentDto).activeShareCount === "number"
  );
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.statusCode === 401 || error.code === "AUTH_INVALID" || error.code === "AUTH_REQUIRED")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
