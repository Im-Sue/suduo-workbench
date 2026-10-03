export const ASYNC_STATES = ["idle", "pending", "success", "failed"] as const;
export type AsyncStatus = (typeof ASYNC_STATES)[number];

export interface AsyncActionState {
  status: AsyncStatus;
  requestId: number | null;
  error: unknown | null;
}

export type AsyncActionEvent =
  | { type: "start"; requestId: number }
  | { type: "success"; requestId: number }
  | { type: "failed"; requestId: number; error: unknown }
  | { type: "dispose" }
  | { type: "reset" };

export const INITIAL_ASYNC_ACTION_STATE: AsyncActionState = {
  status: "idle",
  requestId: null,
  error: null,
};

export function reduceAsyncAction(
  state: AsyncActionState,
  event: AsyncActionEvent,
): AsyncActionState {
  if (event.type === "start") return { status: "pending", requestId: event.requestId, error: null };
  if (event.type === "reset" || event.type === "dispose") return INITIAL_ASYNC_ACTION_STATE;
  if (state.status !== "pending" || state.requestId !== event.requestId) return state;
  return event.type === "success"
    ? { status: "success", requestId: null, error: null }
    : { status: "failed", requestId: null, error: event.error };
}

export interface LatestRequest {
  id: number;
  signal: AbortSignal;
  isCurrent(): boolean;
}

export function createLatestWins(): { start(): LatestRequest; cancel(): void } {
  let sequence = 0;
  let controller: AbortController | null = null;
  return {
    start(): LatestRequest {
      controller?.abort();
      controller = new AbortController();
      const id = ++sequence;
      const current = controller;
      return { id, signal: current.signal, isCurrent: () => sequence === id && controller === current };
    },
    cancel(): void {
      controller?.abort();
      controller = null;
    },
  };
}

export function createSingleFlight<T>(): {
  run(key: string, task: () => Promise<T>): Promise<T>;
} {
  const inFlight = new Map<string, Promise<T>>();
  return {
    run(key: string, task: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;
      const promise = task().finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
  };
}
