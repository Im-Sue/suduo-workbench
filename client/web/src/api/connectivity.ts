/**
 * 本机服务连通性：由 api/client 的每次请求结果驱动。
 * - 请求在网络层失败（fetch 抛出，非主动取消）→ 视为断开；
 * - 任意一次拿到 HTTP 响应（无论状态码）→ 视为恢复。
 * 外壳的连接横幅订阅它，不需要额外心跳请求。
 */
export type Connectivity = "online" | "offline";

let state: Connectivity = "online";
let offlineSince: number | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function markRequestReachedServer(): void {
  if (state === "online") return;
  state = "online";
  offlineSince = null;
  emit();
}

export function markRequestNetworkFailure(error: unknown): void {
  if (error instanceof DOMException && error.name === "AbortError") return;
  if (state === "offline") return;
  state = "offline";
  offlineSince = Date.now();
  emit();
}

export function getConnectivity(): Connectivity {
  return state;
}

export function getOfflineSince(): number | null {
  return offlineSince;
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 仅供测试复位。 */
export function resetConnectivityForTest(): void {
  state = "online";
  offlineSince = null;
  emit();
}
