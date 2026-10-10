import { describe, expect, it } from "vitest";
import type { JsonValue } from "@suduo/client-contracts";
import { resolveApprovalOption } from "../src/application/approval-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import {
  approvalDisplay,
  mapApprovalDecision,
  normalizeApprovalRequest,
  type ApprovalServerRequest,
} from "../src/infrastructure/runtime/codex/codex-approval-mapper.js";

/** 多 Agent S1-6：审批载荷的中立字段（对象、可选决策、显示内容）与选项解析（ADR-0014，技术设计 2.3）。 */

const request = (method: string, params: Record<string, JsonValue>): ApprovalServerRequest =>
  ({ kind: "server-request", id: 7, method, params }) as unknown as ApprovalServerRequest;

describe("Codex 审批请求带中立字段", () => {
  it("v2 命令审批：对象 command，四种选项，显示命令、目录与理由；原生字段原样保留", () => {
    const params = { threadId: "t", turnId: "u", itemId: "i", command: "pnpm test", cwd: "/repo", reason: "run tests" };
    const normalized = normalizeApprovalRequest({ message: request("item/commandExecution/requestApproval", params), approvalRef: "ref-1", connectionId: "c-1" });
    expect(normalized.kind).toBe("command");
    expect(normalized.payload).toMatchObject({
      subject: "command",
      options: [
        { id: "accept", decision: "accept" },
        { id: "acceptForSession", decision: "acceptForSession" },
        { id: "decline", decision: "decline" },
        { id: "cancel", decision: "cancel" },
      ],
      display: { command: "pnpm test", cwd: "/repo", reason: "run tests" },
      request: params,
      nativeMethod: "item/commandExecution/requestApproval",
    });
  });

  it("旧版命令审批的命令数组拼成一行；旧版补丁审批列出改动文件；权限审批对象为 permission", () => {
    expect(approvalDisplay("execCommandApproval", { command: ["git", "status"], cwd: "/r" })).toEqual({ command: "git status", cwd: "/r" });
    expect(approvalDisplay("applyPatchApproval", { fileChanges: { "/r/a.ts": {}, "/r/b.ts": {} }, reason: "fix" })).toEqual({ paths: ["/r/a.ts", "/r/b.ts"], reason: "fix" });
    const permissions = normalizeApprovalRequest({ message: request("item/permissions/requestApproval", { reason: "network" }), approvalRef: "r", connectionId: "c" });
    expect((permissions.payload as Record<string, JsonValue>)["subject"]).toBe("permission");
    const file = normalizeApprovalRequest({ message: request("item/fileChange/requestApproval", {}), approvalRef: "r", connectionId: "c" });
    expect((file.payload as Record<string, JsonValue>)["subject"]).toBe("file");
  });

  it("acceptAlways / declineAlways 不是 Codex 的选项；万一传来按最接近的语义换算", () => {
    expect(mapApprovalDecision("item/commandExecution/requestApproval", "acceptAlways")).toEqual({ decision: "acceptForSession" });
    expect(mapApprovalDecision("item/commandExecution/requestApproval", "declineAlways")).toEqual({ decision: "decline" });
    expect(mapApprovalDecision("execCommandApproval", "acceptAlways")).toEqual({ decision: "approved_for_session" });
  });
});

describe("决定时解析选项", () => {
  const acpPayload: JsonValue = {
    subject: "file",
    options: [
      { id: "allow-once-1", decision: "accept" },
      { id: "allow-always-1", decision: "acceptAlways" },
      { id: "reject-once-1", decision: "decline" },
    ],
  };

  it("卡上有选项：按 optionId 或按决策找；不在选项里的报 400", () => {
    expect(resolveApprovalOption(acpPayload, { decision: "acceptAlways" })).toEqual({ id: "allow-always-1", decision: "acceptAlways" });
    expect(resolveApprovalOption(acpPayload, { decision: "accept", optionId: "allow-once-1" })).toEqual({ id: "allow-once-1", decision: "accept" });
    expect(() => resolveApprovalOption(acpPayload, { decision: "cancel" })).toThrow();
    expect(() => resolveApprovalOption(acpPayload, { decision: "accept", optionId: "reject-once-1" })).toThrow();
  });

  it("没有选项的老卡与工具确认卡只认原来四种决策", () => {
    expect(resolveApprovalOption({ kind: "other" }, { decision: "decline" })).toBeNull();
    expect(() => resolveApprovalOption({ kind: "other" }, { decision: "acceptAlways" })).toThrow();
  });
});

describe("迁移 020：审批决策放宽为六种", () => {
  it("acceptAlways / declineAlways 能存，其他值仍被拒", () => {
    const database = openBetterSqlite3Database(":memory:");
    runMigrations(database);
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get<{ sql: string }>()!.sql;
    expect(sql).toContain("'acceptAlways'");
    expect(sql).toContain("'declineAlways'");
    expect(sql).not.toContain("'maybe'");
    database.close();
  });
});
