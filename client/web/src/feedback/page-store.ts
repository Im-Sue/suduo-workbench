import type { Failure, FeedbackRoute } from "./types.js";

export interface PageFeedback {
  failure: Failure;
  route: FeedbackRoute;
  retry: (() => void) | undefined;
}

let pageFeedback: PageFeedback | null = null;
let authExpiredHandler: (() => void) | null = null;
export interface PageFeedbackSnapshot {
  pageFeedback: PageFeedback | null;
  authExpiredHandler: (() => void) | null;
}

let pageFeedbackSnapshot: PageFeedbackSnapshot = { pageFeedback, authExpiredHandler };
const listeners = new Set<() => void>();

function updateSnapshot(): void {
  pageFeedbackSnapshot = { pageFeedback, authExpiredHandler };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribePageFeedback(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPageFeedback(): PageFeedback | null {
  return pageFeedback;
}

/** 引用只在 page feedback 或 auth handler 真正变化时更新，供 useSyncExternalStore 使用。 */
export function getPageFeedbackSnapshot(): PageFeedbackSnapshot {
  return pageFeedbackSnapshot;
}

export function publishPageFeedback(next: PageFeedback): void {
  pageFeedback = next;
  updateSnapshot();
  notify();
}

export function clearPageFeedback(): void {
  if (pageFeedback !== null) {
    pageFeedback = null;
    updateSnapshot();
    notify();
  }
}

export function getAuthExpiredHandler(): (() => void) | null {
  return authExpiredHandler;
}

export function registerAuthExpiredHandler(handler: () => void): () => void {
  authExpiredHandler = handler;
  updateSnapshot();
  notify();
  return () => {
    if (authExpiredHandler === handler) {
      authExpiredHandler = null;
      updateSnapshot();
      notify();
    }
  };
}
