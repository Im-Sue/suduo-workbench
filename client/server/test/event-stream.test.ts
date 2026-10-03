import { describe, expect, it } from "vitest";
import type { RuntimeEventDraft } from "@suduo/client-contracts";
import { EventBroker } from "../src/application/event-broker.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { SessionEventStream } from "../src/application/event-stream.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";

describe("T6 SSE backlog/live", () => {
  it("highWater 读取期间到达的 live 事件不丢不重", async () => {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    const projects = new ProjectRepository(database);
    const sessions = new SessionRepository(database);
    const project = projects.create({
      name: "sse",
      rootPath: "/tmp/sse",
      rootPathKey: "/tmp/sse",
    });
    const session = sessions.create({
      projectId: project.id,
      title: "sse",
      state: "active",
    });
    const events = new EventRepository(database);
    const approvals = new ApprovalRepository(database);
    const broker = new EventBroker();
    const ledger = new EventLedger(database, events, approvals, broker);
    const first = ledger.append({
      sessionId: session.id,
      sessionThreadId: null,
      event: runtimeEvent("message.delta", "1"),
    });
    let injected = false;
    const repository = new Proxy(events, {
      get(target, property, receiver) {
        if (property !== "maxSeq") {
          return Reflect.get(target, property, receiver);
        }
        return (sessionId: string) => {
          const highWater = target.maxSeq(sessionId);
          if (!injected) {
            injected = true;
            ledger.append({
              sessionId: session.id,
              sessionThreadId: null,
              event: runtimeEvent("message.delta", "2"),
            });
          }
          return highWater;
        };
      },
    });
    const stream = new SessionEventStream(repository, broker, 1);
    const abort = new AbortController();
    const iterator = stream.open({
      sessionId: session.id,
      after: 0,
      signal: abort.signal,
    })[Symbol.asyncIterator]();
    try {
      // 回放 → stream.live 控制帧 → 排空回放期间到达的 live（不丢不重）→ 直通。
      const one = await iterator.next();
      const live = await iterator.next();
      const two = await iterator.next();
      expect(one.value).toMatchObject({ kind: "event", event: { seq: first.seq } });
      expect(live.value).toEqual({ kind: "control", type: "stream.live" });
      expect(two.value).toMatchObject({ kind: "event", event: { seq: first.seq + 1 } });
      abort.abort();
      expect((await iterator.next()).done).toBe(true);
    } finally {
      abort.abort();
      database.close();
    }
  });

  it("stream.live 恰好一次：空账本 / after 已最新 各发一次，abort 后零次", async () => {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    const projects = new ProjectRepository(database);
    const sessions = new SessionRepository(database);
    const project = projects.create({ name: "sse", rootPath: "/tmp/sse2", rootPathKey: "/tmp/sse2" });
    const session = sessions.create({ projectId: project.id, title: "sse", state: "active" });
    const events = new EventRepository(database);
    const approvals = new ApprovalRepository(database);
    const broker = new EventBroker();
    const ledger = new EventLedger(database, events, approvals, broker);
    const stream = new SessionEventStream(events, broker);
    const collect = async (after: number, abortBeforeOpen = false) => {
      const abort = new AbortController();
      if (abortBeforeOpen) abort.abort();
      const iterator = stream.open({ sessionId: session.id, after, signal: abort.signal })[Symbol.asyncIterator]();
      const frames: unknown[] = [];
      // 控制帧之后生成器会等 live 事件；拿到控制帧就 abort 收尾。
      for (;;) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 200)),
        ]);
        if (next.done) break;
        frames.push(next.value);
        if ((next.value as { kind: string }).kind === "control") {
          abort.abort();
        }
      }
      abort.abort();
      return frames;
    };
    try {
      expect(await collect(0)).toEqual([{ kind: "control", type: "stream.live" }]);
      const appended = ledger.append({ sessionId: session.id, sessionThreadId: null, event: runtimeEvent("message.delta", "3") });
      expect(await collect(appended.seq)).toEqual([{ kind: "control", type: "stream.live" }]);
      expect(await collect(0, true)).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function runtimeEvent(type: string, dedupeKey: string): RuntimeEventDraft {
  return {
    source: "runtime:test",
    type,
    payload: { text: dedupeKey },
    threadRef: null,
    turnRef: null,
    ts: Date.now(),
    dedupeKey,
  };
}
