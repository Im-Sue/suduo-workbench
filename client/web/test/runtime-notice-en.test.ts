import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { projectEvents } from "../src/event-projection/reducer.js";
import { applyLocalePreference } from "../src/i18n/locale.js";

let seq = 0;

function ev(type: string, payload: JsonValue, source = "suduo:api"): EventEnvelope<string, JsonValue> {
  seq += 1;
  return {
    schemaVersion: 1,
    seq,
    eventId: `evt-${String(seq)}`,
    sessionId: "s1",
    source,
    type,
    payload,
    threadRef: null,
    turnRef: null,
    ts: 1_000 * seq,
  };
}

/** 时间线上的会话提示（含 runtime.recovery-required），按出现顺序。 */
function timelineNotices(events: EventEnvelope<string, JsonValue>[]): Array<{ text: string; level: string }> {
  return projectEvents(events).timeline.flatMap((entry) =>
    entry.kind === "notice" ? [{ text: entry.notice.text, level: entry.notice.level }] : [],
  );
}

// 迁移前本机服务写进账本的原文，逐字对照：中文界面按 code 渲染的结果必须与它们相同。
const ZH = {
  threadRebuilt:
    "该会话的历史执行上下文无法恢复，已自动重建线程继续。此前对话内容 AI 已不记得，但对话记录与文件改动都完整保留。",
  question: "Codex 想请你回答一个问题，SuDuo 暂时不支持在这里作答，已跳过；Codex 会接着往下做。",
  elicitation: "Codex 想请你确认一个 MCP 工具的操作，SuDuo 暂时不支持这种确认，已替你拒绝；Codex 会换个做法继续。",
  other: "Codex 发来一个 SuDuo 暂时不支持的请求，已跳过；Codex 会接着往下做。",
  connectionRebuilt: "Codex 连接已断开并自动重建，进行中的回合可能中断。",
  truncated: (omitted: number) =>
    `执行过程太长，中间省略了 ${String(omitted)} 条记录（保留了开头和结尾）。完整过程在所有者本机的房间任务会话里。`,
};

/** 本机服务现在写的形状：code + params，message 是英文兜底。 */
function codedEvents(): EventEnvelope<string, JsonValue>[] {
  seq = 0;
  return [
    ev("runtime.warning", { code: "thread-rebuilt", message: "fallback: thread rebuilt" }),
    ev("runtime.warning", { code: "unsupported-request", message: "fallback: question", params: { method: "item/tool/requestUserInput" } }, "runtime:codex"),
    ev("runtime.warning", { code: "unsupported-request", message: "fallback: elicitation", params: { method: "mcpServer/elicitation/request" } }, "runtime:codex"),
    ev("runtime.warning", { code: "unsupported-request", message: "fallback: other", params: { method: "item/somethingNew" } }, "runtime:codex"),
    ev("runtime.warning", { code: "room-run-events-truncated", message: "fallback: truncated", params: { omitted: 12 } }, "suduo:room-agent"),
    ev("runtime.recovery-required", { code: "connection-rebuilt", message: "fallback: connection rebuilt" }, "runtime:codex"),
  ];
}

afterEach(() => {
  applyLocalePreference("system");
});

describe("会话提示按 code 渲染 · 英文", () => {
  it("带 code 的提示按当前语言渲染，不显示存下的兜底文字；提示级别不变", () => {
    applyLocalePreference("en");
    expect(timelineNotices(codedEvents())).toEqual([
      {
        text: "This session's earlier context couldn't be restored, so a new thread was started to continue. The AI no longer remembers the earlier conversation, but the conversation history and file changes are all kept.",
        level: "info",
      },
      {
        text: "Codex asked you a question, but SuDuo can't answer it here yet, so it was skipped. Codex will keep going.",
        level: "info",
      },
      {
        text: "Codex asked you to confirm an MCP tool action, but SuDuo doesn't support this kind of confirmation yet, so it was declined for you. Codex will try another way.",
        level: "info",
      },
      {
        text: "Codex sent a request SuDuo doesn't support yet, so it was skipped. Codex will keep going.",
        level: "info",
      },
      {
        text: "The run details were too long, so 12 records in the middle were left out (the beginning and end are kept). The full details are in the room task session on the owner's computer.",
        level: "important",
      },
      {
        text: "The connection to Codex dropped and was re-established. A turn in progress may have been interrupted.",
        level: "important",
      },
    ]);
    // 过程卡（reducer）里的会话提示同样跟着语言。
    expect(projectEvents(codedEvents()).notices.map((notice) => notice.text)[0]).toBe(
      "This session's earlier context couldn't be restored, so a new thread was started to continue. The AI no longer remembers the earlier conversation, but the conversation history and file changes are all kept.",
    );
  });

  it("中文界面的渲染结果与迁移前写进账本的中文逐字相同", () => {
    expect(timelineNotices(codedEvents()).map((notice) => notice.text)).toEqual([
      ZH.threadRebuilt,
      ZH.question,
      ZH.elicitation,
      ZH.other,
      ZH.truncated(12),
      ZH.connectionRebuilt,
    ]);
  });

  it("省略条数是 1 时英文用单数", () => {
    applyLocalePreference("en");
    seq = 0;
    const [notice] = timelineNotices([
      ev("runtime.warning", { code: "room-run-events-truncated", message: "x", params: { omitted: 1 } }, "suduo:room-agent"),
    ]);
    expect(notice?.text).toBe(
      "The run details were too long, so 1 record in the middle was left out (the beginning and end are kept). The full details are in the room task session on the owner's computer.",
    );
  });

  it("旧事件：线程重建按 code 渲染；没有 code、参数不全或认不出的 code 照原文显示", () => {
    applyLocalePreference("en");
    seq = 0;
    const notices = timelineNotices([
      // 迁移前写的线程重建提示：有 code，存的是中文。
      ev("runtime.warning", { code: "thread-rebuilt", message: ZH.threadRebuilt }),
      // 迁移前写的「不支持」提示：没有 code。
      ev("runtime.warning", { message: ZH.question }, "runtime:codex"),
      // 迁移前写的执行过程截断：有 code、没有参数。
      ev("runtime.warning", { code: "room-run-events-truncated", message: ZH.truncated(3) }, "suduo:room-agent"),
      // 更新的版本写的、这里还不认识的 code：显示英文兜底。
      ev("runtime.warning", { code: "something-new", message: "Something new happened." }),
      // 迁移前写的断线重建：没有 code。
      ev("runtime.recovery-required", { message: ZH.connectionRebuilt }, "runtime:codex"),
    ]);
    expect(notices.map((notice) => notice.text)).toEqual([
      "This session's earlier context couldn't be restored, so a new thread was started to continue. The AI no longer remembers the earlier conversation, but the conversation history and file changes are all kept.",
      ZH.question,
      ZH.truncated(3),
      "Something new happened.",
      ZH.connectionRebuilt,
    ]);
  });

  it("Codex 自带的英文提示照常本地化；断线事件没有文字时用通用说法", () => {
    applyLocalePreference("en");
    seq = 0;
    const notices = timelineNotices([
      ev("runtime.warning", { message: "Falling back from WebSockets to HTTPS transport." }, "runtime:codex"),
      ev("runtime.recovery-required", {}, "runtime:codex"),
    ]);
    expect(notices.map((notice) => notice.text)).toEqual([
      "Couldn't connect to the model service over WebSocket, so it switched to HTTPS.",
      "The runtime connection is back. You can keep working.",
    ]);
  });
});
