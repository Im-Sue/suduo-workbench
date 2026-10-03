import type { ApprovalDto, EventEnvelope, JsonValue } from "@suduo/client-contracts";
import { useMemo, useState } from "react";
import { projectEvents } from "../event-projection/reducer.js";
import { ApprovalDock } from "../features/sessions/ApprovalDock.js";
import { ConversationStream } from "../features/sessions/stream/ConversationStream.js";

/**
 * 设计系统页里的会话消息流样本（仅开发环境）：用一段构造的事件覆盖回合的各种形态，
 * 双主题下过目文字与步骤交错、计划、改动卡、插话、等你确认、失败与重试。
 */
const BASE = Date.now() - 20 * 60_000;
let seq = 0;

function ev(type: string, payload: JsonValue, turnId: string | null): EventEnvelope<string, JsonValue> {
  seq += 1;
  return {
    schemaVersion: 1,
    seq,
    eventId: `sample-${seq}`,
    sessionId: "sample",
    source: "codex",
    type,
    payload,
    threadRef: null,
    turnRef: turnId === null ? null : { threadId: "t", turnId },
    ts: BASE + seq * 4_000,
  };
}

const DIFF = "@@ -12,7 +12,9 @@\n export function exportOrders() {\n-  const limit = 500;\n+  const limit = 10_000;\n+  const retention = days(30);\n   return query(limit);\n }\n";

function sampleEvents(): EventEnvelope<string, JsonValue>[] {
  seq = 0;
  const t1 = "turn-sample-1";
  const t2 = "turn-sample-2";
  const t3 = "turn-sample-3";
  return [
    ev("message.submitted", { clientTurnId: "c1", content: [{ type: "text", text: "把订单导出的上限改成 1 万条，保留 30 天，顺便补测试" }, { type: "skill", name: "backend", path: "/s" }] }, null),
    ev("turn.started", { turn: { id: t1 } }, t1),
    ev("item.completed", { item: { id: "u1", type: "userMessage", clientId: "c1", content: [] } }, t1),
    ev("plan.updated", { explanation: null, plan: [{ step: "读导出实现", status: "completed" }, { step: "改上限与保留期", status: "completed" }, { step: "补单测", status: "completed" }] }, t1),
    ev("item.completed", { item: { id: "r1", type: "reasoning", summary: ["**梳理导出链路**\n\n先看导出服务和它的配置。"], content: [] } }, t1),
    ev("item.completed", { item: { id: "c1r", type: "commandExecution", command: "cat src/export.ts", status: "completed", durationMs: 40, commandActions: [{ type: "read", command: "cat src/export.ts", name: "export.ts", path: "/p/src/export.ts" }] } }, t1),
    ev("item.completed", { item: { id: "c2r", type: "commandExecution", command: "rg retention", status: "completed", durationMs: 90, commandActions: [{ type: "search", command: "rg retention", query: "retention", path: null }] } }, t1),
    ev("item.completed", { item: { id: "m1", type: "agentMessage", text: "导出上限写死在 `exportOrders` 里，我把它改成可配置的 1 万条，并加上 30 天保留期。" } }, t1),
    ev("item.completed", { item: { id: "f1", type: "fileChange", status: "completed", changes: [{ path: "src/export.ts", kind: { type: "update", move_path: null }, diff: DIFF }, { path: "test/export.test.ts", kind: { type: "add" }, diff: "a\nb\nc\nd\ne\nf\n" }] } }, t1),
    ev("item.completed", { item: { id: "c3", type: "commandExecution", command: "pnpm test export", status: "completed", exitCode: 0, durationMs: 8_400, aggregatedOutput: " ✓ test/export.test.ts (4 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n", commandActions: [{ type: "unknown", command: "pnpm test export" }] } }, t1),
    ev("item.completed", { item: { id: "m2", type: "agentMessage", text: "测试都通过了。需要的话我可以再把导出改成分批写入，避免一次读 1 万条占内存。" } }, t1),
    ev("turn.completed", { turn: { id: t1, status: "completed" } }, t1),
    ev("message.submitted", { clientTurnId: "c2", content: [{ type: "text", text: "好，改成分批写入" }] }, null),
    ev("turn.started", { turn: { id: t2 } }, t2),
    ev("item.completed", { item: { id: "u2", type: "userMessage", clientId: "c2", content: [] } }, t2),
    ev("runtime.error", { error: { message: "exceeded retry limit, last status: 429 Too Many Requests" }, willRetry: false }, t2),
    ev("turn.completed", { turn: { id: t2, status: "failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } } }, t2),
    ev("message.submitted", { clientTurnId: "c3", content: [{ type: "text", text: "再试一次，分批大小 500" }] }, null),
    ev("turn.started", { turn: { id: t3 } }, t3),
    ev("item.completed", { item: { id: "u3", type: "userMessage", clientId: "c3", content: [] } }, t3),
    ev("plan.updated", { explanation: "按批写入，每批 500 条", plan: [{ step: "改写导出循环", status: "completed" }, { step: "跑集成测试", status: "inProgress" }, { step: "更新文档", status: "pending" }] }, t3),
    ev("message.delta", { itemId: "m3", text: "循环已经改成每批 500 条。接下来跑一遍集成测试。" }, t3),
    ev("message.submitted", { clientTurnId: "c4", content: [{ type: "text", text: "跑完顺便看下 lint" }] }, null),
    ev("item.completed", { item: { id: "u4", type: "userMessage", clientId: "c4", content: [] } }, t3),
    ev("approval.requested", { kind: "command", approvalRef: "ap-1", request: { command: "pnpm test:integration", cwd: "/Users/me/code/order-center", reason: "集成测试会连本机数据库" } }, t3),
  ];
}

export function SessionStreamSample() {
  const projection = useMemo(() => projectEvents(sampleEvents()), []);
  const [approvals, setApprovals] = useState<ApprovalDto[]>(() => [
    {
      id: "ap-1",
      sessionId: "sample",
      threadRef: { runtimeId: "codex", runtimeKind: "codex", threadId: "t" } as ApprovalDto["threadRef"],
      turnRef: null,
      kind: "command",
      status: "pending",
      decision: null,
      request: { request: { command: "pnpm test:integration", cwd: "/Users/me/code/order-center", reason: "集成测试会连本机数据库" } },
      requestedAt: Date.now(),
      decidedAt: null,
      version: 1,
    },
  ]);
  return (
    <div className="flex h-[720px] flex-col overflow-hidden rounded-lg border border-border bg-background">
      <ConversationStream
        timeline={projection.timeline}
        historyLoading={false}
        now={Date.now()}
        actions={{ onOpenChange: () => undefined, onViewChanges: () => undefined, onRetry: () => undefined }}
        empty={null}
      />
      <div className="px-6">
        <ApprovalDock
          approvals={approvals}
          onDecide={async () => {
            setApprovals([]);
          }}
        />
      </div>
      <div className="mx-6 mb-4 h-24 rounded-lg border border-border bg-card" aria-hidden="true" />
    </div>
  );
}
