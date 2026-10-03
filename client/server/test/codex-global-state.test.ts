import { describe, expect, it } from "vitest";
import type { RuntimeEventDraft } from "@suduo/client-contracts";
import { CodexGlobalState } from "../src/application/codex-global-state.js";
import { EventBroker } from "../src/application/event-broker.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { RuntimeEventIngestor } from "../src/application/runtime-event-ingestor.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import {
  codexNativeType,
  normalizeCodexNotification,
} from "../src/infrastructure/runtime/codex/codex-event-normalizer.js";

describe("D7 Codex 全局状态投影", () => {
  it("暴露原生通知名并将白名单内的无关联事件投影", () => {
    const normalized = normalizeCodexNotification({
      runtimeId: "codex-local",
      connectionId: "connection-1",
      ordinal: 1,
      message: {
        kind: "notification",
        method: "configWarning",
        params: { summary: "check config" },
      },
    });
    expect(codexNativeType(normalized)).toBe("configWarning");

    const context = createContext();
    try {
      expect(() => context.ingestor.ingest(normalized)).not.toThrow();
      expect(context.state.snapshot()).toMatchObject({
        version: 1,
        entries: [{ nativeType: "configWarning", payload: { summary: "check config" } }],
      });
    } finally {
      context.database.close();
    }
  });

  it("未知无关联事件仍然抛错，不能被全局投影吞掉", () => {
    const context = createContext();
    try {
      expect(() => context.ingestor.ingest(runtimeEvent("not/known"))).toThrow(
        "runtime event cannot be associated with a suduo session",
      );
      expect(context.state.snapshot()).toEqual({
        version: 0,
        updatedAt: null,
        entries: [],
      });
    } finally {
      context.database.close();
    }
  });

  it("用量额度通知与会话无关、也不进全局投影：安静丢弃，不报错", () => {
    const context = createContext();
    try {
      expect(() => context.ingestor.ingest(runtimeEvent("account/rateLimits/updated"))).not.toThrow();
      expect(context.state.snapshot().entries).toEqual([]);
    } finally {
      context.database.close();
    }
  });

  it("带 threadRef 或 sessionHint 的已知通知不走全局投影", () => {
    const context = createContext();
    try {
      expect(() =>
        context.ingestor.ingest({
          ...runtimeEvent("configWarning"),
          threadRef: {
            runtimeId: "codex-local",
            runtimeKind: "codex",
            threadId: "unbound-thread",
          },
        }),
      ).toThrow("runtime event cannot be associated with a suduo session");
      expect(() =>
        context.ingestor.ingest({
          ...runtimeEvent("configWarning"),
          sessionHint: context.sessionId,
        }),
      ).not.toThrow();
      expect(context.state.snapshot().entries).toEqual([]);
    } finally {
      context.database.close();
    }
  });
});

function createContext() {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const project = projects.create({
    name: "global-state",
    rootPath: "/tmp/global-state",
    rootPathKey: "/tmp/global-state",
  });
  const session = sessions.create({
    projectId: project.id,
    title: "global-state",
    state: "active",
  });
  const state = new CodexGlobalState();
  return {
    database,
    state,
    sessionId: session.id,
    ingestor: new RuntimeEventIngestor(
      new SessionThreadRepository(database),
      new EventLedger(database, events, approvals, new EventBroker()),
      state,
    ),
  };
}

function runtimeEvent(nativeType: string): RuntimeEventDraft {
  return {
    source: "runtime:codex-local",
    type: "runtime.unknown",
    payload: { extensions: { codex: { nativeType } } },
    threadRef: null,
    turnRef: null,
    ts: 1_700_000_000_000,
  };
}
