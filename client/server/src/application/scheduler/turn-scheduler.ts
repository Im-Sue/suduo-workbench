import { randomUUID } from "node:crypto";
import type { SchedulerSource } from "@suduo/client-contracts";

/**
 * 本机回合调度（多 Agent 协作 S8，技术设计 2.7、需求 4.11）：每个回合开始前先拿名额，回合结束还名额。
 *
 * - 名额：每家 Agent 一个上限（默认 2），全部合计一个上限（默认 4），设置里可改。
 * - 排队不拒绝（R4）：超出上限的回合排队，按先后轮到；某一家满了不挡别家的。可「先跑这个」（移到队首）、可取消。
 * - 同一会话一次只放行一个：会话里已有回合在跑时，排队的这一项等它结束（会话里没有排队项时，再发的消息由运行时并入
 *   或排在会话内，调用方先问 `sessionRunning` / `sessionQueued`）。运行时自己接着开的回合（Claude、ACP 会话内排队）
 *   在开始时补登记（`turnStarted`），照样占名额。
 * - 名额在回合真正结束（账本里的终态事件）时还；开不起来时调用方立即还。另有定时对账，防止终态丢了、
 *   开回合卡住时名额永远占着。
 *
 * 只记在内存：本机服务重启后不恢复。排队中的委派由委派服务按库里的状态重新提交；用户自己的排队消息记为
 * 「重启没发出」，提示重发（消息服务启动时收尾）。
 */

export type { SchedulerSource };

export interface SchedulerItem {
  id: string;
  sessionId: string;
  agentId: string;
  source: SchedulerSource;
  /** 运行面板上的说明（会话标题、委派任务等）。 */
  label: string;
  state: "running" | "queued";
  /** 排队中的位置（第 1 位 = 下一个），运行中为 null。 */
  position: number | null;
  enqueuedAt: number;
  startedAt: number | null;
  /** 开起来的回合（还没开起来为 null）。 */
  turnId: string | null;
}

export interface SchedulerSnapshot {
  running: SchedulerItem[];
  queued: SchedulerItem[];
  limits: { global: number; perAgent: Record<string, number> };
}

export interface TurnTicket {
  id: string;
  /** 不用排队、马上拿到了名额。 */
  immediate: boolean;
  /** 拿到名额时兑现；排队中被取消时以 `SchedulerCancelledError` 拒绝。 */
  admitted: Promise<void>;
  /** 回合开起来了：记下回合 ID，名额等它结束再还。 */
  started(turnId: string): void;
  /** 开不起来或不要了：还名额（排队中的出队）。重复调用无害。 */
  release(): void;
}

export class SchedulerCancelledError extends Error {
  /** reason：cancelled（用户 / 停止级联）、archived、deleted（会话不能用了）。 */
  constructor(readonly reason: string = "cancelled") {
    super("cancelled while queued: " + reason);
    this.name = "SchedulerCancelledError";
  }
}

export interface TurnSchedulerDependencies {
  /** 当前的上限（每次调度时取；设置改了调 `refresh` 立即按新上限放行）。 */
  limits(): { global: number; perAgent(agentId: string): number };
  now?: () => number;
}

/** 拿到名额后多久还没开起来（startTurn 卡住）、账本里这个会话也没有回合在跑，就收回名额。 */
const UNSTARTED_MAX_MS = 5 * 60_000;
/** 记住最近结束的回合：终态比 `started` 先到时，登记时立即还名额。 */
const RECENTLY_ENDED_LIMIT = 200;

interface Entry extends Omit<SchedulerItem, "state" | "position"> {
  state: "running" | "queued";
  resolve(): void;
  reject(error: Error): void;
  released: boolean;
  /** 回合开起来（记上回合 ID）时要做的事（还在开时被叫停：开起来就中断它）。 */
  onStarted: Array<(turnId: string) => void>;
  /** 让出名额的次数：发起回合挂在 delegate_wait 上等子会话时不占名额（子会话要的可能正是同一家的名额）。 */
  lent: number;
}

export class TurnScheduler {
  private readonly running = new Map<string, Entry>();
  private queue: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly recentlyEnded: string[] = [];

  constructor(private readonly deps: TurnSchedulerDependencies) {}

  /** 这个会话有没有在跑（或刚拿到名额正在开）的回合。 */
  sessionRunning(sessionId: string): boolean {
    for (const entry of this.running.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }

  /** 这个会话有没有排队中的回合。 */
  sessionQueued(sessionId: string): boolean {
    return this.queue.some((entry) => entry.sessionId === sessionId);
  }

  /**
   * 这个会话有没有还没开起来的：排队中的，或刚拿到名额、回合还在开的。有的话再发的消息要排在后面，
   * 不能先交给运行时（会抢在排了很久的那条前面开回合）。
   */
  sessionPending(sessionId: string): boolean {
    if (this.sessionQueued(sessionId)) return true;
    for (const entry of this.running.values()) if (entry.sessionId === sessionId && entry.turnId === null) return true;
    return false;
  }

  /** 运行中的这一项开起来时（已开起来就立即）调用 callback；不在运行中返回 false。 */
  whenStarted(id: string, callback: (turnId: string) => void): boolean {
    const entry = this.running.get(id);
    if (entry === undefined) return false;
    if (entry.turnId !== null) callback(entry.turnId);
    else entry.onStarted.push(callback);
    return true;
  }

  /**
   * 让出这个会话运行中回合的名额，直到调用返回的函数（发起回合在等委派结果、自己不干活时，S8）。
   * 收回时如果名额已被别人用上，会暂时超出上限一个。
   */
  lend(sessionId: string): () => void {
    const entries = [...this.running.values()].filter((entry) => entry.sessionId === sessionId);
    for (const entry of entries) entry.lent += 1;
    if (entries.length > 0) {
      this.pump();
      this.changed();
    }
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      for (const entry of entries) entry.lent = Math.max(0, entry.lent - 1);
    };
  }

  request(input: { sessionId: string; agentId: string; source: SchedulerSource; label: string }): TurnTicket {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const admitted = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // 没人等的拒绝不算未处理（取消时调用方可能已经不关心了）。
    admitted.catch(() => undefined);
    const entry: Entry = {
      id: randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      source: input.source,
      label: input.label,
      state: "queued",
      enqueuedAt: this.now(),
      startedAt: null,
      turnId: null,
      resolve,
      reject,
      released: false,
      onStarted: [],
      lent: 0,
    };
    // 排到队尾再按同样的规则放行一遍：前面的都被挡着（那一家满了、那个会话在跑）时，这一项可以直接开。
    this.queue.push(entry);
    this.pump();
    const immediate = entry.state === "running";
    this.changed();
    return {
      id: entry.id,
      immediate,
      admitted,
      started: (turnId) => {
        this.markStarted(entry, turnId);
        // 回合已经结束了（终态先于这里到达）：立即还名额。
        if (this.recentlyEnded.includes(endedKey(entry.sessionId, turnId))) {
          this.release(entry);
          return;
        }
        this.changed();
      },
      release: () => this.release(entry),
    };
  }

  /**
   * 账本里某个回合开始了。没登记过的（运行时自己接着开的会话内排队回合、对账收回后才开起来的）补登记为运行中，
   * 照样占名额；刚拿到名额、还在开的那一项直接记上回合 ID。
   */
  turnStarted(input: { sessionId: string; agentId: string; turnId: string; label: string }): void {
    const mine = [...this.running.values()].filter((entry) => entry.sessionId === input.sessionId);
    if (mine.some((entry) => entry.turnId === input.turnId)) return;
    const opening = mine.find((entry) => entry.turnId === null);
    if (opening !== undefined) {
      this.markStarted(opening, input.turnId);
      this.changed();
      return;
    }
    const entry: Entry = {
      id: randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      source: "user",
      label: input.label,
      state: "running",
      enqueuedAt: this.now(),
      startedAt: this.now(),
      turnId: input.turnId,
      resolve: () => undefined,
      reject: () => undefined,
      released: false,
      onStarted: [],
      lent: 0,
    };
    this.running.set(entry.id, entry);
    this.changed();
  }

  private markStarted(entry: Entry, turnId: string): void {
    if (entry.turnId === turnId) return;
    entry.turnId = turnId;
    for (const callback of entry.onStarted.splice(0)) {
      try {
        callback(turnId);
      } catch {
        // 回调出错不影响调度。
      }
    }
  }

  /** 账本里某个回合结束了：还它的名额（还没登记的记下来，登记时立即还）。 */
  turnEnded(sessionId: string, turnId: string): void {
    for (const entry of this.running.values()) {
      if (entry.sessionId === sessionId && entry.turnId === turnId) {
        this.release(entry);
        return;
      }
    }
    this.recentlyEnded.push(endedKey(sessionId, turnId));
    if (this.recentlyEnded.length > RECENTLY_ENDED_LIMIT) this.recentlyEnded.shift();
  }

  /**
   * 对账：运行中的回合在账本里已经不在跑了（终态事件丢了、进程崩了）就还名额；拿到名额后很久还没开起来、
   * 这个会话在账本里也没有回合在跑的（开回合卡住）同样收回。
   */
  reconcile(runningTurns: (sessionId: string) => readonly string[], minAgeMs = 0, unstartedMaxMs = UNSTARTED_MAX_MS): void {
    const now = this.now();
    for (const entry of [...this.running.values()]) {
      const age = now - (entry.startedAt ?? now);
      if (entry.turnId === null) {
        if (age >= unstartedMaxMs && runningTurns(entry.sessionId).length === 0) this.release(entry);
        continue;
      }
      // 刚开起来的回合，开始事件可能还没进账本：等一会儿再对。
      if (age < minAgeMs) continue;
      if (!runningTurns(entry.sessionId).includes(entry.turnId)) this.release(entry);
    }
    this.refresh();
  }

  /** 上限改了：按新上限放行排队项。 */
  refresh(): void {
    const before = this.queue.length;
    this.pump();
    if (this.queue.length !== before) this.changed();
  }

  /** 先跑这个：移到队首（R4）。不在队里返回 false。 */
  promote(id: string): boolean {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    this.queue.unshift(entry!);
    this.pump();
    this.changed();
    return true;
  }

  /** 取消排队中的：出队并让等的人收到取消。运行中的不在这里停（要中断回合）。 */
  cancel(id: string, reason = "cancelled"): boolean {
    const entry = this.queue.find((candidate) => candidate.id === id);
    if (entry === undefined) return false;
    this.release(entry);
    entry.reject(new SchedulerCancelledError(reason));
    return true;
  }

  /** 按会话取消排队中的（停止级联、删除 / 归档会话时，reason 记下为什么）。 */
  cancelSession(sessionId: string, reason = "cancelled"): number {
    const ids = this.queue.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.id);
    for (const id of ids) this.cancel(id, reason);
    return ids.length;
  }

  snapshot(agentIds: readonly string[] = []): SchedulerSnapshot {
    const limits = this.deps.limits();
    const perAgent: Record<string, number> = {};
    for (const agentId of new Set([...agentIds, ...[...this.running.values(), ...this.queue].map((entry) => entry.agentId)])) {
      perAgent[agentId] = limits.perAgent(agentId);
    }
    return {
      running: [...this.running.values()].map((entry) => this.item(entry, null)),
      queued: this.queue.map((entry, index) => this.item(entry, index + 1)),
      limits: { global: limits.global, perAgent },
    };
  }

  /** 这个会话排队中的回合现在第几位（没有排队的为 null）。 */
  sessionPosition(sessionId: string): number | null {
    const index = this.queue.findIndex((entry) => entry.sessionId === sessionId);
    return index < 0 ? null : index + 1;
  }

  /** 排队中某一项现在第几位（不在队里为 null）。 */
  position(id: string): number | null {
    const index = this.queue.findIndex((entry) => entry.id === id);
    return index < 0 ? null : index + 1;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private release(entry: Entry): void {
    if (entry.released) return;
    entry.released = true;
    if (entry.state === "running") {
      this.running.delete(entry.id);
    } else {
      this.queue = this.queue.filter((candidate) => candidate !== entry);
    }
    this.pump();
    this.changed();
  }

  private admit(entry: Entry): void {
    entry.state = "running";
    entry.startedAt = this.now();
    this.running.set(entry.id, entry);
    entry.resolve();
  }

  /** 按先后放行：某一家满了、或这个会话已有回合在跑就跳过它，不挡别的；合计满了就停。 */
  private pump(): void {
    for (const entry of [...this.queue]) {
      if (!this.hasRoomGlobally()) break;
      if (!this.hasRoom(entry.agentId) || this.sessionRunning(entry.sessionId)) continue;
      this.queue = this.queue.filter((candidate) => candidate !== entry);
      this.admit(entry);
    }
  }

  private hasRoomGlobally(): boolean {
    let count = 0;
    for (const entry of this.running.values()) if (entry.lent === 0) count += 1;
    return count < Math.max(1, this.deps.limits().global);
  }

  private hasRoom(agentId: string): boolean {
    if (!this.hasRoomGlobally()) return false;
    let count = 0;
    for (const entry of this.running.values()) if (entry.agentId === agentId && entry.lent === 0) count += 1;
    return count < Math.max(1, this.deps.limits().perAgent(agentId));
  }

  private item(entry: Entry, position: number | null): SchedulerItem {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      source: entry.source,
      label: entry.label,
      state: entry.state,
      position,
      enqueuedAt: entry.enqueuedAt,
      startedAt: entry.startedAt,
      turnId: entry.turnId,
    };
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 监听方出错不影响调度。
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function endedKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}
