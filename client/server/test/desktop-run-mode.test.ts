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

describe("EventRepository.countRunningSessionsSince", () => {
  function createLedger() {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
    const sessions = new SessionRepository(database);
    const events = new EventRepository(database);
    let ordinal = 0;
    const session = () => sessions.create({ projectId: project.id, title: "s", state: "active" }).id;
    const append = (
      sessionId: string,
      type: string,
      turn: { threadId: string; turnId: string },
      createdAt: number,
      payload: JsonValue = {},
    ) => {
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
        createdAt,
      });
    };
    return { database, events, session, append };
  }

  it("只数本次启动以来开始、至今没结束的回合所在的会话；同一会话多个回合只算一次", () => {
    const { database, events, session, append } = createLedger();
    const since = 1_000;
    const running = session();
    append(running, "turn.started", { threadId: "t1", turnId: "u1" }, since + 1);
    append(running, "turn.started", { threadId: "t2", turnId: "u2" }, since + 2);

    const finished = session();
    append(finished, "turn.started", { threadId: "t3", turnId: "u3" }, since + 3);
    append(finished, "turn.completed", { threadId: "t3", turnId: "u3" }, since + 4);

    const interrupted = session();
    append(interrupted, "turn.started", { threadId: "t4", turnId: "u4" }, since + 5);
    append(interrupted, "turn.interrupted", { threadId: "t4", turnId: "u4" }, since + 6);

    const failed = session();
    append(failed, "turn.started", { threadId: "t5", turnId: "u5" }, since + 7);
    append(failed, "turn.start-failed", { threadId: "t5", turnId: "u5" }, since + 8);

    // 上次异常退出时没写完的回合：停在 turn.started，但不是本次启动以来的，不能算。
    const stale = session();
    append(stale, "turn.started", { threadId: "t6", turnId: "u6" }, since - 1);

    expect(events.countRunningSessionsSince(since)).toBe(1);
    database.close();
  });

  it("同一回合重新开始后又结束，按最后一条判断", () => {
    const { database, events, session, append } = createLedger();
    const id = session();
    const turn = { threadId: "t1", turnId: "u1" };
    append(id, "turn.started", turn, 10);
    append(id, "turn.completed", turn, 11);
    expect(events.countRunningSessionsSince(0)).toBe(0);
    append(id, "turn.started", { threadId: "t1", turnId: "u2" }, 12);
    expect(events.countRunningSessionsSince(0)).toBe(1);
    database.close();
  });
});
