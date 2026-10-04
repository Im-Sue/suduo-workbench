import {
  ROOM_FILE_MAX_BYTES,
  type RoomFileDto,
  type RoomFileKind,
  type RoomMentionInput,
} from "@suduo/cloud-contracts";
import { useCallback, useSyncExternalStore } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import type { Failure } from "../../feedback/types.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor } from "../../i18n/messages/index.js";
import { newClientId } from "./pending.js";

/**
 * 房间输入框的草稿（按「房间 + 话题」分开存在模块里）：
 * - 切房间、关话题面板再打开，没发出去的字和正在传的文件都还在（未保存输入不丢，ADR-0004 红线）；
 * - 文件选好就开始传（带进度、可移除、失败可重试），发送时只带传好的；
 * - 发送失败：内容放回这里，并记下那次的 clientId，原样再发时沿用它（服务端按它合并，不会重复）。
 */
export interface DraftFile {
  localId: string;
  name: string;
  size: number;
  kind: RoomFileKind;
  state: "uploading" | "done" | "failed";
  progress: number;
  error: string | null;
  result: RoomFileDto | null;
  file: File;
}

export interface PickedMention {
  kind: "user" | "agent" | "all";
  id: string | null;
  /** 插进输入框的文字（不含 @）。 */
  text: string;
}

export interface RoomDraft {
  text: string;
  files: DraftFile[];
  picked: PickedMention[];
  /** 上一次没发出去的：正文相同、文件相同时重发沿用它的 clientId。 */
  retry: { clientId: string; body: string; fileIds: string[] } | null;
  error: Failure | null;
}

export const EMPTY_DRAFT: RoomDraft = { text: "", files: [], picked: [], retry: null, error: null };

const drafts = new Map<string, RoomDraft>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

export function draftKey(roomId: string, threadRootId: string | null): string {
  return `${roomId}:${threadRootId ?? "main"}`;
}

export function getDraft(key: string): RoomDraft {
  return drafts.get(key) ?? EMPTY_DRAFT;
}

export function updateDraft(key: string, update: (draft: RoomDraft) => RoomDraft): void {
  const next = update(getDraft(key));
  if (next.text === "" && next.files.length === 0 && next.retry === null && next.error === null) drafts.delete(key);
  else drafts.set(key, next);
  for (const listener of listeners) listener();
}

/** 测试用：清空全部草稿。 */
export function resetDrafts(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  drafts.clear();
  for (const listener of listeners) listener();
}

export function useRoomDraft(key: string): [RoomDraft, (update: (draft: RoomDraft) => RoomDraft) => void] {
  const draft = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getDraft(key),
    () => getDraft(key),
  );
  const update = useCallback((fn: (draft: RoomDraft) => RoomDraft) => updateDraft(key, fn), [key]);
  return [draft, update];
}

export function fileKindOf(file: { type: string }): RoomFileKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

function patchFile(key: string, localId: string, change: Partial<DraftFile>): void {
  updateDraft(key, (draft) => ({
    ...draft,
    files: draft.files.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
  }));
}

function upload(key: string, roomId: string, item: DraftFile): void {
  const controller = new AbortController();
  controllers.set(item.localId, controller);
  api
    .uploadRoomFile(roomId, item.file, (progress) => patchFile(key, item.localId, { progress }), controller.signal)
    .then((result) => patchFile(key, item.localId, { state: "done", progress: 100, result, error: null }))
    .catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      patchFile(key, item.localId, { state: "failed", error: classifyFailure(cause).message });
    })
    .finally(() => controllers.delete(item.localId));
}

/** 选好 / 粘贴 / 拖入的文件：逐个开始上传。超过 300 MB 的直接标失败（不可重试）。 */
export function addDraftFiles(key: string, roomId: string, files: readonly File[]): void {
  const text = messagesFor(currentLocale()).rooms.composer.file;
  const items: DraftFile[] = files.map((file) => ({
    localId: newClientId(),
    name: file.name === "" ? text.pastedImageName : file.name,
    size: file.size,
    kind: fileKindOf(file),
    state: file.size > ROOM_FILE_MAX_BYTES ? "failed" : "uploading",
    progress: 0,
    error: file.size > ROOM_FILE_MAX_BYTES ? text.tooLarge : null,
    result: null,
    file,
  }));
  if (items.length === 0) return;
  updateDraft(key, (draft) => ({ ...draft, files: [...draft.files, ...items] }));
  for (const item of items) if (item.state === "uploading") upload(key, roomId, item);
}

export function retryDraftFile(key: string, roomId: string, localId: string): void {
  const item = getDraft(key).files.find((entry) => entry.localId === localId);
  if (item === undefined || item.size > ROOM_FILE_MAX_BYTES) return;
  patchFile(key, localId, { state: "uploading", progress: 0, error: null });
  upload(key, roomId, { ...item, state: "uploading" });
}

export function removeDraftFile(key: string, localId: string): void {
  controllers.get(localId)?.abort();
  controllers.delete(localId);
  updateDraft(key, (draft) => ({ ...draft, files: draft.files.filter((item) => item.localId !== localId) }));
}

/** 发送时带上的 @：正文里还留着「@文字」的才算；同一个对象只算一次。 */
export function collectMentions(body: string, picked: readonly PickedMention[]): RoomMentionInput[] {
  const seen = new Set<string>();
  const result: RoomMentionInput[] = [];
  for (const mention of picked) {
    if (!body.includes(`@${mention.text}`)) continue;
    const key = `${mention.kind}:${mention.id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (mention.kind === "all") result.push({ kind: "all" });
    else if (mention.id !== null) result.push({ kind: mention.kind, id: mention.id });
  }
  return result;
}
