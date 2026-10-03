import type { AuthSessionDto } from "@suduo/cloud-contracts";
import type { RequirementsCredentialStore } from "../infrastructure/requirements-v2/credential-store.js";
import type { RequirementsSettingsStore } from "../infrastructure/requirements-v2/settings-store.js";
import { ApiError } from "./api-error.js";

/**
 * 登录续期（技术设计二、九；需求七「登录 8 小时过期 → 共享 Agent 莫名离线」）：
 * 读本机凭证的 expiresAt，过期前 1 小时调 `POST /v2/auth/refresh` 换新令牌并保存；
 * 启动时剩余不足 1 小时立即续。失败按退避重试；401（令牌已失效）不再重试，等用户重新登录。
 */
export interface TokenRefresherDependencies {
  settings: Pick<RequirementsSettingsStore, "getBaseUrl">;
  credentials: Pick<RequirementsCredentialStore, "getForBaseUrl" | "save">;
  remote: { refreshAuth(): Promise<AuthSessionDto> };
  /** 续期成功、新令牌已保存（上游推送连接据此重连）。 */
  onRefreshed?(): void;
  /** 过期前多久续，默认 1 小时。 */
  leadMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  now?(): number;
  log?(line: Record<string, unknown>): void;
}

/** setTimeout 的上限（约 24.8 天）；更远的到期时间分段等。 */
const MAX_TIMER_MS = 2_147_483_647;

export class TokenRefresher {
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private retryMs: number;
  private readonly leadMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: TokenRefresherDependencies) {
    this.leadMs = deps.leadMs ?? 60 * 60_000;
    this.retryInitialMs = deps.retryInitialMs ?? 30_000;
    this.retryMaxMs = deps.retryMaxMs ?? 10 * 60_000;
    this.retryMs = this.retryInitialMs;
    this.now = deps.now ?? Date.now;
  }

  /** 启动或在登录态变化（登录 / 退出 / 改服务地址）后重新排期。 */
  reschedule(): void {
    this.generation += 1;
    this.clear();
    this.retryMs = this.retryInitialMs;
    this.schedule(this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.clear();
  }

  /** 下一次续期的时刻（测试与诊断用）；没有排期为 null。 */
  nextRefreshAt: number | null = null;

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRefreshAt = null;
  }

  private current(): { baseUrl: string; accessToken: string; expiresAt: number } | null {
    const baseUrl = this.deps.settings.getBaseUrl();
    if (!baseUrl) return null;
    const session = this.deps.credentials.getForBaseUrl(baseUrl, this.now());
    if (!session) return null;
    const expiresAt = Date.parse(session.expiresAt);
    return Number.isFinite(expiresAt) ? { baseUrl, accessToken: session.accessToken, expiresAt } : null;
  }

  private schedule(generation: number, delayOverride?: number): void {
    const session = this.current();
    if (session === null) {
      return;
    }
    const due = session.expiresAt - this.leadMs;
    const delay = delayOverride ?? Math.max(0, due - this.now());
    this.at(generation, delay, () => {
      // 长令牌分段等：到点前醒来时只重新排期。
      const latest = this.current();
      if (latest === null) return;
      if (delayOverride === undefined && latest.expiresAt - this.leadMs > this.now()) {
        this.schedule(generation);
        return;
      }
      void this.refresh(generation, latest);
    });
  }

  private at(generation: number, delay: number, run: () => void): void {
    if (generation !== this.generation) return;
    this.clear();
    const wait = Math.min(delay, MAX_TIMER_MS);
    this.nextRefreshAt = this.now() + wait;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRefreshAt = null;
      if (generation === this.generation) run();
    }, wait);
    this.timer.unref();
  }

  private async refresh(
    generation: number,
    session: { baseUrl: string; accessToken: string },
  ): Promise<void> {
    try {
      const next = await this.deps.remote.refreshAuth();
      if (generation !== this.generation) return;
      const latest = this.current();
      // 续期期间用户换了地址或重新登录：以用户的新登录为准，丢掉这次结果。
      if (latest === null || latest.baseUrl !== session.baseUrl || latest.accessToken !== session.accessToken) {
        this.log({ event: "suduo.auth.refresh_discarded" });
        this.schedule(generation);
        return;
      }
      this.deps.credentials.save({
        baseUrl: session.baseUrl,
        accessToken: next.accessToken,
        expiresAt: next.expiresAt,
        user: next.user,
      });
      this.retryMs = this.retryInitialMs;
      this.log({ event: "suduo.auth.refreshed", expiresAt: next.expiresAt });
      this.deps.onRefreshed?.();
      this.schedule(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (isUnauthorized(error)) {
        // 令牌已失效（远程客户端已清掉凭证）：不再重试，等用户重新登录。
        this.log({ event: "suduo.auth.refresh_unauthorized" });
        return;
      }
      const retryIn = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, this.retryMaxMs);
      this.log({ event: "suduo.auth.refresh_failed", message: messageOf(error), retryInMs: retryIn });
      this.schedule(generation, retryIn);
    }
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.info(JSON.stringify(value))))(line);
  }
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.statusCode === 401 || error.code === "AUTH_INVALID" || error.code === "AUTH_REQUIRED")
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
