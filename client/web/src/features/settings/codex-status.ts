import { useSyncExternalStore } from "react";
import { api } from "../../api/client.js";
import { localizeNotice } from "../../event-projection/shared.js";

/**
 * Codex 的全局通知（无会话归属，例如配置提醒）经本机服务的推送流到达。
 * 设置页多处要用（分组红点、模型服务、诊断），这里共用一条连接：有人订阅时连上，没人时断开。
 */
export interface CodexStatusEntry {
  nativeType: string;
  payload?: unknown;
  receivedAt: number;
}

export interface CodexStatusSnapshot {
  /** connecting：还没收到第一条；live：已收到；broken：推送中断（浏览器会自动重连）。 */
  stream: "connecting" | "live" | "broken";
  entries: readonly CodexStatusEntry[];
}

const INITIAL: CodexStatusSnapshot = { stream: "connecting", entries: [] };

let snapshot: CodexStatusSnapshot = INITIAL;
let source: EventSource | null = null;
const listeners = new Set<() => void>();

function emit(next: CodexStatusSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function connect(): void {
  if (source !== null || typeof EventSource === "undefined") return;
  source = new EventSource(api.codexStatusUrl());
  source.addEventListener("status", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent<string>).data) as { entries?: CodexStatusEntry[] };
      emit({ stream: "live", entries: Array.isArray(data.entries) ? data.entries : [] });
    } catch {
      // 单条解析失败不代表连接坏了。
    }
  });
  source.onerror = () => emit({ ...snapshot, stream: "broken" });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
      snapshot = INITIAL;
    }
  };
}

export function useCodexStatus(): CodexStatusSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => INITIAL);
}

/** Codex 对当前配置给出的提醒（configWarning）；没有则为 null。 */
export function configWarningOf(status: CodexStatusSnapshot): { summary: string | null; details: string | null } | null {
  const entry = status.entries.find((item) => item.nativeType === "configWarning");
  if (entry === undefined) return null;
  const payload = entry.payload;
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  const summary = record["summary"];
  const details = record["details"];
  return {
    // 与会话时间线里的同一条提示用同一套本地化（英文原文里带本机配置文件的绝对路径）。
    summary: typeof summary === "string" && summary.trim() !== "" ? localizeNotice(summary) : null,
    details: typeof details === "string" && details.trim() !== "" ? details : null,
  };
}
