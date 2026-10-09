import { afterEach, describe, expect, it, vi } from "vitest";
import { activityStatusOf, AiActivityReporter } from "../src/application/collab/ai-activity-reporter.js";
import { ApiError } from "../src/application/api-error.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { AiActivitySettingRepository } from "../src/infrastructure/db/repositories/ai-activity-setting-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";

/** 协作记录上报（多 Agent 协作 S11，P2-D1）：只含元数据、默认开、按会话可关（发起的会话往下继承）、同状态不重复、结束状态失败重试、服务器不支持时暂停。 */

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function setup() {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  closers.push(() => database.close());
  const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
  const sessions = new SessionRepository(database);
  const linked = sessions.create({ projectId: project.id, title: "需求会话", state: "active" });
  const local = sessions.create({ projectId: project.id, title: "本机会话", state: "active" });
  const child = sessions.create({
    projectId: project.id,
    title: "接着做",
    state: "active",
    graph: { parentSessionId: linked.id, rootSessionId: linked.id, relation: "continue" },
  });
  const record = vi.fn<(requirementId: string, input: unknown) => Promise<never>>(async () => ({}) as never);
  const supportsActivity = vi.fn(async (): Promise<boolean | null> => true);
  const scheduled: Array<{ run: () => void; ms: number }> = [];
  let clock = Date.parse("2026-10-09T08:00:00.000Z");
  const reporter = new AiActivityReporter({
    requirementOf: (sessionId) => (sessionId === linked.id || sessionId === child.id ? "req-1" : null),
    settings: new AiActivitySettingRepository(database),
    parentOf: (sessionId) => sessions.getById(sessionId)?.parentSessionId ?? null,
    remote: { recordAiActivity: record },
    supportsActivity,
    schedule: (run, ms) => scheduled.push({ run, ms }),
    log: () => undefined,
    now: () => clock,
  });
  return { linked, local, child, record, supportsActivity, scheduled, reporter, advance: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("协作记录上报", () => {
  it("需求会话的事报到需求（带本机发生时间）；同一条同一状态不重复；非需求会话不报；关掉的会话不报", async () => {
    const { linked, local, record, reporter } = setup();
    reporter.report({ sessionId: linked.id, localRef: "d1", kind: "delegate", status: "started", agentId: "claude-code" });
    reporter.report({ sessionId: linked.id, localRef: "d1", kind: "delegate", status: "started", agentId: "claude-code" });
    reporter.report({ sessionId: linked.id, localRef: "d1", kind: "delegate", status: "completed", agentId: "claude-code" });
    reporter.report({ sessionId: local.id, localRef: "d2", kind: "delegate", status: "started", agentId: "codex" });
    // 试做组没有会话：直接给需求。
    reporter.report({ sessionId: null, requirementId: "req-1", localRef: "e1", kind: "trial", status: "started", agentId: "codex", branch: "suduo/REQ-1-codex" });
    expect(record.mock.calls).toEqual([
      ["req-1", { localRef: "d1", agentId: "claude-code", kind: "delegate", status: "started", occurredAt: "2026-10-09T08:00:00.000Z" }],
      ["req-1", { localRef: "d1", agentId: "claude-code", kind: "delegate", status: "completed", occurredAt: "2026-10-09T08:00:00.000Z" }],
      ["req-1", { localRef: "e1", agentId: "codex", kind: "trial", status: "started", branch: "suduo/REQ-1-codex", occurredAt: "2026-10-09T08:00:00.000Z" }],
    ]);
    expect(reporter.isReporting(linked.id)).toBe(true);
    reporter.setReporting(linked.id, false);
    reporter.report({ sessionId: linked.id, localRef: "r1", kind: "review", status: "started", agentId: "codex" });
    expect(record).toHaveBeenCalledTimes(3);
    reporter.setReporting(linked.id, true);
    reporter.report({ sessionId: linked.id, localRef: "r1", kind: "review", status: "started", agentId: "codex" });
    expect(record).toHaveBeenCalledTimes(4);
  });

  it("接着做、委派、评审出来的会话没单独设过时跟着发起的会话；自己设过的为准", () => {
    const { linked, child, record, reporter } = setup();
    reporter.setReporting(linked.id, false);
    expect(reporter.isReporting(child.id)).toBe(false);
    reporter.report({ sessionId: child.id, localRef: child.id, kind: "session", status: "opened", agentId: "codex" });
    expect(record).not.toHaveBeenCalled();
    reporter.setReporting(child.id, true);
    expect(reporter.isReporting(child.id)).toBe(true);
    expect(reporter.isReporting(linked.id)).toBe(false);
    reporter.report({ sessionId: child.id, localRef: child.id, kind: "session", status: "opened", agentId: "codex" });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("404 时问健康检查：服务器没声明这个功能才整体暂停 10 分钟；声明了（需求删了 / 看不到）只丢这一条", async () => {
    const { linked, record, supportsActivity, reporter, advance } = setup();
    record.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "x"));
    reporter.report({ sessionId: linked.id, localRef: "s1", kind: "session", status: "opened", agentId: "codex" });
    await flush();
    await flush();
    reporter.report({ sessionId: linked.id, localRef: "s2", kind: "session", status: "opened", agentId: "codex" });
    expect(record).toHaveBeenCalledTimes(2);
    supportsActivity.mockResolvedValueOnce(false);
    record.mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "x"));
    reporter.report({ sessionId: linked.id, localRef: "s3", kind: "session", status: "opened", agentId: "codex" });
    await flush();
    await flush();
    reporter.report({ sessionId: linked.id, localRef: "s4", kind: "session", status: "opened", agentId: "codex" });
    expect(record).toHaveBeenCalledTimes(3);
    advance(10 * 60_000 + 1);
    reporter.report({ sessionId: linked.id, localRef: "s4", kind: "session", status: "opened", agentId: "codex" });
    expect(record).toHaveBeenCalledTimes(4);
  });

  it("会话的「开始」只有这一条：报失败照样重试", async () => {
    const { linked, record, scheduled, reporter } = setup();
    record.mockRejectedValueOnce(new Error("network"));
    reporter.report({ sessionId: linked.id, localRef: linked.id, kind: "session", status: "opened", agentId: "codex" });
    await flush();
    expect(scheduled.map((item) => item.ms)).toEqual([30_000]);
    scheduled.shift()!.run();
    await flush();
    expect(record).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(0);
  });

  it("结束状态报失败时隔一阵重试（最多三次，带原来的发生时间）；「进行中」不重试；期间报了新状态就不补旧的", async () => {
    const { linked, record, scheduled, reporter, advance } = setup();
    record.mockRejectedValue(new Error("network"));
    reporter.report({ sessionId: linked.id, localRef: "d1", kind: "delegate", status: "started", agentId: "codex" });
    await flush();
    expect(scheduled).toHaveLength(0);
    reporter.report({ sessionId: linked.id, localRef: "d1", kind: "delegate", status: "completed", agentId: "codex" });
    await flush();
    expect(scheduled.map((item) => item.ms)).toEqual([30_000]);
    advance(30_000);
    scheduled.shift()!.run();
    await flush();
    scheduled.shift()!.run();
    await flush();
    scheduled.shift()!.run();
    await flush();
    expect(scheduled).toHaveLength(0);
    expect(record).toHaveBeenCalledTimes(5);
    expect(record.mock.calls.slice(1).map((call) => (call[1] as { occurredAt: string }).occurredAt)).toEqual(Array(4).fill("2026-10-09T08:00:00.000Z"));
    // 用完重试后同一状态可以再报。
    record.mockClear();
    record.mockImplementation(async () => ({}) as never);
    record.mockRejectedValueOnce(new Error("network"));
    reporter.report({ sessionId: linked.id, localRef: "r1", kind: "review", status: "completed", agentId: "codex" });
    await flush();
    reporter.report({ sessionId: linked.id, localRef: "r1", kind: "review", status: "cancelled", agentId: "codex" });
    scheduled.shift()!.run();
    await flush();
    expect(record.mock.calls.map((call) => (call[1] as { status: string }).status)).toEqual(["completed", "cancelled"]);
  });

  it("委派、评审的状态换成协作记录的状态", () => {
    expect(["queued", "running", "completed", "submitted", "unstructured", "cancelled", "failed", "interrupted"].map(activityStatusOf)).toEqual([
      "started",
      "started",
      "completed",
      "completed",
      "completed",
      "cancelled",
      "failed",
      "failed",
    ]);
  });
});
