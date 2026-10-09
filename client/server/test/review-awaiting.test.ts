import { afterEach, describe, expect, it } from "vitest";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { ReviewRepository } from "../src/infrastructure/db/repositories/review-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";

/** 「我的工作 · 评审意见待处理」的查询（S12）：条件写在 SQL 里，交回过的、没意见的多也不挤掉待处理的。 */

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

describe("待处理的评审意见", () => {
  it("只列两周内交回了结构化意见、一条都没交回的；前面有 60 条已处理的也不漏", () => {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    closers.push(() => database.close());
    const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
    const target = new SessionRepository(database).create({ projectId: project.id, title: "t", state: "active" });
    const reviews = new ReviewRepository(database);
    const finding = { id: "f1", severity: "high", file: null, line: null, title: "x", detail: "y", suggestion: null } as never;
    const make = (patch: Record<string, unknown>, finishedAt: number) => {
      const record = reviews.create({ targetSessionId: target.id, agentId: "codex", origin: "user", focus: [], note: null, now: finishedAt });
      return reviews.update(record.id, { status: "submitted", findings: [finding], appliedFindingIds: [], finishedAt, ...patch } as never, finishedAt);
    };
    const pending = make({}, 1_000);
    for (let index = 0; index < 60; index += 1) make({ appliedFindingIds: ["f1"] }, 2_000 + index);
    make({ findings: [] }, 3_000);
    make({ status: "unstructured", findings: null }, 3_001);
    make({}, 10);
    expect(reviews.listAwaitingHandback(500).map((record) => record.id)).toEqual([pending.id]);
  });
});
