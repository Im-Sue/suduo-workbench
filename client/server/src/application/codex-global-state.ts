import type { JsonValue, RuntimeEventDraft } from "@suduo/client-contracts";
import { codexNativeType } from "../infrastructure/runtime/codex/codex-event-normalizer.js";

/**
 * 仅收录已经由隔离 CODEX_HOME 夹具证实的、无会话归属的 Codex 通知。
 * OAuth 完成通知待可重复实测后再加入，不能仅按协议名称推断。
 */
export const CODEX_GLOBAL_NATIVE_TYPES = [
  "configWarning",
  "remoteControl/status/changed",
  "skills/changed",
  // MCP 状态通知在隔离夹具中尚未实际发出；补到可重复原文证据后才可加入。
  // OAuth 完成通知同理，不能仅按协议 schema 的名称推断。
] as const;

const CODEX_GLOBAL_NATIVE_TYPE_SET = new Set<string>(CODEX_GLOBAL_NATIVE_TYPES);

export interface CodexGlobalStatusEntry {
  nativeType: string;
  payload: JsonValue;
  receivedAt: number;
}

export interface CodexGlobalStatus {
  version: number;
  updatedAt: number | null;
  entries: CodexGlobalStatusEntry[];
}

/** 无 threadId 官方通知的进程内投影；进程重启后按 Codex 重新通知重建。 */
export class CodexGlobalState {
  private readonly entries = new Map<string, CodexGlobalStatusEntry>();
  private readonly listeners = new Set<(status: CodexGlobalStatus) => void>();
  private version = 0;

  record(event: RuntimeEventDraft): CodexGlobalStatus {
    const nativeType = codexNativeType(event);
    if (!nativeType || !isCodexGlobalEvent(event)) {
      throw new Error("event is not a known unassociated Codex global notification");
    }
    this.version += 1;
    this.entries.set(nativeType, {
      nativeType,
      payload: event.payload,
      receivedAt: event.ts,
    });
    const status = this.snapshot();
    for (const listener of this.listeners) {
      listener(status);
    }
    return status;
  }

  snapshot(): CodexGlobalStatus {
    const entries = [...this.entries.values()].sort((left, right) =>
      left.nativeType.localeCompare(right.nativeType),
    );
    return {
      version: this.version,
      updatedAt:
        entries.length === 0
          ? null
          : Math.max(...entries.map((entry) => entry.receivedAt)),
      entries,
    };
  }

  subscribe(listener: (status: CodexGlobalStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** R4′：白名单与无 threadRef/sessionHint 两个条件必须同时成立。 */
export function isCodexGlobalEvent(event: RuntimeEventDraft): boolean {
  const nativeType = codexNativeType(event);
  return (
    nativeType !== null &&
    CODEX_GLOBAL_NATIVE_TYPE_SET.has(nativeType) &&
    event.threadRef === null &&
    event.sessionHint === undefined
  );
}
