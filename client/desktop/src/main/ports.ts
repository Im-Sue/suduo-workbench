import { createServer } from "node:net";
import type { HealthzResponse } from "@suduo/client-contracts";

/** 首选端口与备选范围（技术设计 §二）：与源码运行的 8787 分开，同时开着互不接管。 */
export const PREFERRED_PORT = 8790;
export const LAST_CANDIDATE_PORT = 8799;

/** 端口上的情况：空闲；是自己上次留下的服务（同一实例标识的 desktop 服务）；被别的程序（含别的 SuDuo）占着。 */
export type PortState = "free" | "ours" | "busy";

export interface PortChoice {
  port: number;
  /** 端口上是上次外壳异常退出留下的服务，要先停掉它再拉起新的。 */
  orphan: boolean;
}

/** 按「上次用的 → 首选 → 依次备选」找第一个空闲或属于自己的端口；都不行返回 null。 */
export async function choosePort(input: {
  remembered: number | null;
  inspect(port: number): Promise<PortState>;
}): Promise<PortChoice | null> {
  const order = candidatePorts(input.remembered);
  for (const port of order) {
    const state = await input.inspect(port);
    if (state === "free") return { port, orphan: false };
    if (state === "ours") return { port, orphan: true };
  }
  return null;
}

export function candidatePorts(remembered: number | null): number[] {
  const range: number[] = [];
  for (let port = PREFERRED_PORT; port <= LAST_CANDIDATE_PORT; port += 1) range.push(port);
  if (remembered === null) return range;
  return [remembered, ...range.filter((port) => port !== remembered)];
}

/** /healthz 的回应是不是自己（同一实例标识）拉起的桌面版本机服务。 */
export function isOwnServer(body: unknown, instanceId: string): boolean {
  if (!body || typeof body !== "object") return false;
  const health = body as Partial<HealthzResponse>;
  return health.product === "suduo" && health.runMode === "desktop" && health.instanceId === instanceId;
}

export async function fetchHealth(baseUrl: string, timeoutMs = 1_000): Promise<{ up: false } | { up: true; body: unknown }> {
  try {
    const response = await fetch(new URL("healthz", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = await response.json().catch(() => null);
    return { up: true, body };
  } catch {
    return { up: false };
  }
}

/** 先试着绑定：能绑上就是空闲（比只看 HTTP 可靠，占着端口的不一定是 HTTP 程序）；绑不上再看是不是自己的服务。 */
export async function inspectPort(port: number, instanceId: string): Promise<PortState> {
  if (await canBind(port)) return "free";
  const health = await fetchHealth(`http://127.0.0.1:${String(port)}/`);
  return health.up && isOwnServer(health.body, instanceId) ? "ours" : "busy";
}

export function canBind(port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once("error", () => resolveBind(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolveBind(true));
    });
  });
}

/** 进程是否还在（只用来判断；EPERM 表示进程在、只是不属于当前用户）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
