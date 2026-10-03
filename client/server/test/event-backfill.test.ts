import { describe, expect, it } from "vitest";
import {
  BACKFILL_LATEST_ONLY_EVENT_TYPES,
  BACKFILL_OMITTED_EVENT_TYPES,
  type JsonValue,
} from "@suduo/client-contracts";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";

function createContext() {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
  const session = new SessionRepository(database).create({ projectId: project.id, title: "s", state: "active" });
  const events = new EventRepository(database);
  let ordinal = 0;
  const append = (type: string, payload: JsonValue = {}) => {
    ordinal += 1;
    return events.append({
      sessionId: session.id,
      source: "runtime:codex-local",
      type,
      payload,
      threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" },
      turnRef: { threadId: "thread-1", turnId: "turn-1" },
      ts: ordinal,
      dedupeKey: "c:" + String(ordinal),
    }).event;
  };
  return { database, events, sessionId: session.id, append };
}

describe("历史回填过滤（P3a）", () => {
  it("回填常量覆盖所有流式增量，快照类只有 usage.updated", () => {
    expect([...BACKFILL_OMITTED_EVENT_TYPES].sort()).toEqual([
      "command.output-delta",
      "message.delta",
      "plan.delta",
      "reasoning.summary-delta",
      "reasoning.summary-part-added",
      "reasoning.text-delta",
      "tool.progress",
    ]);
    expect([...BACKFILL_LATEST_ONLY_EVENT_TYPES]).toEqual(["usage.updated"]);
  });

  it("过滤增量类事件，usage.updated 只保留区间内最后一条，且分页推进只出现一次", () => {
    const context = createContext();
    try {
      const kept: number[] = [];
      kept.push(context.append("turn.started").seq);
      context.append("reasoning.summary-part-added", { itemId: "rs", summaryIndex: 0 });
      context.append("reasoning.summary-delta", { itemId: "rs", delta: "思考", summaryIndex: 0 });
      context.append("plan.delta", { itemId: "plan", delta: "- a" });
      kept.push(context.append("plan.updated", { explanation: null, plan: [] }).seq);
      context.append("usage.updated", { tokenUsage: { n: 1 } });
      context.append("message.delta", { text: "你", itemId: "m" });
      context.append("tool.progress", { itemId: "mcp", message: "1/2" });
      context.append("command.output-delta", { delta: "ok", itemId: "cmd" });
      context.append("usage.updated", { tokenUsage: { n: 2 } });
      kept.push(context.append("item.completed", { item: { type: "reasoning", id: "rs", summary: ["思考"], content: [] } }).seq);
      const lastUsage = context.append("usage.updated", { tokenUsage: { n: 3 } }).seq;
      kept.push(lastUsage);
      kept.push(context.append("turn.completed", { turn: { id: "turn-1", status: "completed" } }).seq);

      const all = context.events.listBackfill(context.sessionId, 0, 1_000_000, 500);
      expect(all.map((event) => event.seq)).toEqual(kept);
      expect(all.find((event) => event.type === "usage.updated")?.payload).toEqual({ tokenUsage: { n: 3 } });

      // 前端按 after=上一页末尾 seq、until 不变 翻页：最新快照只出现在覆盖它的那一页。
      const pages: number[][] = [];
      let after = 0;
      for (;;) {
        const page = context.events.listBackfill(context.sessionId, after, 1_000_000, 2);
        if (page.length === 0) break;
        pages.push(page.map((event) => event.seq));
        after = page.at(-1)!.seq;
      }
      expect(pages.flat()).toEqual(kept);

      // 区间截在第二条 usage 之后时，回填给出的是该区间内最新的一条。
      const head = context.events.listBackfill(context.sessionId, 0, lastUsage - 2, 500);
      expect(head.filter((event) => event.type === "usage.updated").map((event) => event.payload)).toEqual([{ tokenUsage: { n: 2 } }]);
    } finally {
      context.database.close();
    }
  });

  it("增量事件照常入账，SSE 重放使用的 listRange 不受回填过滤影响", () => {
    const context = createContext();
    try {
      context.append("reasoning.summary-delta", { itemId: "rs", delta: "a", summaryIndex: 0 });
      context.append("usage.updated", { tokenUsage: { n: 1 } });
      context.append("usage.updated", { tokenUsage: { n: 2 } });
      expect(context.events.listRange(context.sessionId, 0, 1_000_000).map((event) => event.type)).toEqual([
        "reasoning.summary-delta",
        "usage.updated",
        "usage.updated",
      ]);
    } finally {
      context.database.close();
    }
  });
});
