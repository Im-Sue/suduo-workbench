import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDto,
  AgentHeartbeatRequest,
  RegisterAgentRequest,
} from "@suduo/cloud-contracts";
import { AgentPresence, deviceNameOf, renderAgentState } from "../src/application/agent-presence.js";
import { ApiError } from "../src/application/api-error.js";
import { messagesFor } from "../src/i18n/messages/index.js";

/** 本机 Agent：安装标识、登记、30 秒心跳（browserActive）、共享期间常驻。 */

const directories: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function agentFixture(overrides: Partial<AgentDto> = {}): AgentDto {
  return {
    id: "agent-1",
    kind: "codex",
    owner: { id: "user-dev", displayName: "陈思远" },
    deviceName: "MacBook-Pro",
    label: "陈思远's Codex · MacBook-Pro",
    online: true,
    lastSeenAt: null,
    activeShareCount: 0,
    ...overrides,
  };
}

function createContext() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "suduo-agent-presence-"));
  directories.push(dataDirectory);
  const registrations: RegisterAgentRequest[] = [];
  const heartbeats: AgentHeartbeatRequest[] = [];
  const heartbeatResults: Array<AgentDto | Error> = [];
  let userId: string | null = "user-dev";
  let browserActive = false;
  let retained = 0;
  const registered: AgentDto[] = [];
  const presence = new AgentPresence({
    dataDirectory,
    remote: {
      registerAgent: async (input) => {
        registrations.push(input);
        return agentFixture();
      },
      heartbeatAgent: async (_agentId, input) => {
        heartbeats.push(input);
        const next = heartbeatResults.shift() ?? agentFixture();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    currentUserId: () => userId,
    browserActive: () => browserActive,
    activity: {
      retainStream: () => {
        retained += 1;
        return () => {
          retained -= 1;
        };
      },
    },
    runs: () => ({ activeRun: null, queuedRuns: 2 }),
    onRegistered: (agent) => registered.push(agent),
    hostname: () => "MacBook-Pro.local",
    log: () => undefined,
  });
  return {
    dataDirectory,
    presence,
    /** 返回给界面的状态（说明按中文渲染，与迁移前逐字一致）；英文见 session-i18n-en.test.ts。 */
    state: () => renderAgentState(presence.state(), messagesFor("zh-CN")),
    registrations,
    heartbeats,
    heartbeatResults,
    registered,
    retained: () => retained,
    setBrowserActive: (value: boolean) => {
      browserActive = value;
    },
    setUser: (value: string | null) => {
      userId = value;
    },
  };
}

describe("AgentPresence", () => {
  it("登录后登记（安装标识存 agent-device.json、设备名去掉 .local），立即心跳，之后每 30 秒一次", async () => {
    const context = createContext();
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.registrations).toHaveLength(1);
    const deviceKey = context.registrations[0]!.deviceKey;
    expect(context.registrations[0]).toEqual({ deviceKey, deviceName: "MacBook-Pro", kind: "codex" });
    expect(JSON.parse(readFileSync(join(context.dataDirectory, "agent-device.json"), "utf8"))).toEqual({ deviceKey });
    expect(context.registered.map((agent) => agent.id)).toEqual(["agent-1"]);
    expect(context.heartbeats).toEqual([{ browserActive: false }]);

    context.setBrowserActive(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.heartbeats.at(-1)).toEqual({ browserActive: true });
    expect(context.heartbeats).toHaveLength(2);

    // 重新登记沿用同一个安装标识。
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.registrations[1]!.deviceKey).toBe(deviceKey);

    const state = context.state();
    expect(state).toMatchObject({ status: "ready", message: null, queuedRuns: 2, activeRun: null });
    expect(state.agent?.id).toBe("agent-1");
    context.presence.stop();
  });

  it("开着的共享数 > 0 时持有 retainStream，降到 0 释放", async () => {
    const context = createContext();
    context.heartbeatResults.push(agentFixture({ activeShareCount: 2 }));
    context.heartbeatResults.push(agentFixture({ activeShareCount: 1 }));
    context.heartbeatResults.push(agentFixture({ activeShareCount: 0 }));
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.retained()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.retained()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.retained()).toBe(0);
    context.presence.stop();
  });

  it("心跳 401：回到未登记、释放常驻、不再心跳；心跳其他失败标 unavailable 并继续", async () => {
    const context = createContext();
    context.heartbeatResults.push(agentFixture({ activeShareCount: 1 }));
    context.heartbeatResults.push(new ApiError(503, "DEPENDENCY_UNAVAILABLE", "远程需求服务暂时不可用"));
    context.heartbeatResults.push(new ApiError(401, "AUTH_INVALID", "登录凭证无效或已过期，请重新登录"));
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.state()).toMatchObject({ status: "unavailable" });
    expect(context.state().message).toContain("心跳失败");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.state()).toMatchObject({ status: "unregistered", agent: null });
    expect(context.retained()).toBe(0);
    const count = context.heartbeats.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(context.heartbeats).toHaveLength(count);
  });

  it("没登录不登记；nudge 在有 Agent 时立即心跳", async () => {
    const context = createContext();
    context.setUser(null);
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.registrations).toHaveLength(0);
    expect(context.state()).toMatchObject({ status: "unregistered", message: "还没有登录需求服务" });

    context.setUser("user-dev");
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.heartbeats).toHaveLength(1);
    context.setBrowserActive(true);
    context.presence.nudge();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.heartbeats).toEqual([{ browserActive: false }, { browserActive: true }]);
    context.presence.stop();
  });

  it("设备名", () => {
    expect(deviceNameOf("Sue-MBP.local")).toBe("Sue-MBP");
    // 设备名会上报给需求服务、给别人看：兜底与语言无关。
    expect(deviceNameOf("  ")).toBe("localhost");
  });
});
