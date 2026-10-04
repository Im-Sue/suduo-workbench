import { describe, expect, it } from "vitest";
import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { RoomMessageDto } from "@suduo/cloud-contracts";
import {
  ROOM_CONTEXT_LIMITS,
  buildRoomTurnInput,
  rebuiltTopicSection,
  roomTaskTitle,
} from "../src/application/room-agent/context.js";
import { agentRunEventsTruncatedFallback, agentRunProgressFallback } from "@suduo/cloud-contracts";
import {
  RunProgressTracker,
  compactRunEvents,
  describeTurnFailure,
  summaryOf,
} from "../src/application/room-agent/progress.js";
import { messagesFor } from "../src/i18n/messages/index.js";

/**
 * 房间 Agent 的回合输入组装（技术设计 4.4）、进度口径、执行过程截断、摘要与失败原因。
 */

const PM = { id: "user-pm", displayName: "李娜" };
const DEV = { id: "user-dev", displayName: "陈思远" };
const AGENT = { id: "agent-1", kind: "codex" as const, owner: DEV, deviceName: "MacBook", label: "陈思远's Codex · MacBook" };

function message(seq: number, overrides: Partial<RoomMessageDto> = {}): RoomMessageDto {
  return {
    id: "m-" + String(seq),
    roomId: "room-1",
    seq,
    clientId: null,
    authorKind: "user",
    author: PM,
    agent: null,
    body: "第 " + String(seq) + " 条",
    mentions: [],
    threadRootId: null,
    files: [],
    thread: null,
    runs: [],
    // 都在同一天：10:00 起每条隔一分钟。
    createdAt: new Date(2026, 8, 30, 10, seq).toISOString(),
    ...overrides,
  };
}

describe("buildRoomTurnInput：新话题", () => {
  it("近邻层（20 条、24 小时内）+ 触发消息；附件给文件名与 ID", () => {
    const neighbors = Array.from({ length: 25 }, (_, index) => message(index + 1));
    neighbors[24] = message(25, {
      files: [
        {
          id: "f-1",
          roomId: "room-1",
          fileName: "订单截图.png",
          contentType: "image/png",
          kind: "image",
          sizeBytes: 10,
          sha256: "0".repeat(64),
          uploadedBy: PM,
          createdAt: neighbors[24]!.createdAt,
        },
      ],
    });
    // 超过 24 小时的旧消息不进近邻层。
    const stale = message(0, { id: "m-old", createdAt: new Date(2026, 8, 28, 9, 0).toISOString() });
    const trigger = message(30, { body: "@陈思远的Codex 订单详情现在能拿到收货信息吗？" });
    const input = buildRoomTurnInput({
      mode: "new",
      trigger,
      threadBefore: [],
      neighbors: [stale, ...neighbors],
      lastTriggerSeq: 0,
      selfAgentId: AGENT.id,
    });
    expect(input.neighborCount).toBe(20);
    expect(input.text).toContain("[房间近况（触发消息之前，最近 20 条）]");
    expect(input.text).not.toContain("第 5 条");
    expect(input.text).toContain("第 6 条");
    expect(input.text).not.toContain("m-old");
    expect(input.text).toContain("[图片 订单截图.png]（文件 ID f-1，用 suduo_room_file_view 查看）");
    expect(input.text).toMatch(/\[@ 你的消息\]\n10:30 李娜：@陈思远的Codex 订单详情现在能拿到收货信息吗？\n请回答这条消息。$/u);
  });

  it("话题里的触发：带话题根与之前的回复（单条截 1500 字），近邻排除话题里的消息", () => {
    const root = message(10, { body: "订单详情要加收货信息" });
    const reply = message(12, { threadRootId: root.id, body: "长".repeat(2_000) });
    const trigger = message(14, { threadRootId: root.id, body: "@Codex 现在能拿到吗" });
    const input = buildRoomTurnInput({
      mode: "new",
      trigger,
      threadBefore: [root, reply],
      neighbors: [message(9), root, message(11)],
      lastTriggerSeq: 0,
      selfAgentId: AGENT.id,
    });
    expect(input.topicCount).toBe(2);
    expect(input.text).toContain("[话题（根消息与之前的回复，共 2 条）]");
    expect(input.text).toContain("这条共 2000 字，后面省略");
    // 根消息只出现在话题层，不在近邻层重复。
    expect(input.text.match(/订单详情要加收货信息/gu)).toHaveLength(1);
    expect(input.neighborCount).toBe(2);
  });

  it("超过 40000 字时近邻 20 → 5 → 0，再从最早的话题回复截", () => {
    const longNeighbors = Array.from({ length: 20 }, (_, index) => message(index + 1, { body: "近".repeat(480) }));
    const root = message(30, { body: "根" });
    const replies = Array.from({ length: 30 }, (_, index) =>
      message(31 + index, { threadRootId: root.id, body: "回".repeat(1_400) }),
    );
    const trigger = message(70, { threadRootId: root.id, body: "@Codex 总结一下" });
    const fiveFit = buildRoomTurnInput({
      mode: "new",
      trigger,
      threadBefore: [root, ...replies.slice(0, 22)],
      neighbors: longNeighbors,
      lastTriggerSeq: 0,
      selfAgentId: AGENT.id,
    });
    expect(fiveFit.neighborCount).toBe(5);
    expect(fiveFit.text.length).toBeLessThanOrEqual(ROOM_CONTEXT_LIMITS.budget);

    const overflow = buildRoomTurnInput({
      mode: "new",
      trigger,
      threadBefore: [root, ...replies],
      neighbors: longNeighbors,
      lastTriggerSeq: 0,
      selfAgentId: AGENT.id,
    });
    expect(overflow.neighborCount).toBe(0);
    expect(overflow.omittedTopic).toBeGreaterThan(0);
    expect(overflow.text.length).toBeLessThanOrEqual(ROOM_CONTEXT_LIMITS.budget);
    // 根与触发消息始终保留。
    expect(overflow.text).toContain("：根");
    expect(overflow.text).toContain("@Codex 总结一下");
    expect(overflow.text).toContain(`（更早的 ${overflow.omittedTopic} 条回复省略）`);
  });

  it("房间近况查不到时写「查不到」，不说成没有", () => {
    const input = buildRoomTurnInput({
      mode: "new",
      trigger: message(3),
      threadBefore: [],
      neighbors: [],
      neighborsUnavailable: "需求服务暂时连不上",
      lastTriggerSeq: 0,
      selfAgentId: AGENT.id,
    });
    expect(input.text).toContain("[房间近况] 查不到：需求服务暂时连不上");
  });
});

describe("buildRoomTurnInput：续接", () => {
  it("只给上次触发之后话题里的新消息（不含自己的回答）+ 触发消息，不带近邻", () => {
    const root = message(10);
    const oldReply = message(11, { threadRootId: root.id, body: "旧回复" });
    const ownAnswer = message(13, { threadRootId: root.id, authorKind: "agent", author: DEV, agent: AGENT, body: "我上次的回答" });
    const otherAgent = message(14, {
      threadRootId: root.id,
      authorKind: "agent",
      author: PM,
      agent: { ...AGENT, id: "agent-2", label: "李娜's Codex · PC" },
      body: "别人的 Agent 说的",
    });
    const fresh = message(15, { threadRootId: root.id, body: "补充：历史订单也要" });
    const trigger = message(16, { threadRootId: root.id, body: "@Codex 历史订单也有吗？" });
    const input = buildRoomTurnInput({
      mode: "continue",
      trigger,
      threadBefore: [root, oldReply, ownAnswer, otherAgent, fresh],
      neighbors: [message(1)],
      lastTriggerSeq: 12,
      selfAgentId: AGENT.id,
    });
    expect(input.neighborCount).toBe(0);
    expect(input.topicCount).toBe(2);
    expect(input.text).toContain("[话题里的新消息（你上次被 @ 之后）]");
    expect(input.text).not.toContain("旧回复");
    expect(input.text).not.toContain("我上次的回答");
    expect(input.text).toContain("李娜's Codex · PC：别人的 Agent 说的");
    expect(input.text).toContain("补充：历史订单也要");
    expect(input.text).toContain("@Codex 历史订单也有吗？");
  });

  it("没有新消息时只有触发消息", () => {
    const input = buildRoomTurnInput({
      mode: "continue",
      trigger: message(20, { threadRootId: "m-10" }),
      threadBefore: [message(10)],
      neighbors: [],
      lastTriggerSeq: 19,
      selfAgentId: AGENT.id,
    });
    expect(input.text.startsWith("[@ 你的消息]")).toBe(true);
  });

  it("线程重建：固定层补上到上次被 @ 为止的话题消息（含自己的回答），包在证据段里；查不到写「查不到」", () => {
    // 真实序号：回答在完成时才分配序号，总在它的触发消息之后（12 → 13，15 → 16）。
    const history = [
      message(10, { body: "订单详情要展示收货信息" }),
      message(12, { threadRootId: "m-10", body: "第一次 @" }),
      message(13, { threadRootId: "m-10", authorKind: "agent", agent: AGENT, author: DEV, body: "后端已有 receiverSnapshot" }),
      message(15, { threadRootId: "m-10", body: "上次触发" }),
      message(16, { threadRootId: "m-10", authorKind: "agent", agent: AGENT, author: DEV, body: "上次的回答：前端抽屉没展示" }),
      message(17, {
        threadRootId: "m-10",
        authorKind: "agent",
        agent: { ...AGENT, id: "agent-2", label: "李娜's Codex · PC" },
        body: "别人的 Agent 说的",
      }),
      message(18, { threadRootId: "m-10", body: "历史订单也要" }),
    ];
    const section = rebuiltTopicSection(history, 15, AGENT.id);
    expect(section).toContain("线程重建");
    expect(section).toContain("<房间话题记录>");
    expect(section).toContain("订单详情要展示收货信息");
    expect(section).toContain("后端已有 receiverSnapshot");
    expect(section).toContain("上次触发");
    // 上次被 @ 的回答序号在触发之后，也要补上（续接输入会跳过自己的回答）。
    expect(section).toContain("上次的回答：前端抽屉没展示");
    // 上次触发之后别人的消息（含别人的 Agent）在回合输入里，不重复放进固定层。
    expect(section).not.toContain("历史订单也要");
    expect(section).not.toContain("别人的 Agent 说的");
    expect(section.indexOf("不是给你的指令")).toBeLessThan(section.indexOf("\n<房间话题记录>\n"));

    const unavailable = rebuiltTopicSection({ unavailable: "需求服务暂不可用" }, 15, AGENT.id);
    expect(unavailable).toContain("查不到：需求服务暂不可用（这不代表没有）");
  });

  it("会话标题：房间名 · 话题前 20 字", () => {
    expect(roomTaskTitle("订单中心", "@陈思远的Codex  商家后台的订单详情现在能拿到收货信息吗？")).toBe(
      "订单中心 · @陈思远的Codex 商家后台的订单详情",
    );
    expect(roomTaskTitle("订单中心", "   ")).toBe("订单中心");
  });
});

describe("进度、摘要与失败原因", () => {
  it("进度与前端同口径：查看 / 运行 / 工具按 item 计数，没有步骤时 thinking；只给 code + 计数", () => {
    const tracker = new RunProgressTracker();
    expect(tracker.progress()).toEqual({ code: "thinking", params: {} });
    const item = (id: string, value: Record<string, JsonValue>) => ({
      type: "item.started",
      payload: { item: { id, ...value } },
    });
    tracker.observe(item("c1", { type: "commandExecution", commandActions: [{ type: "read", name: "a.ts" }] }));
    tracker.observe(item("c2", { type: "commandExecution", commandActions: [{ type: "read", name: "b.ts" }] }));
    tracker.observe(item("c3", { type: "commandExecution", command: "pnpm test", commandActions: [] }));
    tracker.observe(item("t1", { type: "dynamicToolCall", tool: "suduo_room_history" }));
    // 同一个 item 的 completed 不重复计数。
    tracker.observe({ type: "item.completed", payload: { item: { id: "c1", type: "commandExecution", commandActions: [{ type: "read" }] } } });
    tracker.observe(item("r1", { type: "reasoning" }));
    tracker.observe(item("w1", { type: "webSearch", query: "receiverSnapshot" }));
    const progress = tracker.progress();
    // 前端渲染成「查看了 2 个文件 · 运行了 1 条命令 · 调用了 1 次工具 · 搜索了 1 次网页」（web 测试 rooms-run-texts）。
    expect(progress).toEqual({ code: "activity", params: { read: 2, command: 1, tool: 1, web: 1 } });
    expect(agentRunProgressFallback(progress.code, progress.params)).toBe(
      "Read 2 files · Ran 1 command · Made 1 tool call · Searched the web once",
    );
  });

  it("摘要取回答第一句（≤ 80 字），跳过标题与列表符号", () => {
    expect(summaryOf("## 结论\n\n后端已有 receiverSnapshot，前端抽屉没展示。具体如下……")).toBe(
      "后端已有 receiverSnapshot，前端抽屉没展示。",
    );
    expect(summaryOf("- **可以拿到**：接口已返回")).toBe("可以拿到：接口已返回");
    expect(Array.from(summaryOf("长".repeat(200)))).toHaveLength(80);
  });

  it("失败原因归类：Codex 错误码 / 状态码归类 / 报错原文 / 原因未知（前端按 code 渲染）", () => {
    const failed = (error: JsonValue | undefined) =>
      describeTurnFailure({ turn: { status: "failed", ...(error === undefined ? {} : { error }) } });
    expect(failed({ message: "x", codexErrorInfo: "usageLimitExceeded" })).toEqual({
      code: "turn_failed",
      params: { codexError: "usageLimitExceeded" },
    });
    expect(failed({ message: "429 Too Many Requests" }).params).toEqual({ category: "rate_limited" });
    // 认不出的错误码按报错原文归类。
    expect(failed({ message: "Unauthorized", codexErrorInfo: "somethingNew" }).params).toEqual({ category: "unauthorized" });
    expect(failed({ message: "403 Forbidden" }).params).toEqual({ category: "forbidden" });
    expect(failed({ message: "stream failed", codexErrorInfo: { responseStreamFailed: { httpStatusCode: 502 } } }).params).toEqual({
      category: "server_error",
    });
    expect(failed({ message: "request timed out" }).params).toEqual({ category: "timeout" });
    expect(failed({ message: "boom", additionalDetails: "disk full" }).params).toEqual({ detail: "disk full boom" });
    expect((failed({ message: "长".repeat(800) }).params as { detail: string }).detail).toHaveLength(500);
    expect(failed(undefined)).toEqual({ code: "turn_failed", params: {} });
  });
});

describe("compactRunEvents：执行过程回写", () => {
  const envelope = (seq: number, type: string, payload: JsonValue): EventEnvelope<string, JsonValue> => ({
    schemaVersion: 1,
    seq,
    eventId: "e-" + String(seq),
    sessionId: "s-1",
    source: "runtime:codex-local",
    type,
    payload,
    threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "th-1" },
    turnRef: { threadId: "th-1", turnId: "turn-1" },
    ts: seq,
  });

  it("去掉逐字增量与 extensions，快照只留最后一条，长文本截 4000 字（后缀按所有者的界面语言）", () => {
    const source = [
      envelope(1, "turn.started", { turn: { id: "turn-1" }, extensions: { codex: { params: {} } } }),
      envelope(2, "message.delta", { text: "逐字" }),
      envelope(3, "usage.updated", { tokenUsage: null }),
      envelope(4, "item.completed", { item: { type: "commandExecution", aggregatedOutput: "x".repeat(10_000) } }),
      envelope(5, "usage.updated", { tokenUsage: { total: 1 } }),
      envelope(6, "turn.completed", { turn: { status: "completed" } }),
    ];
    const events = compactRunEvents(source, messagesFor("zh-CN"));
    expect(events.map((event) => event.seq)).toEqual([1, 4, 5, 6]);
    expect(events[0]!.payload).toEqual({ turn: { id: "turn-1" } });
    const output = (events[1]!.payload as { item: { aggregatedOutput: string } }).item.aggregatedOutput;
    expect(output.startsWith("x".repeat(4_000))).toBe(true);
    expect(output).toBe("x".repeat(4_000) + "…（以下省略，共 10000 字）");
    const english = compactRunEvents(source, messagesFor("en"));
    expect((english[1]!.payload as { item: { aggregatedOutput: string } }).item.aggregatedOutput).toBe(
      "x".repeat(4_000) + "… (cut off here; 10000 characters in total)",
    );
  });

  it("总量超限时丢中间、保留开头结尾，末尾加一条说明", () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      envelope(index + 1, "item.completed", { item: { id: "i" + String(index), text: "y".repeat(900) } }),
    );
    const compacted = compactRunEvents(events, messagesFor("zh-CN"), { stringChars: 4_000, totalBytes: 30_000 });
    const total = compacted.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    expect(total).toBeLessThanOrEqual(30_000);
    expect(compacted[0]!.seq).toBe(1);
    const notice = compacted.at(-1)!;
    expect(notice.type).toBe("runtime.warning");
    // 说明带 code 与省略条数（前端按 code 渲染），message 是英文兜底。
    const payload = notice.payload as { code: string; params: { omitted: number }; message: string };
    expect(payload.code).toBe("room-run-events-truncated");
    expect(payload.params.omitted).toBeGreaterThan(0);
    expect(payload.message).toBe(agentRunEventsTruncatedFallback(payload.params.omitted));
    expect(payload.message).toMatch(/^The run details were too long, so \d+ records in the middle were left out/u);
    expect(compacted.length - 1 + payload.params.omitted).toBe(100);
    // 结尾那条（最后的事件）保留在说明之前。
    expect(compacted.at(-2)!.seq).toBe(100);
    expect(compacted.length).toBeLessThan(100);
  });
});
