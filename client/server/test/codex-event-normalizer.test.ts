import { describe, expect, it } from "vitest";
import type { JsonValue } from "@suduo/client-contracts";
import { normalizeCodexNotification } from "../src/infrastructure/runtime/codex/codex-event-normalizer.js";

function normalize(method: string, params: JsonValue) {
  return normalizeCodexNotification({
    runtimeId: "codex-local",
    connectionId: "connection-1",
    ordinal: 7,
    message: { kind: "notification", method, params },
    sessionHint: "session-1",
  });
}

function payloadOf(method: string, params: JsonValue): Record<string, JsonValue> {
  const payload = normalize(method, params).payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be an object");
  }
  return payload;
}

describe("Codex 通知标准化（P3a 映射）", () => {
  it("turn/plan/updated → plan.updated，保留完整计划与说明，status 原样透传", () => {
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "先读代码再改",
      plan: [
        { step: "读现状", status: "completed" },
        { step: "改 normalizer", status: "inProgress" },
        { step: "补测试", status: "pending" },
        { broken: true },
      ],
    };
    const event = normalize("turn/plan/updated", params);
    expect(event.type).toBe("plan.updated");
    expect(event.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(event.threadRef).toEqual({ runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" });
    expect(event.payload).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "先读代码再改",
      plan: [
        { step: "读现状", status: "completed" },
        { step: "改 normalizer", status: "inProgress" },
        { step: "补测试", status: "pending" },
      ],
      extensions: { codex: { nativeType: "turn/plan/updated", params } },
    });
  });

  it("plan.updated 缺说明时为 null，计划不是数组时为空列表", () => {
    const payload = payloadOf("turn/plan/updated", { threadId: "t", turnId: "u", plan: null });
    expect(payload["explanation"]).toBeNull();
    expect(payload["plan"]).toEqual([]);
  });

  it("item/plan/delta → plan.delta，只带 itemId 与 delta", () => {
    const event = normalize("item/plan/delta", { threadId: "t", turnId: "u", itemId: "plan-1", delta: "- 第一步" });
    expect(event.type).toBe("plan.delta");
    expect(event.turnRef).toEqual({ threadId: "t", turnId: "u" });
    expect(event.payload).toMatchObject({ itemId: "plan-1", delta: "- 第一步" });
    expect(Object.keys(payloadOf("item/plan/delta", { itemId: "plan-1", delta: "x" })).sort()).toEqual(["delta", "extensions", "itemId"]);
  });

  it("推理摘要增量与分段 → reasoning.summary-delta / reasoning.summary-part-added", () => {
    const delta = normalize("item/reasoning/summaryTextDelta", {
      threadId: "t",
      turnId: "u",
      itemId: "rs-1",
      delta: "**Inspecting** the repo",
      summaryIndex: 1,
    });
    expect(delta.type).toBe("reasoning.summary-delta");
    expect(delta.payload).toMatchObject({ itemId: "rs-1", delta: "**Inspecting** the repo", summaryIndex: 1 });

    const part = normalize("item/reasoning/summaryPartAdded", { threadId: "t", turnId: "u", itemId: "rs-1", summaryIndex: 2 });
    expect(part.type).toBe("reasoning.summary-part-added");
    expect(part.payload).toMatchObject({ itemId: "rs-1", summaryIndex: 2 });

    const raw = normalize("item/reasoning/textDelta", { threadId: "t", turnId: "u", itemId: "rs-1", delta: "raw", contentIndex: 0 });
    expect(raw.type).toBe("reasoning.text-delta");
    expect(raw.payload).toMatchObject({ itemId: "rs-1", delta: "raw", contentIndex: 0 });
  });

  it("thread/tokenUsage/updated → usage.updated，tokenUsage 原样透传", () => {
    const tokenUsage = {
      total: { totalTokens: 12000, inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 2000, reasoningOutputTokens: 500 },
      last: { totalTokens: 3000, inputTokens: 2500, cachedInputTokens: 2000, outputTokens: 500, reasoningOutputTokens: 100 },
      modelContextWindow: 272000,
    };
    const event = normalize("thread/tokenUsage/updated", { threadId: "t", turnId: "u", tokenUsage });
    expect(event.type).toBe("usage.updated");
    expect(event.turnRef).toEqual({ threadId: "t", turnId: "u" });
    expect(event.payload).toMatchObject({ threadId: "t", turnId: "u", tokenUsage });
    expect(payloadOf("thread/tokenUsage/updated", { threadId: "t", turnId: "u" })["tokenUsage"]).toBeNull();
  });

  it("item/mcpToolCall/progress → tool.progress", () => {
    const event = normalize("item/mcpToolCall/progress", { threadId: "t", turnId: "u", itemId: "mcp-1", message: "正在检索 3/10" });
    expect(event.type).toBe("tool.progress");
    expect(event.payload).toMatchObject({ threadId: "t", turnId: "u", itemId: "mcp-1", message: "正在检索 3/10" });
  });

  it("线程设置与模型改派有独立类型，不再落 runtime.unknown", () => {
    expect(normalize("thread/settings/updated", { threadId: "t", threadSettings: { model: "gpt-x", effort: "high" } }).type).toBe("thread.settings-updated");
    expect(normalize("model/rerouted", { threadId: "t", turnId: "u", fromModel: "a", toModel: "b", reason: "highRiskCyberActivity" }).type).toBe("model.rerouted");
  });

  it("既有映射保持不变：message.delta 顶层带 itemId，diff / 状态 / 未知通知照旧", () => {
    const message = normalize("item/agentMessage/delta", { threadId: "t", turnId: "u", itemId: "msg-2", delta: "你好" });
    expect(message.type).toBe("message.delta");
    expect(message.payload).toMatchObject({ text: "你好", itemId: "msg-2" });
    expect(normalize("turn/diff/updated", { threadId: "t", turnId: "u", diff: "--- a" }).type).toBe("file.patch-updated");
    expect(normalize("thread/status/changed", { threadId: "t", status: { type: "idle" } }).type).toBe("thread.status-changed");
    expect(normalize("turn/completed", { threadId: "t", turn: { id: "u", status: "interrupted" } }).type).toBe("turn.interrupted");
    expect(normalize("hook/started", { threadId: "t" }).type).toBe("runtime.unknown");
  });
});
