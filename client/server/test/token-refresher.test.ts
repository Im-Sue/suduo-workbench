import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSessionDto } from "@suduo/cloud-contracts";
import { ApiError } from "../src/application/api-error.js";
import { TokenRefresher } from "../src/application/token-refresher.js";
import type { RequirementsAuthSession } from "../src/infrastructure/requirements-v2/credential-store.js";

/** 登录续期：过期前 1 小时续、启动时不足 1 小时立即续、失败退避重试、401 不再重试。 */

const HOUR = 60 * 60_000;
const BASE_URL = "https://requirements.test";
const USER = { id: "user-dev", displayName: "陈思远", loginName: "dev", createdAt: "2026-09-01T00:00:00.000Z" };

function createContext(initialExpiresInMs: number) {
  let stored: RequirementsAuthSession | null = {
    baseUrl: BASE_URL,
    accessToken: "token-1",
    expiresAt: new Date(Date.now() + initialExpiresInMs).toISOString(),
    user: USER,
  };
  const results: Array<AuthSessionDto | Error> = [];
  const calls: string[] = [];
  let refreshed = 0;
  const refresher = new TokenRefresher({
    settings: { getBaseUrl: () => BASE_URL },
    credentials: {
      getForBaseUrl: (_baseUrl: string, now = Date.now()) =>
        stored !== null && Date.parse(stored.expiresAt) > now ? stored : null,
      save: (session: RequirementsAuthSession) => {
        stored = session;
      },
    },
    remote: {
      refreshAuth: async () => {
        calls.push(stored?.accessToken ?? "none");
        const next = results.shift();
        if (next === undefined) throw new Error("no fixture");
        if (next instanceof Error) {
          if (next instanceof ApiError && next.statusCode === 401) stored = null;
          throw next;
        }
        return next;
      },
    },
    onRefreshed: () => {
      refreshed += 1;
    },
    log: () => undefined,
  });
  return {
    refresher,
    results,
    calls,
    refreshed: () => refreshed,
    stored: () => stored,
    replaceToken: (token: string) => {
      stored = stored === null ? null : { ...stored, accessToken: token };
    },
  };
}

function session(token: string, expiresInMs: number): AuthSessionDto {
  return {
    accessToken: token,
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    user: USER,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-01T08:00:00.000Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TokenRefresher", () => {
  it("过期前 1 小时续期，保存新令牌并通知上游重连，再按新到期时间排期", async () => {
    const context = createContext(8 * HOUR);
    // 新令牌在续期时刻之后 8 小时到期。
    context.results.push(session("token-2", 15 * HOUR));
    context.refresher.reschedule();
    expect(context.refresher.nextRefreshAt).toBe(Date.now() + 7 * HOUR);

    await vi.advanceTimersByTimeAsync(7 * HOUR - 1_000);
    expect(context.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.calls).toEqual(["token-1"]);
    expect(context.stored()?.accessToken).toBe("token-2");
    expect(context.refreshed()).toBe(1);
    expect(context.refresher.nextRefreshAt).toBe(Date.now() + 7 * HOUR);
    context.refresher.stop();
  });

  it("启动时剩余不足 1 小时立即续", async () => {
    const context = createContext(30 * 60_000);
    context.results.push(session("token-2", 8 * HOUR));
    context.refresher.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.calls).toEqual(["token-1"]);
    expect(context.stored()?.accessToken).toBe("token-2");
    context.refresher.stop();
  });

  it("失败按退避重试（30 秒、60 秒……），成功后恢复正常排期", async () => {
    const context = createContext(30 * 60_000);
    context.results.push(new ApiError(503, "DEPENDENCY_UNAVAILABLE", "远程需求服务暂时不可用"));
    context.results.push(new Error("network"));
    context.results.push(session("token-2", 8 * HOUR));
    context.refresher.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(context.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(context.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.calls).toHaveLength(3);
    expect(context.stored()?.accessToken).toBe("token-2");
    context.refresher.stop();
  });

  it("401：令牌已失效，不再重试，等用户重新登录", async () => {
    const context = createContext(30 * 60_000);
    context.results.push(new ApiError(401, "AUTH_INVALID", "登录凭证无效或已过期，请重新登录"));
    context.refresher.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(context.calls).toHaveLength(1);
    expect(context.refresher.nextRefreshAt).toBeNull();
  });

  it("续期期间用户重新登录：丢掉这次结果，以用户的新登录为准", async () => {
    const context = createContext(30 * 60_000);
    let release: (value: AuthSessionDto) => void = () => undefined;
    const pending = new Promise<AuthSessionDto>((resolve) => {
      release = resolve;
    });
    const refresher = new TokenRefresher({
      settings: { getBaseUrl: () => BASE_URL },
      credentials: {
        getForBaseUrl: () => context.stored(),
        save: () => {
          throw new Error("should not save");
        },
      },
      remote: { refreshAuth: () => pending },
      log: () => undefined,
    });
    refresher.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    context.replaceToken("token-from-new-login");
    release(session("token-2", 8 * HOUR));
    await vi.advanceTimersByTimeAsync(0);
    expect(context.stored()?.accessToken).toBe("token-from-new-login");
    refresher.stop();
  });

  it("没登录不排期", () => {
    const refresher = new TokenRefresher({
      settings: { getBaseUrl: () => BASE_URL },
      credentials: { getForBaseUrl: () => null, save: () => undefined },
      remote: { refreshAuth: async () => session("x", HOUR) },
      log: () => undefined,
    });
    refresher.reschedule();
    expect(refresher.nextRefreshAt).toBeNull();
  });
});
