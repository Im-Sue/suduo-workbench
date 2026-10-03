import type { QueryClient } from "@tanstack/react-query";
import { REQUIREMENTS_WEB_ATTACHMENT_UPLOAD_PRECHECK_LIMIT } from "@suduo/cloud-contracts";
import { useSyncExternalStore } from "react";
import { api, REQUIREMENT_ATTACHMENT_MAX_BYTES } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { requirementKeys } from "./keys.js";

/**
 * 需求材料的上传队列（修复审计缺陷「一个文件失败后整批卡住」）：
 * - 每个文件独立排队、独立失败，最多同时传 2 个，失败不阻塞后面的文件；
 * - 失败的文件可单独重试，重试沿用同一个幂等键，响应丢失后重传不会多出一份；
 * - 队列按需求保存在模块里：在速览和详情之间切换、关掉再打开，进度都还在；
 *   登录身份变化时整体清空（resetUploadQueues），不把上一个人的文件带给下一个人。
 */
export type UploadState = "queued" | "uploading" | "done" | "failed";

export interface UploadItem {
  id: string;
  requirementId: string;
  file: File;
  idempotencyKey: string;
  state: UploadState;
  /** 0–100 */
  progress: number;
  error: string | null;
  /** 超过单文件大小上限：重试也不会成功，只能移除。 */
  retryable: boolean;
}

export interface EnqueueOptions {
  /** 某个文件上传失败时回调（例如新建对话框已关闭，需要另行告知）。 */
  onFailed?(item: UploadItem): void;
}

const CONCURRENCY = 2;
const DONE_LINGER_MS = 1_200;

const queues = new Map<string, UploadItem[]>();
const controllers = new Map<string, AbortController>();
const clients = new Map<string, QueryClient>();
const failureHandlers = new Map<string, (item: UploadItem) => void>();
const listeners = new Set<() => void>();
const EMPTY: UploadItem[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function itemsOf(requirementId: string): UploadItem[] {
  return queues.get(requirementId) ?? EMPTY;
}

function setItems(requirementId: string, items: UploadItem[]): void {
  if (items.length === 0) queues.delete(requirementId);
  else queues.set(requirementId, items);
  emit();
}

function patch(requirementId: string, id: string, change: Partial<UploadItem>): void {
  setItems(
    requirementId,
    itemsOf(requirementId).map((item) => (item.id === id ? { ...item, ...change } : item)),
  );
}

function remove(requirementId: string, id: string): void {
  failureHandlers.delete(id);
  setItems(
    requirementId,
    itemsOf(requirementId).filter((item) => item.id !== id),
  );
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 加入队列。`existingCount` 是需求当前已有的附件数，用于在选文件时就提示超过上限的部分，
 * 最终以服务端判断为准。
 */
export function enqueueUploads(
  queryClient: QueryClient,
  requirementId: string,
  files: readonly File[],
  existingCount: number,
  options: EnqueueOptions = {},
): void {
  clients.set(requirementId, queryClient);
  const current = itemsOf(requirementId);
  let room =
    REQUIREMENTS_WEB_ATTACHMENT_UPLOAD_PRECHECK_LIMIT -
    existingCount -
    current.filter((item) => item.state !== "failed" && item.state !== "done").length;
  const added = files.map((file): UploadItem => {
    const base = {
      id: newId(),
      requirementId,
      file,
      idempotencyKey: newId(),
      progress: 0,
    };
    const rejected = precheck(file, room);
    // 超过大小重试也没用；超过数量删掉旧材料后就能传，仍可重试（最终以服务端判断为准）。
    if (rejected !== null) {
      return { ...base, state: "failed", error: rejected, retryable: file.size <= REQUIREMENT_ATTACHMENT_MAX_BYTES };
    }
    room -= 1;
    return { ...base, state: "queued", error: null, retryable: true };
  });
  if (options.onFailed !== undefined) {
    for (const item of added) failureHandlers.set(item.id, options.onFailed);
  }
  setItems(requirementId, [...current, ...added]);
  for (const item of added) if (item.state === "failed") failureHandlers.get(item.id)?.(item);
  pump(requirementId);
}

/** 选文件时的本地预检：超过单文件大小或单需求数量上限返回原因，否则 null。最终以服务端判断为准。 */
export function precheck(file: File, room: number, t: Messages = messagesFor(currentLocale())): string | null {
  if (file.size > REQUIREMENT_ATTACHMENT_MAX_BYTES) return t.requirementDetail.upload.tooLarge;
  if (room <= 0) return t.requirementDetail.upload.tooMany(REQUIREMENTS_WEB_ATTACHMENT_UPLOAD_PRECHECK_LIMIT);
  return null;
}

export function retryUpload(requirementId: string, id: string): void {
  const item = itemsOf(requirementId).find((entry) => entry.id === id);
  if (item === undefined || !item.retryable || item.state !== "failed") return;
  patch(requirementId, id, { state: "queued", progress: 0, error: null });
  pump(requirementId);
}

/** 取消：正在传的中止，排队 / 失败的直接移出队列。 */
export function cancelUpload(requirementId: string, id: string): void {
  const controller = controllers.get(id);
  if (controller !== undefined) {
    controller.abort();
    return;
  }
  remove(requirementId, id);
  pump(requirementId);
}

export function dismissFailedUploads(requirementId: string): void {
  setItems(
    requirementId,
    itemsOf(requirementId).filter((item) => item.state !== "failed"),
  );
}

function pump(requirementId: string): void {
  const items = itemsOf(requirementId);
  let running = items.filter((item) => item.state === "uploading").length;
  for (const item of items) {
    if (running >= CONCURRENCY) break;
    if (item.state !== "queued") continue;
    running += 1;
    void run(item);
  }
}

async function run(item: UploadItem): Promise<void> {
  const { requirementId, id } = item;
  const controller = new AbortController();
  controllers.set(id, controller);
  patch(requirementId, id, { state: "uploading", progress: 0, error: null });
  let lastProgress = 0;
  try {
    await api.uploadRequirementAttachment(
      requirementId,
      item.file,
      item.idempotencyKey,
      (percent) => {
        // 进度事件很密，只在变化 ≥ 2% 时刷新界面。
        if (percent - lastProgress < 2 && percent < 100) return;
        lastProgress = percent;
        patch(requirementId, id, { progress: percent });
      },
      controller.signal,
    );
    patch(requirementId, id, { state: "done", progress: 100 });
    failureHandlers.delete(id);
    refresh(requirementId);
    window.setTimeout(() => remove(requirementId, id), DONE_LINGER_MS);
  } catch (cause) {
    if (controller.signal.aborted) {
      remove(requirementId, id);
    } else {
      patch(requirementId, id, { state: "failed", error: classifyFailure(cause).message });
      const failed = itemsOf(requirementId).find((entry) => entry.id === id);
      if (failed !== undefined) failureHandlers.get(id)?.(failed);
    }
  } finally {
    controllers.delete(id);
    pump(requirementId);
  }
}

function refresh(requirementId: string): void {
  const queryClient = clients.get(requirementId);
  if (queryClient === undefined) return;
  void queryClient.invalidateQueries({ queryKey: requirementKeys.attachments(requirementId) });
  void queryClient.invalidateQueries({ queryKey: requirementKeys.activity(requirementId) });
  void queryClient.invalidateQueries({ queryKey: requirementKeys.detail(requirementId) });
}

/** 当前队列快照（组件用 useUploadQueue 订阅）。 */
export function uploadQueueSnapshot(requirementId: string): UploadItem[] {
  return itemsOf(requirementId);
}

export function useUploadQueue(requirementId: string): UploadItem[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => itemsOf(requirementId),
    () => EMPTY,
  );
}

/** 清空所有队列并中止进行中的上传（登录身份变化时调用；测试也用它复位）。 */
export function resetUploadQueues(): void {
  queues.clear();
  clients.clear();
  failureHandlers.clear();
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  emit();
}
