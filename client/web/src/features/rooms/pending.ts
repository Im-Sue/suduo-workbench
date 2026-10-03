import type { QueryClient } from "@tanstack/react-query";
import type {
  RoomFileDto,
  RoomMentionInput,
  RoomMessageDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import { useMemo, useSyncExternalStore } from "react";
import { api } from "../../api/client.js";
import { applyIncomingMessage } from "./cache.js";

/**
 * 发送中的消息（需求 4.3 去重 / R13）：先在消息流里本地显示（灰），服务端返回后按 clientId 对齐替换。
 * - 实时事件比回执先到：缓存里已有同 clientId 的消息，占位自动隐藏（见 hidePending）；
 * - 失败：占位撤下，内容放回输入框，重试沿用同一个 clientId（服务端按它合并，不会重复）。
 * 按房间存在模块里，切房间 / 开关话题面板不丢。
 */
export interface PendingRoomMessage {
  clientId: string;
  roomId: string;
  threadRootId: string | null;
  body: string;
  mentions: RoomMentionInput[];
  files: RoomFileDto[];
  author: UserSummaryDto | null;
  createdAt: string;
}

const store = new Map<string, readonly PendingRoomMessage[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly PendingRoomMessage[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function add(item: PendingRoomMessage): void {
  const current = store.get(item.roomId) ?? EMPTY;
  store.set(item.roomId, [...current.filter((entry) => entry.clientId !== item.clientId), item]);
  emit();
}

function remove(roomId: string, clientId: string): void {
  const current = store.get(roomId) ?? EMPTY;
  const next = current.filter((entry) => entry.clientId !== clientId);
  if (next.length === 0) store.delete(roomId);
  else store.set(roomId, next);
  emit();
}

export function pendingOf(roomId: string): readonly PendingRoomMessage[] {
  return store.get(roomId) ?? EMPTY;
}

/** 测试用：清空全部占位。 */
export function resetPendingMessages(): void {
  store.clear();
  emit();
}

/** 某个房间（主消息流传 null，话题面板传根消息 id）的发送中占位。 */
export function usePendingMessages(roomId: string, threadRootId: string | null): PendingRoomMessage[] {
  const all = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pendingOf(roomId),
    () => pendingOf(roomId),
  );
  return useMemo(() => all.filter((item) => item.threadRootId === threadRootId), [all, threadRootId]);
}

/** 缓存里已经有同 clientId 的正式消息时，占位不再显示（实时事件比发送回执先到）。 */
export function hidePending(pending: readonly PendingRoomMessage[], messages: readonly RoomMessageDto[]): PendingRoomMessage[] {
  if (pending.length === 0) return [];
  const delivered = new Set(messages.map((message) => message.clientId).filter((id): id is string => id !== null));
  return pending.filter((item) => !delivered.has(item.clientId));
}

export function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 发出一条消息：先放占位，成功后写进缓存（与实时事件同一套合并）再撤占位；失败撤占位并抛出，由输入框放回草稿。
 */
export async function sendRoomMessage(queryClient: QueryClient, item: PendingRoomMessage): Promise<RoomMessageDto> {
  add(item);
  try {
    const message = await api.sendRoomMessage(item.roomId, {
      clientId: item.clientId,
      body: item.body,
      ...(item.mentions.length === 0 ? {} : { mentions: item.mentions }),
      threadRootId: item.threadRootId,
      ...(item.files.length === 0 ? {} : { fileIds: item.files.map((file) => file.id) }),
    });
    applyIncomingMessage(queryClient, message);
    return message;
  } finally {
    remove(item.roomId, item.clientId);
  }
}
