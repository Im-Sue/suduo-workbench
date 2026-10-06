import { afterEach, describe, expect, it } from "vitest";
import {
  parseRunMode,
  type AgentRuntime,
  type ApproveResult,
  type HealthzResponse,
  type JsonValue,
  type RuntimeEventDraft,
  type StartThreadResult,
  type StartTurnResult,
  type SystemActivityResponse,
} from "@suduo/client-contracts";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import { checkNodeVersion } from "../src/infrastructure/doctor/doctor-service.js";
import { runtimeEnvironment } from "../src/server-application.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * 客户端桌面应用 D0：本机服务的运行形态（/healthz 的 runMode 与实例标识）和退出前确认用的活动查询。
 * 技术设计：docs/03_开发计划/客户端桌面应用-技术设计.md §4.1、§4.2、§7.1。
 */

const HOST = "127.0.0.1:8790";

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    throw new Error("not used");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("not used");
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {
    return undefined;
  }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}

const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

function setup(overrides: Parameters<typeof createMinimalHttpContext>[1] = {}) {
  const context = createMinimalHttpContext(new IdleRuntime(), overrides);
  contexts.push(context);
  const get = (url: string) => context.server.inject({ method: "GET", url, headers: { host: HOST } });
  return { ...context, get };
}

describe("运行形态", () => {
  it("SUDUO_RUN_MODE 只认 desktop，没设、空串或写错都按源码运行处理", () => {
    expect(parseRunMode("desktop")).toBe("desktop");
    expect(parseRunMode(undefined)).toBe("source");
    expect(parseRunMode("")).toBe("source");
    expect(parseRunMode("Desktop")).toBe("source");
    expect(parseRunMode("installed")).toBe("source");
  });

  it("/healthz 默认带 runMode=source，没有实例标识", async () => {
    const { get } = setup();
    const response = await get("/healthz");
    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthzResponse;
    expect(body).toMatchObject({ product: "suduo", status: "ok", runMode: "source" });
    expect(body).not.toHaveProperty("instanceId");
  });

  it("桌面外壳拉起的服务在 /healthz 里带出 runMode=desktop 与实例标识", async () => {
    const { get } = setup({ runMode: "desktop", instanceId: "desktop-1234" });
    const body = (await get("/healthz")).json() as HealthzResponse;
    expect(body.runMode).toBe("desktop");
    expect(body.instanceId).toBe("desktop-1234");
  });
});

describe("GET /api/v1/system/activity", () => {
  it("返回进行中的会话数，不缓存", async () => {
    const { get } = setup({ systemActivity: { runningSessions: () => 2 } });
    const response = await get("/api/v1/system/activity");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ runningSessions: 2 } satisfies SystemActivityResponse);
  });

  it("没有接上活动来源时按「没有进行中的会话」回答", async () => {
    const { get } = setup();
    expect((await get("/api/v1/system/activity")).json()).toEqual({ runningSessions: 0 });
  });
});

describe("EventRepository.countRunningSessionsAfter", () => {
  function createLedger() {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
    const sessions = new SessionRepository(database);
    const events = new EventRepository(database);
    let ordinal = 0;
    const session = () => sessions.create({ projectId: project.id, title: "s", state: "active" }).id;
    const append = (sessionId: string, type: string, turn: { threadId: string; turnId: string }, payload: JsonValue = {}) => {
      ordinal += 1;
      events.append({
        sessionId,
        source: "runtime:codex-local",
        type,
        payload,
        threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: turn.threadId },
        turnRef: turn,
        ts: ordinal,
        dedupeKey: "c:" + String(ordinal),
      });
    };
    return { database, events, session, append };
  }

  it("只数本次启动以来开始、至今没结束的回合所在的会话；同一会话多个回合只算一次", () => {
    const { database, events, session, append } = createLedger();
    // 上次异常退出时没写完的回合：停在 turn.started，但在启动序号之前，不能算。
    const stale = session();
    append(stale, "turn.started", { threadId: "t6", turnId: "u6" });
    const startupSeq = events.lastSeq();
    expect(startupSeq).toBeGreaterThan(0);

    const running = session();
    append(running, "turn.started", { threadId: "t1", turnId: "u1" });
    append(running, "turn.started", { threadId: "t2", turnId: "u2" });

    const finished = session();
    append(finished, "turn.started", { threadId: "t3", turnId: "u3" });
    append(finished, "turn.completed", { threadId: "t3", turnId: "u3" });

    const interrupted = session();
    append(interrupted, "turn.started", { threadId: "t4", turnId: "u4" });
    append(interrupted, "turn.interrupted", { threadId: "t4", turnId: "u4" });

    const failed = session();
    append(failed, "turn.started", { threadId: "t5", turnId: "u5" });
    append(failed, "turn.start-failed", { threadId: "t5", turnId: "u5" });

    expect(events.countRunningSessionsAfter(startupSeq)).toBe(1);
    database.close();
  });

  it("同一回合结束后按最后一条判断；空账本的启动序号为 0", () => {
    const { database, events, session, append } = createLedger();
    expect(events.lastSeq()).toBe(0);
    const id = session();
    append(id, "turn.started", { threadId: "t1", turnId: "u1" });
    append(id, "turn.completed", { threadId: "t1", turnId: "u1" });
    expect(events.countRunningSessionsAfter(0)).toBe(0);
    append(id, "turn.started", { threadId: "t1", turnId: "u2" });
    expect(events.countRunningSessionsAfter(0)).toBe(1);
    database.close();
  });
});

describe("交给 Codex 的环境", () => {
  it("本机服务自己的 SUDUO_* 不漏给 Codex 和它在项目里执行的命令，只留命令行语言", () => {
    const env = runtimeEnvironment("/home/u/.codex", {
      PATH: "/usr/bin",
      SUDUO_PORT: "8790",
      SUDUO_DATA_DIR: "/d",
      SUDUO_RUN_MODE: "desktop",
      SUDUO_INSTANCE_ID: "i",
      SUDUO_PID_FILE: "/d/suduo.pid",
      SUDUO_CODEX_BIN: "/r/codex",
      SUDUO_LOCALE: "en",
      suduo_lowercase: "x",
    });
    expect(Object.keys(env).filter((key) => /^suduo_/i.test(key))).toEqual(["SUDUO_LOCALE"]);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["CODEX_HOME"]).toBe("/home/u/.codex");
  });
});

describe("自检里的 Node.js 版本", () => {
  const run = (actual: string) => {
    const checks: Parameters<typeof checkNodeVersion>[0] = [];
    checkNodeVersion(checks, messagesFor("zh-CN"), actual, "24.10.0");
    return checks[0];
  };

  it("同一大版本、不低于最低版本即通过（桌面应用捆绑的 24.21.0、源码运行常见的新补丁版本）", () => {
    expect(run("24.10.0")?.status).toBe("pass");
    expect(run("24.21.0")?.status).toBe("pass");
    expect(run("24.10.3")?.status).toBe("pass");
    expect(run("24.21.0")?.message).toBe("24.21.0（要求 24.x、不低于 24.10.0）");
  });

  it("低于最低版本或换了大版本都不通过", () => {
    expect(run("24.9.1")?.status).toBe("fail");
    expect(run("22.20.0")?.status).toBe("fail");
    expect(run("25.0.0")?.status).toBe("fail");
    expect(run("24.9.1")?.message).toBe("需要 24.x、不低于 24.10.0，当前为 24.9.1");
  });
});
