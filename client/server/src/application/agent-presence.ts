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
import type { ServerMessages } from "../i18n/messages/index.js";
import { ApiError, errorTextOf, renderText, type ErrorText } from "./api-error.js";

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
  /** 登记成功（接收器据此补拉排队任务、清理重启前中断的任务）；Codex 以外的一家晚些才登记上时也调。 */
  onRegistered?(agent: AgentDto): void;
  /**
   * 当前需求服务的地址（多 Agent S6）：共享过的其他家按服务器分开记（与目录关联按服务器区分一致），
   * 在服务器 A 共享的不会在服务器 B 自动登记。没配置时为 null（不登记其他家）。
   */
  serverKey?(): string | null;
  /**
   * 这一种 Agent 能不能在讨论里替别人执行（配置表：接上了、做得到只读、没停用；ADR-0009 只读红线）。
   * 不能时返回原因：不登记、已登记的停止心跳（在云端变成离线）。没给时只允许 Codex。
   */
  kindProblem?(kind: string): ErrorText | null;
  hostname?(): string;
  intervalMs?: number;
  log?(line: Record<string, unknown>): void;
}

const DEVICE_FILE = "agent-device.json";

/**
 * 本机 Agent 状态，说明（message）还没定语言：状态在后台登记 / 心跳时生成，
 * 返回给界面时按请求语言渲染（`renderAgentState`）。
 */
export type LocalAgentState = Omit<LocalAgentStateDto, "message"> & { message: ErrorText | null };

export function renderAgentState(state: LocalAgentState, t: ServerMessages): LocalAgentStateDto {
  return { ...state, message: state.message === null ? null : renderText(state.message, t) };
}

export class AgentPresence {
  private agent: AgentDto | null = null;
  /** Codex 以外共享过的各家（多 Agent S6）：种类 → 云端 Agent。种类列表存在设备文件里，重启后照样登记。 */
  private readonly extras = new Map<string, AgentDto>();
  /** 云端不认的种类（老云端只认 codex，回 400）：本代不再重试，换服务器 / 重新登录（restart）后再试。 */
  private readonly rejectedKinds = new Set<string>();
  private status: LocalAgentStateDto["status"] = "unregistered";
  private message: ErrorText | null = (t) => t.activity.agent.notSignedIn;
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
    this.extras.clear();
    this.rejectedKinds.clear();
    this.registeredUserId = null;
    const userId = this.deps.currentUserId();
    if (userId === null) {
      this.status = "unregistered";
      this.message = (t) => t.activity.agent.notSignedIn;
      return;
    }
    this.status = "unregistered";
    this.message = (t) => t.activity.agent.registering;
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

  /** 本机登记了的全部 Agent（Codex 在前）。 */
  currentAgents(): AgentDto[] {
    return [...(this.agent === null ? [] : [this.agent]), ...this.extras.values()];
  }

  /** 按云端 Agent id 找本机的（房间任务派给的是哪一家）。 */
  agentById(agentId: string): AgentDto | null {
    return this.currentAgents().find((agent) => agent.id === agentId) ?? null;
  }

  /** 设备文件里为当前服务器记的、Codex 以外要登记的种类（不能在讨论里执行的不算）。 */
  sharedKinds(): string[] {
    return this.storedKinds().filter((kind) => this.problemOf(kind) === null);
  }

  private storedKinds(): string[] {
    const server = this.deps.serverKey?.() ?? null;
    if (server === null) return [];
    const stored = readPrivateJson<{ kindsByServer?: Record<string, unknown> }>(join(this.deps.dataDirectory, DEVICE_FILE));
    const kinds = stored?.kindsByServer?.[server];
    return Array.isArray(kinds) ? [...new Set(kinds.filter((kind): kind is string => typeof kind === "string" && kind !== "codex"))] : [];
  }

  private writeKinds(kinds: readonly string[]): void {
    const server = this.deps.serverKey?.() ?? null;
    if (server === null) return;
    const path = join(this.deps.dataDirectory, DEVICE_FILE);
    const stored = readPrivateJson<Record<string, unknown>>(path) ?? {};
    const byServer = (stored["kindsByServer"] ?? {}) as Record<string, unknown>;
    writePrivateJson(path, { ...stored, deviceKey: this.deviceKey(), kindsByServer: { ...byServer, [server]: [...new Set(kinds)] } });
  }

  private problemOf(kind: string): ErrorText | null {
    if (this.deps.kindProblem === undefined) return kind === "codex" ? null : (t) => t.room.agentUnsupported(kind);
    return this.deps.kindProblem(kind);
  }

  /**
   * 共享 Codex 以外的一家（多 Agent S6）：立刻登记并记进设备文件（之后重启、重新登录都照样登记），
   * 返回它在云端的 Agent。没登录、需求服务不可用、云端太旧不认这个种类时原样报错，什么都不记。
   */
  async addKind(kind: string): Promise<AgentDto> {
    if (kind === "codex") {
      // Codex 由后台登记；还没登记好时让人稍后再试。
      if (this.agent === null) throw new ApiError(503, "RUNTIME_UNAVAILABLE", (t) => t.activity.agent.registering);
      return this.agent;
    }
    // 只读红线（ADR-0009）：做不到只读、停用了的不登记。
    const problem = this.problemOf(kind);
    if (problem !== null) throw new ApiError(400, "VALIDATION_ERROR", problem, { agentId: kind });
    const existing = this.extras.get(kind);
    if (existing !== undefined) return existing;
    const generation = this.generation;
    const agent = await this.deps.remote.registerAgent({ deviceKey: this.deviceKey(), deviceName: this.deviceName(), kind });
    // 登记期间换了账号 / 服务地址：结果不留、也不记进设备文件（属于上一个服务器）。
    if (generation !== this.generation) return agent;
    this.writeKinds([...this.storedKinds(), kind]);
    this.rejectedKinds.delete(kind);
    this.extras.set(kind, agent);
    this.log({ event: "suduo.agent.registered", agentId: agent.id, kind });
    return agent;
  }

  /**
   * 不再在讨论里提供这一家（多 Agent S6）：从当前服务器的设备文件里去掉、停止心跳，云端随后把它标成离线。
   * 以后可以再共享。Codex 不能去掉（本机默认登记）。
   */
  removeKind(kind: string): void {
    if (kind === "codex") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.room.codexNotRemovable);
    this.writeKinds(this.storedKinds().filter((item) => item !== kind));
    const removed = this.extras.get(kind);
    this.extras.delete(kind);
    this.log({ event: "suduo.agent.kind_removed", kind, agentId: removed?.id ?? null });
    this.setRetained(this.currentAgents().some((candidate) => candidate.activeShareCount > 0));
  }

  agentId(): string | null {
    return this.agent?.id ?? null;
  }

  state(): LocalAgentState {
    const runs = this.deps.runs?.() ?? { activeRun: null, queuedRuns: 0 };
    return {
      status: this.status,
      agent: this.agent,
      agents: this.currentAgents(),
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
      this.toUnregistered((t) => t.activity.agent.notSignedIn);
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
      // Codex 以外共享过的各家一并登记（某一家失败不影响别的，下次心跳再补）。
      await this.registerExtras(generation);
      try {
        this.deps.onRegistered?.(agent);
      } catch (error) {
        this.log({ event: "suduo.agent.on_registered_failed", message: messageOf(error) });
      }
      await this.heartbeat(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (isUnauthorized(error)) {
        this.toUnregistered((t) => t.activity.agent.signInExpired);
        return;
      }
      this.status = "unavailable";
      const reason = errorTextOf(error);
      this.message = (t) => t.activity.agent.registerFailed(reason(t));
      this.log({ event: "suduo.agent.register_failed", message: messageOf(error) });
    }
  }

  private async heartbeat(generation: number): Promise<void> {
    const agent = this.agent;
    if (agent === null) return;
    if (this.deps.currentUserId() !== this.registeredUserId) {
      // 换了账号：下次 tick 重新登记（其他家也按新账号重新登记）。
      this.agent = null;
      this.extras.clear();
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
      await this.heartbeatExtras(generation);
      if (generation !== this.generation) return;
      this.status = "ready";
      this.message = null;
      this.setRetained(this.currentAgents().some((candidate) => candidate.activeShareCount > 0));
    } catch (error) {
      if (generation !== this.generation) return;
      if (isUnauthorized(error)) {
        this.toUnregistered((t) => t.activity.agent.signInExpired);
        return;
      }
      if (error instanceof ApiError && error.statusCode === 404) {
        // 远程没有这个 Agent 了（例如换了库）：下次 tick 重新登记。
        this.agent = null;
        this.setRetained(false);
        this.status = "unregistered";
        this.message = (t) => t.activity.agent.needsReregister;
        return;
      }
      this.status = "unavailable";
      const reason = errorTextOf(error);
      this.message = (t) => t.activity.agent.heartbeatFailed(reason(t));
      this.log({ event: "suduo.agent.heartbeat_failed", message: messageOf(error) });
    }
  }

  /** 按设备文件登记还没登记的其他家；返回这次新登记上的。 */
  private async registerExtras(generation: number): Promise<AgentDto[]> {
    const added: AgentDto[] = [];
    const kinds = this.sharedKinds();
    // 设备文件里去掉了的、配置表或设置改成不能执行的：停止心跳（云端随后标成离线）。
    for (const kind of [...this.extras.keys()]) {
      if (!kinds.includes(kind)) this.extras.delete(kind);
    }
    for (const kind of kinds) {
      if (generation !== this.generation || this.extras.has(kind) || this.rejectedKinds.has(kind)) continue;
      try {
        const agent = await this.deps.remote.registerAgent({ deviceKey: this.deviceKey(), deviceName: this.deviceName(), kind });
        if (generation !== this.generation) return added;
        // 登记期间被去掉了（removeKind）：不加回来。
        if (!this.storedKinds().includes(kind)) continue;
        this.extras.set(kind, agent);
        added.push(agent);
      } catch (error) {
        // 老云端不认这个种类（400）：本代不再重试，免得每次心跳都报一遍。
        if (error instanceof ApiError && error.statusCode === 400) this.rejectedKinds.add(kind);
        this.log({ event: "suduo.agent.register_failed", kind, message: messageOf(error) });
      }
    }
    return added;
  }

  private async heartbeatExtras(generation: number): Promise<void> {
    const added = await this.registerExtras(generation);
    // 晚登记上的（启动时失败、这次心跳才补上）：让接收器马上对一次账，不等定时同步。
    const first = added[0];
    if (first !== undefined && generation === this.generation) {
      try {
        this.deps.onRegistered?.(first);
      } catch (error) {
        this.log({ event: "suduo.agent.on_registered_failed", message: messageOf(error) });
      }
    }
    for (const [kind, agent] of [...this.extras]) {
      if (generation !== this.generation) return;
      try {
        const updated = agentOf(await this.deps.remote.heartbeatAgent(agent.id, { browserActive: this.deps.browserActive() }));
        // 心跳期间被去掉了（removeKind）：不加回来。
        if (updated !== null && generation === this.generation && this.extras.has(kind)) this.extras.set(kind, updated);
      } catch (error) {
        // 远程没有了（换了库等）：下次重新登记。其他错误等下次心跳。
        if (error instanceof ApiError && error.statusCode === 404) this.extras.delete(kind);
        this.log({ event: "suduo.agent.heartbeat_failed", kind, message: messageOf(error) });
      }
    }
  }

  private toUnregistered(message: ErrorText): void {
    this.clearTimer();
    this.agent = null;
    this.extras.clear();
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

/**
 * 设备名：主机名去掉 macOS 的 `.local` 后缀。设备名上报到需求服务、出现在别人看到的 Agent 名字里，
 * 是留存且跨用户的数据，取不到主机名时的兜底与语言无关。
 */
export function deviceNameOf(host: string): string {
  const name = host.trim().replace(/\.local$/iu, "");
  return name === "" ? "localhost" : name.slice(0, 120);
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
