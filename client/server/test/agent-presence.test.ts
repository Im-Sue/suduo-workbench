import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function extraAgent(kind: string, overrides: Partial<AgentDto> = {}): AgentDto {
  return agentFixture({ id: "agent-" + kind, kind, label: `陈思远's ${kind} · MacBook-Pro`, ...overrides });
}

function createContext() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "suduo-agent-presence-"));
  directories.push(dataDirectory);
  const registrations: RegisterAgentRequest[] = [];
  const heartbeats: AgentHeartbeatRequest[] = [];
  const heartbeatResults: Array<AgentDto | Error> = [];
  /** Codex 以外各家的心跳结果（按云端 Agent id；没给就原样回登记时的 Agent）。 */
  const extraHeartbeats = new Map<string, Array<AgentDto | Error | Promise<AgentDto>>>();
  const extraHeartbeatIds: string[] = [];
  let userId: string | null = "user-dev";
  let server: string | null = "http://cloud.test";
  /** 能在讨论里执行的种类（配置表 + 设置）；其余登记时拒、已登记的停止心跳。 */
  const shareable = new Set(["claude-code", "opencode"]);
  /** 云端不认的种类（老云端）：登记回 400。 */
  const cloudRejects = new Set<string>();
  let browserActive = false;
  let retained = 0;
  const registered: AgentDto[] = [];
  const presence = new AgentPresence({
    dataDirectory,
    remote: {
      registerAgent: async (input) => {
        registrations.push(input);
        const kind = input.kind ?? "codex";
        if (cloudRejects.has(kind)) throw new ApiError(400, "VALIDATION_ERROR", "kind must match pattern");
        return kind === "codex" ? agentFixture() : extraAgent(kind);
      },
      heartbeatAgent: async (agentId, input) => {
        if (agentId !== "agent-1") {
          extraHeartbeatIds.push(agentId);
          const next = extraHeartbeats.get(agentId)?.shift() ?? extraAgent(agentId.replace(/^agent-/u, ""));
          if (next instanceof Error) throw next;
          return await next;
        }
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
    serverKey: () => server,
    kindProblem: (kind) => (kind === "codex" || shareable.has(kind) ? null : `${kind} can't run read-only`),
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
    extraHeartbeats,
    extraHeartbeatIds,
    registered,
    retained: () => retained,
    setBrowserActive: (value: boolean) => {
      browserActive = value;
    },
    setUser: (value: string | null) => {
      userId = value;
    },
    setServer: (value: string | null) => {
      server = value;
    },
    shareable,
    cloudRejects,
    deviceFile: () => JSON.parse(readFileSync(join(dataDirectory, "agent-device.json"), "utf8")) as Record<string, unknown>,
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

  it("共享 Codex 以外的一家（多 Agent S6）：立刻登记、记进设备文件；重启后照样登记、一起心跳；任一家有共享就常驻", async () => {
    const context = createContext();
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    const deviceKey = context.registrations[0]!.deviceKey;

    const claude = await context.presence.addKind("claude-code");
    expect(claude.id).toBe("agent-claude-code");
    expect(context.registrations.at(-1)).toEqual({ deviceKey, deviceName: "MacBook-Pro", kind: "claude-code" });
    // 按服务器分开记（在这台服务器共享的，换到别的服务器不自动登记）。
    expect(context.deviceFile()).toEqual({ deviceKey, kindsByServer: { "http://cloud.test": ["claude-code"] } });
    // 已登记的再共享一次不重复登记；Codex 直接给已登记的那个。
    const count = context.registrations.length;
    expect((await context.presence.addKind("claude-code")).id).toBe("agent-claude-code");
    expect((await context.presence.addKind("codex")).id).toBe("agent-1");
    expect(context.registrations).toHaveLength(count);
    expect(context.presence.currentAgents().map((agent) => agent.id)).toEqual(["agent-1", "agent-claude-code"]);
    expect(context.presence.agentById("agent-claude-code")?.kind).toBe("claude-code");
    expect(context.state().agents?.map((agent) => agent.kind)).toEqual(["codex", "claude-code"]);

    // 只有 Claude Code 有开着的共享：照样常驻。
    context.extraHeartbeats.set("agent-claude-code", [extraAgent("claude-code", { activeShareCount: 1 })]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.extraHeartbeatIds).toContain("agent-claude-code");
    expect(context.retained()).toBe(1);

    // 重启（重新登录）：按设备文件把 Claude Code 也登记上。
    context.presence.restart();
    expect(context.presence.currentAgents()).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.registrations.slice(-2).map((input) => input.kind)).toEqual(["codex", "claude-code"]);
    expect(context.presence.currentAgents().map((agent) => agent.id)).toEqual(["agent-1", "agent-claude-code"]);
    context.presence.stop();
  });

  it("其他家心跳 404（远程没有了）：下次重新登记；登记失败不影响 Codex", async () => {
    const context = createContext();
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    await context.presence.addKind("opencode");
    context.extraHeartbeats.set("agent-opencode", [new ApiError(404, "NOT_FOUND", "not found")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.presence.agentById("agent-opencode")).toBeNull();
    expect(context.state()).toMatchObject({ status: "ready" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.registrations.filter((input) => input.kind === "opencode")).toHaveLength(2);
    expect(context.presence.agentById("agent-opencode")).not.toBeNull();
    context.presence.stop();
  });

  it("只读红线：做不到只读 / 停用了的种类不登记；已登记的改成不能执行后停止心跳；设备文件里手写的种类也不登记", async () => {
    const context = createContext();
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    await expect(context.presence.addKind("cursor")).rejects.toMatchObject({ statusCode: 400 });
    expect(context.registrations.some((input) => input.kind === "cursor")).toBe(false);

    await context.presence.addKind("claude-code");
    const deviceKey = context.registrations[0]!.deviceKey;
    // 手改设备文件加一家做不到只读的：照样不登记。
    writeFileSync(
      join(context.dataDirectory, "agent-device.json"),
      JSON.stringify({ deviceKey, kindsByServer: { "http://cloud.test": ["claude-code", "gemini"] } }),
    );
    // 在设置里停用了 Claude Code：下次心跳起不再登记、不再心跳（云端随后标成离线）。
    context.shareable.delete("claude-code");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.presence.currentAgents().map((agent) => agent.kind)).toEqual(["codex"]);
    expect(context.registrations.some((input) => input.kind === "gemini")).toBe(false);
    const beats = context.extraHeartbeatIds.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.extraHeartbeatIds).toHaveLength(beats);
    context.presence.stop();
  });

  it("共享过的其他家按服务器分开：换到另一台服务器不自动登记，换回来照样登记；老云端不认的种类本代不再重试", async () => {
    const context = createContext();
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    await context.presence.addKind("claude-code");

    context.setServer("https://other.example");
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.presence.currentAgents().map((agent) => agent.kind)).toEqual(["codex"]);

    context.setServer("http://cloud.test");
    context.cloudRejects.add("claude-code");
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    const attempts = () => context.registrations.filter((input) => input.kind === "claude-code").length;
    const before = attempts();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(attempts()).toBe(before);
    expect(context.state()).toMatchObject({ status: "ready" });

    // 云端升级后重新登录（restart）再试。
    context.cloudRejects.clear();
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.presence.currentAgents().map((agent) => agent.kind)).toEqual(["codex", "claude-code"]);
    context.presence.stop();
  });

  it("去掉一家：从设备文件删掉、停止心跳；Codex 不能去掉；晚登记上的一家让接收器马上对账", async () => {
    const context = createContext();
    context.presence.restart();
    await vi.advanceTimersByTimeAsync(0);
    await context.presence.addKind("claude-code");
    context.presence.removeKind("claude-code");
    expect(context.presence.currentAgents().map((agent) => agent.kind)).toEqual(["codex"]);
    expect(context.deviceFile()["kindsByServer"]).toEqual({ "http://cloud.test": [] });
    expect(() => context.presence.removeKind("codex")).toThrow(ApiError);

    // 心跳还在路上时去掉：心跳回来不把它加回来。
    await context.presence.addKind("claude-code");
    let release: (agent: AgentDto) => void = () => undefined;
    context.extraHeartbeats.set("agent-claude-code", [new Promise<AgentDto>((resolve) => (release = resolve))]);
    await vi.advanceTimersByTimeAsync(30_000);
    context.presence.removeKind("claude-code");
    release(extraAgent("claude-code"));
    await vi.advanceTimersByTimeAsync(0);
    expect(context.presence.agentById("agent-claude-code")).toBeNull();

    // 启动时登记失败、下次心跳才补上：补上时通知接收器。
    context.cloudRejects.add("opencode");
    await expect(context.presence.addKind("opencode")).rejects.toMatchObject({ statusCode: 400 });
    const deviceKey = context.registrations[0]!.deviceKey;
    writeFileSync(join(context.dataDirectory, "agent-device.json"), JSON.stringify({ deviceKey, kindsByServer: { "http://cloud.test": ["opencode"] } }));
    context.cloudRejects.clear();
    const notified = context.registered.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.presence.agentById("agent-opencode")).not.toBeNull();
    expect(context.registered.length).toBe(notified + 1);
    context.presence.stop();
  });

  it("设备名", () => {
    expect(deviceNameOf("Sue-MBP.local")).toBe("Sue-MBP");
    // 设备名会上报给需求服务、给别人看：兜底与语言无关。
    expect(deviceNameOf("  ")).toBe("localhost");
  });
});
