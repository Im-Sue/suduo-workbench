import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { projectEvents } from "../src/event-projection/reducer.js";
import { describeCodexError, describePermissions, localizeNotice } from "../src/event-projection/shared.js";
import { duplicateNotice, suDuoToolConfirmationTitle } from "../src/event-projection/suduo-tools.js";
import type { TimelineEntry, TimelineStep, TurnTimeline } from "../src/event-projection/timeline.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";

let seq = 0;

function ev(type: string, payload: JsonValue, turnId: string | null = "turn-1"): EventEnvelope<string, JsonValue> {
  seq += 1;
  return {
    schemaVersion: 1,
    seq,
    eventId: `evt-${String(seq)}`,
    sessionId: "s1",
    source: "codex",
    type,
    payload,
    threadRef: null,
    turnRef: turnId === null ? null : { threadId: "t1", turnId },
    ts: 1_000 * seq,
  };
}

const item = (phase: "started" | "completed", value: Record<string, JsonValue>) => ev(`item.${phase}`, { item: value });

/** 固定的一段会话：命令、查看文件、思考、命令审批、SuDuo 工具、可重试的错误。 */
function sampleEvents(): EventEnvelope<string, JsonValue>[] {
  seq = 0;
  return [
    ev("turn.started", { turn: { id: "turn-1" } }),
    item("completed", { id: "r-1", type: "reasoning", summary: ["**Plan dependencies**\n\nStart from the entry file"], content: [] }),
    item("completed", { id: "c-1", type: "commandExecution", command: "cat src/app.ts", status: "completed", commandActions: [{ type: "read", command: "cat src/app.ts", name: "app.ts", path: "/p/src/app.ts" }] }),
    item("completed", { id: "c-2", type: "commandExecution", command: "pnpm test", status: "completed", exitCode: 0, commandActions: [{ type: "unknown", command: "pnpm test" }] }),
    ev("approval.requested", { kind: "command", approvalRef: "ap-1", request: { command: "rm -rf dist", cwd: "/p" } }),
    ev("approval.resolved", { decision: "accept", approvalRef: "ap-1" }),
    item("completed", { id: "tool-1", type: "dynamicToolCall", tool: "suduo_artifact_fetch", arguments: { number: 12, version: 2 }, status: "completed", contentItems: [{ type: "inputImage", imageUrl: "x" }], success: true }),
    item("started", { id: "c-3", type: "commandExecution", command: "pnpm build", status: "inProgress", commandActions: [] }),
    ev("runtime.error", { error: { message: "stream disconnected" }, willRetry: true }),
  ];
}

function onlyTurn(timeline: TimelineEntry[]): TurnTimeline {
  const turns = timeline.filter((entry) => entry.kind === "turn");
  expect(turns).toHaveLength(1);
  const [entry] = turns;
  if (entry?.kind !== "turn") throw new Error("no turn");
  return entry.turn;
}

const stepsOf = (turn: TurnTimeline): TimelineStep[] =>
  turn.blocks.flatMap((block) => (block.kind === "steps" ? block.steps : []));

afterEach(() => {
  applyLocalePreference("system");
});

describe("时间线投影 · 英文", () => {
  it("步骤标题、审批、SuDuo 工具与重试提示按当前语言出英文；切回中文后重新投影即是中文", () => {
    applyLocalePreference("en");
    const projection = projectEvents(sampleEvents());
    const turn = onlyTurn(projection.timeline);
    expect(stepsOf(turn).map((step) => step.title)).toEqual([
      "Thinking: Plan dependencies",
      "Read app.ts",
      "Run pnpm test",
      "Approved: Run rm -rf dist",
      "Fetch confirmed version",
      "Run pnpm build",
    ]);
    expect(stepsOf(turn)[4]).toMatchObject({ detail: "REQ-12 · v2", output: "(image)" });
    expect(turn.error).toEqual({ message: "stream disconnected. Retrying…", retrying: true });
    // 过程卡（reducer 的 TurnGroup）同样跟着语言。
    expect(projection.turns[0]?.steps.map((step) => step.title)).toContain("Run command");

    applyLocalePreference("system");
    const chinese = onlyTurn(projectEvents(sampleEvents()).timeline);
    expect(stepsOf(chinese).map((step) => step.title)).toContain("运行 pnpm test");
    expect(chinese.error?.message).toBe("stream disconnected，正在自动重试…");
  });

  it("审批等待中、文件数与回合失败原因", () => {
    applyLocalePreference("en");
    seq = 0;
    const waiting = projectEvents([
      ev("turn.started", { turn: { id: "turn-1" } }),
      ev("approval.requested", { kind: "file-change", approvalRef: "ap-2", request: { changes: { "a.ts": {}, "b.ts": {} } } }),
    ]);
    expect(stepsOf(onlyTurn(waiting.timeline))[0]?.title).toBe("Waiting for you: Edit 2 files");

    seq = 0;
    const failed = projectEvents([
      ev("turn.started", { turn: { id: "turn-1" } }),
      ev("turn.completed", { turn: { id: "turn-1", status: "failed", error: { message: "401 Unauthorized" } } }),
    ]);
    expect(onlyTurn(failed.timeline).error?.message).toMatch(/^Model service authentication failed \(401\)\./);
    expect(describeCodexError({ message: "Reconnecting... 2/5", codexErrorInfo: { other: { httpStatusCode: 401 } } })).toBe(
      "Model service authentication failed (401). Reconnecting (2/5)…",
    );
  });

  it("权限范围、Codex 提示与确认卡的说法", () => {
    applyLocalePreference("en");
    expect(describePermissions({ fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/work/out" } }] }, network: { enabled: true } })).toBe(
      "Write /work/out\nNetwork access",
    );
    expect(
      localizeNotice(
        ["Codex is ignoring 1 unrecognized configuration setting.", "user (/x/config.toml): `foo` is ignored."].join("\n"),
      ),
    ).toBe(
      "Codex ignored 1 unrecognized config setting (possibly a typo, or no longer supported): foo. Nothing else is affected. Fix or remove it in your Codex config to clear this notice.",
    );
    const confirmation = {
      tool: "artifact_publish" as const,
      requirement: { id: "r1", projectId: "p1", number: 1, title: "Order details" },
      publish: { files: [], note: null },
      duplicateOf: null,
    };
    expect(suDuoToolConfirmationTitle(confirmation)).toBe("Publish confirmed version to REQ-1 “Order details”");
    expect(duplicateNotice(confirmation)).toBeNull();
    // 调用方也可以直接传字典，不依赖当前语言。
    applyLocalePreference("system");
    expect(suDuoToolConfirmationTitle(confirmation, messagesFor("en"))).toBe("Publish confirmed version to REQ-1 “Order details”");
    expect(suDuoToolConfirmationTitle(confirmation)).toBe("发布确认版到 REQ-1「Order details」");
  });
});
