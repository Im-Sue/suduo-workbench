import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { projectEvents } from "../src/event-projection/reducer.js";
import { countDiff, type TimelineEntry, type TurnBlock, type TurnTimeline } from "../src/event-projection/timeline.js";

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

const started = (turnId = "turn-1") => ev("turn.started", { turn: { id: turnId } }, turnId);
const completed = (turnId = "turn-1", status = "completed", error?: string) =>
  ev("turn.completed", { turn: { id: turnId, status, ...(error === undefined ? {} : { error: { message: error } }) } }, turnId);
const delta = (itemId: string, text: string, turnId = "turn-1") => ev("message.delta", { itemId, text }, turnId);
const item = (phase: "started" | "completed", value: Record<string, JsonValue>, turnId = "turn-1") =>
  ev(`item.${phase}`, { item: value }, turnId);
const submitted = (clientTurnId: string, text: string) =>
  ev("message.submitted", { clientTurnId, content: [{ type: "text", text }] }, null);

function onlyTurn(timeline: TimelineEntry[]): TurnTimeline {
  const turns = timeline.filter((entry) => entry.kind === "turn");
  expect(turns).toHaveLength(1);
  const [entry] = turns;
  if (entry?.kind !== "turn") throw new Error("no turn");
  return entry.turn;
}

const shape = (blocks: TurnBlock[]) =>
  blocks.map((block) =>
    block.kind === "text"
      ? `text:${block.text}`
      : block.kind === "steps"
        ? `steps:${block.steps.map((step) => step.title).join("|")}`
        : block.kind === "file-change"
          ? `files:${block.changes.map((change) => change.path).join("|")}`
          : `user:${block.message.text}`,
  );

beforeEach(() => {
  seq = 0;
});

describe("会话时间线 · 多段回复与步骤交错", () => {
  it("同一回合的两段回复按 itemId 分开，与中间的命令按先后交错；旧的消息列表也不再互相覆盖", () => {
    const projection = projectEvents([
      started(),
      delta("msg-a", "先看一下"),
      delta("msg-a", "目录结构。"),
      item("started", { id: "cmd-1", type: "commandExecution", command: "pnpm test", status: "inProgress", commandActions: [{ type: "unknown", command: "pnpm test" }] }),
      ev("command.output-delta", { itemId: "cmd-1", delta: "ok\n" }),
      item("completed", { id: "cmd-1", type: "commandExecution", command: "pnpm test", status: "completed", exitCode: 0, durationMs: 1200, commandActions: [{ type: "unknown", command: "pnpm test" }] }),
      delta("msg-b", "测试都通过了。"),
      item("completed", { id: "msg-a", type: "agentMessage", text: "先看一下目录结构。" }),
      item("completed", { id: "msg-b", type: "agentMessage", text: "测试都通过了。" }),
      completed(),
    ]);
    const turn = onlyTurn(projection.timeline);
    expect(shape(turn.blocks)).toEqual(["text:先看一下目录结构。", "steps:运行 pnpm test", "text:测试都通过了。"]);
    const step = turn.blocks[1]?.kind === "steps" ? turn.blocks[1].steps[0] : undefined;
    expect(step).toMatchObject({ kind: "command", status: "completed", exitCode: 0, durationMs: 1200, output: "ok\n" });
    expect(projection.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
      "先看一下目录结构。",
      "测试都通过了。",
    ]);
    expect(turn.status).toBe("completed");
    expect(turn.summary).toMatchObject({ commands: 1, filesChanged: 0 });
    expect(turn.summary.durationMs).toBeGreaterThan(0);
  });

  it("回填没有增量事件时，item.started 占住位置，文字仍排在命令之前", () => {
    const projection = projectEvents([
      started(),
      item("started", { id: "msg-a", type: "agentMessage", text: "" }),
      item("started", { id: "cmd-1", type: "commandExecution", command: "ls", status: "inProgress", commandActions: [{ type: "listFiles", command: "ls", path: "src" }] }),
      item("completed", { id: "cmd-1", type: "commandExecution", command: "ls", status: "completed", commandActions: [{ type: "listFiles", command: "ls", path: "src" }] }),
      item("completed", { id: "msg-a", type: "agentMessage", text: "我先列一下 src。" }),
      completed(),
    ]);
    expect(shape(onlyTurn(projection.timeline).blocks)).toEqual(["text:我先列一下 src。", "steps:列出 src"]);
  });

  it("相邻的查看 / 搜索 / 思考聚成一个步骤组；命令的解析决定标题", () => {
    const projection = projectEvents([
      started(),
      item("completed", { id: "r-1", type: "reasoning", summary: ["**梳理依赖**\n\n先看入口文件"], content: [] }),
      item("completed", { id: "c-1", type: "commandExecution", command: "cat src/app.ts", status: "completed", commandActions: [{ type: "read", command: "cat src/app.ts", name: "app.ts", path: "/p/src/app.ts" }] }),
      item("completed", { id: "c-2", type: "commandExecution", command: "rg foo", status: "completed", commandActions: [{ type: "search", command: "rg foo", query: "foo", path: null }] }),
      completed(),
    ]);
    const turn = onlyTurn(projection.timeline);
    expect(shape(turn.blocks)).toEqual(["steps:思考：梳理依赖|查看 app.ts|搜索「foo」"]);
    expect(turn.summary.commands).toBe(0);
  });

  it("推理摘要按增量拼出，分段之间空一行", () => {
    const projection = projectEvents([
      started(),
      ev("reasoning.summary-delta", { itemId: "r-1", delta: "**看结构**", summaryIndex: 0 }),
      ev("reasoning.summary-part-added", { itemId: "r-1", summaryIndex: 1 }),
      ev("reasoning.summary-delta", { itemId: "r-1", delta: "再看测试", summaryIndex: 1 }),
    ]);
    const turn = onlyTurn(projection.timeline);
    const step = turn.blocks[0]?.kind === "steps" ? turn.blocks[0].steps[0] : undefined;
    expect(step).toMatchObject({ kind: "thinking", title: "思考：看结构", output: "**看结构**\n\n再看测试", status: "running" });
    expect(turn.status).toBe("running");
    expect(turn.currentStep).toEqual({ kind: "thinking", title: "思考：看结构", detail: "" });
  });
});

describe("会话时间线 · 改动、计划与用量", () => {
  it("文件改动单独成卡，统计增删行数并计入回合摘要", () => {
    const diff = "@@ -1,2 +1,3 @@\n line\n-old\n+new\n+added\n";
    const projection = projectEvents([
      started(),
      item("started", { id: "fc-1", type: "fileChange", status: "inProgress", changes: [] }),
      ev("file.patch-updated", { itemId: "fc-1", changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff }] }),
      item("completed", {
        id: "fc-1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: { type: "update", move_path: null }, diff },
          { path: "src/b.ts", kind: { type: "add" }, diff: "x\ny\n" },
        ],
      }),
      completed(),
    ]);
    const turn = onlyTurn(projection.timeline);
    expect(shape(turn.blocks)).toEqual(["files:src/a.ts|src/b.ts"]);
    expect(turn.summary).toMatchObject({ filesChanged: 2, additions: 4, deletions: 1 });
  });

  it("被拒绝的改动不计入摘要", () => {
    const projection = projectEvents([
      started(),
      item("completed", { id: "fc-1", type: "fileChange", status: "declined", changes: [{ path: "a", kind: { type: "add" }, diff: "x\n" }] }),
      completed(),
    ]);
    expect(onlyTurn(projection.timeline).summary.filesChanged).toBe(0);
  });

  it("计划取最新一版，状态统一成 pending / in_progress / completed", () => {
    const projection = projectEvents([
      started(),
      ev("plan.updated", { explanation: null, plan: [{ step: "读代码", status: "inProgress" }, { step: "改代码", status: "pending" }] }),
      ev("plan.updated", { explanation: "按依赖顺序", plan: [{ step: "读代码", status: "completed" }, { step: "改代码", status: "inProgress" }] }),
    ]);
    expect(onlyTurn(projection.timeline).plan).toEqual({
      explanation: "按依赖顺序",
      steps: [
        { text: "读代码", status: "completed" },
        { text: "改代码", status: "in_progress" },
      ],
    });
  });

  it("上下文用量取最近一次请求的占用和模型窗口", () => {
    const projection = projectEvents([
      ev("usage.updated", {
        tokenUsage: {
          total: { totalTokens: 90_000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          last: { totalTokens: 42_000, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          modelContextWindow: 258_000,
        },
      }),
    ]);
    expect(projection.usage).toEqual({ usedTokens: 42_000, totalTokens: 90_000, contextWindow: 258_000 });
  });

  it("countDiff：统一 diff 跳过文件头；非统一格式的新增 / 删除文件按整份计", () => {
    expect(countDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n", "update")).toEqual({ additions: 1, deletions: 1 });
    expect(countDiff("a\nb\nc\n", "add")).toEqual({ additions: 3, deletions: 0 });
    expect(countDiff("a\nb\n", "delete")).toEqual({ additions: 0, deletions: 2 });
  });
});

describe("会话时间线 · 错误", () => {
  it("可自动重试的错误只提示「正在重试」，接上后消失；最终失败落在回合的错误卡上", () => {
    const retrying = projectEvents([
      started(),
      ev("runtime.error", { error: { message: "stream disconnected" }, willRetry: true }),
    ]);
    expect(onlyTurn(retrying.timeline).error).toMatchObject({ retrying: true });
    expect(onlyTurn(retrying.timeline).error?.message).toContain("正在自动重试");

    seq = 0;
    const recovered = projectEvents([
      started(),
      ev("runtime.error", { error: { message: "stream disconnected" }, willRetry: true }),
      delta("msg-a", "继续"),
    ]);
    expect(onlyTurn(recovered.timeline).error).toBeNull();

    seq = 0;
    const failed = projectEvents([
      started(),
      ev("runtime.error", { error: { message: "exceeded retry limit, last status: 429 Too Many Requests" }, willRetry: false }),
      completed("turn-1", "failed", "exceeded retry limit, last status: 429 Too Many Requests"),
    ]);
    const turn = onlyTurn(failed.timeline);
    expect(turn.status).toBe("failed");
    expect(turn.error).toMatchObject({ retrying: false });
    expect(turn.error?.message).toContain("限流");
  });

  it("回合里正在跑的步骤在中断时收口为 aborted", () => {
    const projection = projectEvents([
      started(),
      item("started", { id: "c-1", type: "commandExecution", command: "sleep 100", status: "inProgress", commandActions: [] }),
      ev("turn.interrupted", { turn: { id: "turn-1", status: "interrupted" } }),
    ]);
    const turn = onlyTurn(projection.timeline);
    expect(turn.status).toBe("interrupted");
    expect(turn.blocks[0]?.kind === "steps" ? turn.blocks[0].steps[0]?.status : null).toBe("aborted");
    expect(turn.currentStep).toBeNull();
  });
});

describe("会话时间线 · 用户消息的位置", () => {
  it("新一轮的消息排在回合之前；运行中插进来、已证实并入的消息放进回合里它发生的位置", () => {
    const projection = projectEvents([
      submitted("c-1", "修一下登录"),
      started(),
      item("completed", { id: "u-1", type: "userMessage", clientId: "c-1", content: [] }),
      delta("msg-a", "好的，先看代码。"),
      submitted("c-2", "顺便加个测试"),
      item("completed", { id: "u-2", type: "userMessage", clientId: "c-2", content: [] }),
      delta("msg-b", "收到，也加测试。"),
      completed(),
    ]);
    expect(projection.timeline.map((entry) => entry.kind)).toEqual(["user", "turn"]);
    const [first] = projection.timeline;
    expect(first?.kind === "user" ? first.message.text : "").toBe("修一下登录");
    expect(shape(onlyTurn(projection.timeline).blocks)).toEqual(["text:好的，先看代码。", "user:顺便加个测试", "text:收到，也加测试。"]);
  });

  it("没有回合归属的过程按连续段落聚合，不跨越中间的消息", () => {
    const projection = projectEvents([
      item("completed", { id: "c-1", type: "commandExecution", command: "a", status: "completed", commandActions: [] }, null),
      submitted("c-9", "中间一句"),
      item("completed", { id: "c-2", type: "commandExecution", command: "b", status: "completed", commandActions: [] }, null),
    ]);
    expect(projection.timeline.map((entry) => entry.kind)).toEqual(["turn", "user", "turn"]);
  });
});

describe("会话时间线 · 审批", () => {
  const requested = (ref: string, command: string) =>
    ev("approval.requested", { kind: "command", approvalRef: ref, request: { command, cwd: "/p", reason: "需要跑测试" } });

  it("审批请求进所属回合的步骤组，等你确认时回合标记为等待；批准后改成已批准", () => {
    const waiting = projectEvents([started(), requested("ap-1", "pnpm test")]);
    const turn = onlyTurn(waiting.timeline);
    expect(shape(turn.blocks)).toEqual(["steps:等你确认：运行 pnpm test"]);
    expect(turn.awaitingApproval).toBe(true);

    seq = 0;
    const decided = projectEvents([
      started(),
      requested("ap-1", "pnpm test"),
      ev("approval.resolved", { decision: "accept", approvalRef: "ap-1", acknowledged: true }),
    ]);
    const after = onlyTurn(decided.timeline);
    expect(shape(after.blocks)).toEqual(["steps:已批准：运行 pnpm test"]);
    expect(after.awaitingApproval).toBe(false);
  });

  it("旧事件没有 approvalRef 时按同一回合里最早还在等的那条对上", () => {
    const projection = projectEvents([
      started(),
      requested("ap-1", "pnpm lint"),
      requested("ap-2", "pnpm test"),
      ev("approval.resolved", { decision: "decline", acknowledged: true }),
    ]);
    expect(shape(onlyTurn(projection.timeline).blocks)).toEqual(["steps:已拒绝：运行 pnpm lint|等你确认：运行 pnpm test"]);
  });

  it("回合结束时还没处理的审批标为已失效", () => {
    const projection = projectEvents([started(), requested("ap-1", "rm -rf build"), completed("turn-1", "interrupted")]);
    const step = onlyTurn(projection.timeline).blocks[0];
    expect(step?.kind === "steps" ? step.steps[0] : undefined).toMatchObject({ status: "aborted", title: "审批已失效：运行 rm -rf build" });
  });
});

describe("会话时间线 · Codex 错误说人话", () => {
  it("重连中的 401：说清原因和第几次重连", () => {
    const projection = projectEvents([
      started(),
      ev("runtime.error", {
        error: {
          message: "Reconnecting... 2/5",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
          additionalDetails: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        },
        willRetry: true,
      }),
    ]);
    const error = onlyTurn(projection.timeline).error;
    expect(error?.retrying).toBe(true);
    expect(error?.message).toBe("模型服务认证失败（401），正在重连（第 2/5 次）…");
  });

  it("没有原因的断线重连", () => {
    const projection = projectEvents([started(), ev("runtime.error", { error: { message: "Reconnecting... 1/5" }, willRetry: true })]);
    expect(onlyTurn(projection.timeline).error?.message).toBe("和模型服务的连接中断了，正在重连（第 1/5 次）…");
  });

  it("最终失败用回合里的错误对象", () => {
    const projection = projectEvents([
      started(),
      ev("turn.completed", { turn: { id: "turn-1", status: "failed", error: { message: "stream disconnected", codexErrorInfo: { other: { httpStatusCode: 503 } }, additionalDetails: null } } }),
    ]);
    expect(onlyTurn(projection.timeline).error?.message).toBe("模型服务暂时出错，请稍后重试。");
  });
});

describe("会话时间线 · 复核补充", () => {
  it("回合中断时，还在修改的改动卡收口为未完成，不计入摘要", () => {
    const projection = projectEvents([
      started(),
      item("started", { id: "fc-1", type: "fileChange", status: "inProgress", changes: [{ path: "a.ts", kind: { type: "add" }, diff: "x\n" }] }),
      ev("turn.interrupted", { turn: { id: "turn-1", status: "interrupted" } }),
    ]);
    const turn = onlyTurn(projection.timeline);
    const block = turn.blocks[0];
    expect(block?.kind === "file-change" ? block.status : null).toBe("aborted");
    expect(turn.summary.filesChanged).toBe(0);
  });

  it("v2 文件改动审批只带 itemId：从同一 item 的改动卡取要改的文件", () => {
    const projection = projectEvents([
      started(),
      item("started", { id: "fc-1", type: "fileChange", status: "inProgress", changes: [{ path: "/code/order/src/a.ts", kind: { type: "update", move_path: null }, diff: "" }] }),
      ev("approval.requested", { kind: "file-change", approvalRef: "ap-1", request: { itemId: "fc-1", reason: null } }),
    ]);
    const steps = onlyTurn(projection.timeline).blocks.find((block) => block.kind === "steps");
    expect(steps?.kind === "steps" ? steps.steps[0]?.title : null).toBe("等你确认：修改 a.ts");
  });
});

describe("会话时间线 · SuDuo 自定义工具（ADR-0008）", () => {
  const stepsOf = (turn: TurnTimeline) => turn.blocks.flatMap((block) => (block.kind === "steps" ? block.steps : []));
  const toolItem = (value: Record<string, JsonValue>) => ({ id: "tool-1", type: "dynamicToolCall", namespace: null, ...value });

  it("看附件：中文动作名、关键参数；完成后显示文字结果，图片显示「（图片）」", () => {
    const projection = projectEvents([
      started(),
      item("started", toolItem({ tool: "suduo_attachment_view", arguments: { attachmentId: "att-1" }, status: "inProgress", contentItems: null, success: null, durationMs: null })),
      item(
        "completed",
        toolItem({
          tool: "suduo_attachment_view",
          arguments: { attachmentId: "att-1" },
          status: "completed",
          contentItems: [
            { type: "inputText", text: "附件「需求问题截图.png」（图片，0.9MB）" },
            { type: "inputImage", imageUrl: "[图片已省略]" },
          ],
          success: true,
          durationMs: 820,
        }),
      ),
      completed(),
    ]);
    const [step] = stepsOf(onlyTurn(projection.timeline));
    expect(step).toMatchObject({
      kind: "tool",
      title: "查看附件",
      detail: "附件 att-1",
      output: "附件「需求问题截图.png」（图片，0.9MB）\n（图片）",
      status: "completed",
      durationMs: 820,
    });
  });

  it("运行中显示动作名；参数可以是 JSON 字符串；评论只露前 60 字", () => {
    const body = "待确认问题：".padEnd(80, "很");
    const projection = projectEvents([
      started(),
      item("started", toolItem({ tool: "suduo_comment_submit", arguments: JSON.stringify({ body }), status: "inProgress", contentItems: null, success: null })),
    ]);
    const turn = onlyTurn(projection.timeline);
    const [step] = stepsOf(turn);
    expect(step?.title).toBe("发评论");
    expect(step?.status).toBe("running");
    expect(step?.detail).toBe(`「${body.slice(0, 60)}…」`);
    expect(turn.currentStep).toEqual({ kind: "tool", title: "发评论", detail: step?.detail });
  });

  it("确认版号、需求编号一起列出；success=false 标成失败并显示原因", () => {
    const projection = projectEvents([
      started(),
      item(
        "completed",
        toolItem({
          tool: "suduo_artifact_fetch",
          arguments: { version: 2, number: 12 },
          status: "completed",
          contentItems: [{ type: "inputText", text: "查不到：需求服务连不上；可以稍后重试。" }],
          success: false,
          durationMs: 40,
        }),
      ),
      completed(),
    ]);
    const [step] = stepsOf(onlyTurn(projection.timeline));
    expect(step).toMatchObject({ title: "拉取确认版", detail: "REQ-12 · 第 2 版", status: "failed", output: "查不到：需求服务连不上；可以稍后重试。" });
  });

  it("不认识的工具显示原名，参数原样给出", () => {
    const projection = projectEvents([
      started(),
      item("completed", toolItem({ tool: "other_tool", arguments: { q: 1 }, status: "completed", contentItems: [], success: true })),
      completed(),
    ]);
    const [step] = stepsOf(onlyTurn(projection.timeline));
    expect(step).toMatchObject({ title: "调用 other_tool", detail: "{\"q\":1}", output: "", status: "completed" });
  });

  it("品牌更名前的旧会话：旧前缀的工具名按新名认（ADR-0010）", () => {
    const legacyTool = ["zj", "work_requirement_get"].join("");
    const projection = projectEvents([
      started(),
      item("completed", toolItem({ tool: legacyTool, arguments: { number: 3 }, status: "completed", contentItems: [], success: true })),
      completed(),
    ]);
    const [step] = stepsOf(onlyTurn(projection.timeline));
    expect(step).toMatchObject({ title: "查看需求", detail: "REQ-3" });
  });

  it("只在 extensions.codex.params 里有 item 的旧形状也能投影", () => {
    const projection = projectEvents([
      started(),
      ev("item.completed", {
        extensions: {
          codex: {
            nativeType: "item/completed",
            params: { item: toolItem({ tool: "suduo_requirement_get", arguments: {}, status: "completed", contentItems: [{ type: "inputText", text: "REQ-1 商家端" }], success: true }) },
          },
        },
      }),
      completed(),
    ]);
    const [step] = stepsOf(onlyTurn(projection.timeline));
    expect(step).toMatchObject({ title: "查看需求", detail: "", output: "REQ-1 商家端" });
  });

  it("写工具的确认在时间线上说成「等你确认：发评论到 REQ-1「…」」，确认后改成已批准", () => {
    const suDuoTool = { tool: "comment_submit", requirement: { id: "r1", projectId: "p1", number: 1, title: "订单详情" }, comment: { body: "x" }, duplicateOf: null };
    const waiting = projectEvents([
      started(),
      ev("approval.requested", { kind: "other", approvalRef: "ap-9", nativeMethod: "item/tool/call", suDuoTool, request: { tool: "suduo_comment_submit" } }),
    ]);
    expect(stepsOf(onlyTurn(waiting.timeline))[0]?.title).toBe("等你确认：发评论到 REQ-1「订单详情」");
    const resolved = projectEvents([
      started(),
      ev("approval.requested", { kind: "other", approvalRef: "ap-9", nativeMethod: "item/tool/call", suDuoTool, request: {} }),
      ev("approval.resolved", { approvalRef: "ap-9", decision: "accept" }),
    ]);
    expect(stepsOf(onlyTurn(resolved.timeline))[0]).toMatchObject({ title: "已批准：发评论到 REQ-1「订单详情」", status: "completed" });
  });
});
