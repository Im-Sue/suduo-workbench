import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  EventEnvelope,
  JsonValue,
  RespondToolCallInput,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
} from "@suduo/client-contracts";
import { ApiError } from "../src/application/api-error.js";
import { ApprovalService } from "../src/application/approval-service.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { RequirementTools } from "../src/application/session-tools/requirement-tools.js";
import { SessionContextService } from "../src/application/session-tools/session-context.js";
import { SessionToolService } from "../src/application/session-tools/session-tool-service.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { RequirementSessionRefRepository } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { ProjectSessionRefRepository } from "../src/infrastructure/db/repositories/project-session-ref-repository.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";
import { FakeRequirementsRemote, attachmentFixture } from "./helpers/fake-requirements-remote.js";

/**
 * 工具调度 + 写操作确认（技术设计 4.2、六）：内存 SQLite 真仓库 + 事件账本 + 假 runtime。
 * 只读工具直接执行并回包；写工具生成 kind=other 的确认卡，ApprovalService.decide 后执行并回包。
 */

const RUNTIME_ID = "codex-local";
const THREAD_REF = { runtimeId: RUNTIME_ID, runtimeKind: "codex", threadId: "thread-1" };
const ORPHAN_THREAD_REF = { runtimeId: RUNTIME_ID, runtimeKind: "codex", threadId: "thread-2" };

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** 记录 respondToolCall 的假 runtime；approve 不该被工具确认卡调用。 */
class RecordingRuntime implements AgentRuntime {
  readonly runtimeId = RUNTIME_ID;
  readonly runtimeKind = "codex";
  readonly responses: RespondToolCallInput[] = [];
  readonly approvals: unknown[] = [];
  delivered = true;
  /** isToolCallPending 的返回（模拟连接换代后调用失效）。 */
  pendingCalls = true;
  isToolCallPending(): boolean {
    return this.pendingCalls;
  }
  async startThread(): Promise<StartThreadResult> {
    throw new Error("unused");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("unused");
  }
  async approve(input: unknown): Promise<ApproveResult> {
    this.approvals.push(input);
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {}
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
  async respondToolCall(input: RespondToolCallInput): Promise<{ delivered: boolean }> {
    this.responses.push(input);
    return { delivered: this.delivered };
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "suduo-tool-service-"));
  temporaryPaths.push(root);
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const projectRefs = new ProjectSessionRefRepository(database);
  const refs = new RequirementSessionRefRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const published: EventEnvelope<string, JsonValue>[] = [];
  const ledger = new EventLedger(database, events, approvals, { publish: (event) => published.push(event) });

  const project = projects.create({ name: "商家端", rootPath: root, rootPathKey: root });
  const session = sessions.create({ projectId: project.id, title: "REQ-1 会话" });
  threads.attach({ sessionId: session.id, threadRef: THREAD_REF });
  refs.create({
    sessionId: session.id,
    remoteProjectId: "proj-1",
    remoteRequirementId: "req-1",
    requirementVersion: 2,
    requirementNumber: 1,
    requirementTitle: "商家端-订单详情优化",
  });
  // 没有关联远程项目的另一个项目 / 会话。
  const otherRoot = join(root, "other");
  mkdirSync(otherRoot);
  const otherProject = projects.create({ name: "本地项目", rootPath: otherRoot, rootPathKey: otherRoot });
  const orphanSession = sessions.create({ projectId: otherProject.id, title: "普通会话" });
  threads.attach({ sessionId: orphanSession.id, threadRef: ORPHAN_THREAD_REF });

  const runtime = new RecordingRuntime();
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const remote = new FakeRequirementsRemote();
  remote.attachments.set("req-1", [
    attachmentFixture({ id: "att-1", fileName: "需求问题截图.png", contentType: "image/png", sizeBytes: 900 }),
  ]);
  const context = new SessionContextService({ sessions, projects, projectRefs, refs, remote });
  const logs: Array<Record<string, unknown>> = [];
  const service = new SessionToolService({
    runtimes: registry,
    threads,
    approvals,
    ledger,
    context,
    sessions,
    tools: new RequirementTools(remote),
    log: (line) => logs.push(line),
  });
  const approvalService = new ApprovalService(approvals, threads, registry, ledger);
  approvalService.setToolConfirmationHandler(service);

  let ordinal = 0;
  const call = (
    tool: string,
    args: JsonValue,
    options: { threadRef?: typeof THREAD_REF; sessionHint?: string } = {},
  ): string => {
    ordinal += 1;
    const callRef = "call-ref-" + String(ordinal);
    service.handle({
      source: "runtime:" + RUNTIME_ID,
      type: "tool.call-requested",
      payload: {
        callRef,
        connectionId: "connection-1",
        requestId: String(100 + ordinal),
        callId: "call-" + String(ordinal),
        turnId: "turn-1",
        tool,
        arguments: args,
      },
      threadRef: options.threadRef ?? THREAD_REF,
      turnRef: { threadId: (options.threadRef ?? THREAD_REF).threadId, turnId: "turn-1" },
      ts: Date.now(),
      dedupeKey: "connection-1:" + String(ordinal),
      ...(options.sessionHint === undefined ? {} : { sessionHint: options.sessionHint }),
    });
    return callRef;
  };
  const cancel = (callRef: string) =>
    service.handle({
      source: "runtime:" + RUNTIME_ID,
      type: "tool.call-cancelled",
      payload: { callRef, reason: "Codex 已撤回这次工具调用" },
      threadRef: THREAD_REF,
      turnRef: null,
      ts: Date.now(),
      dedupeKey: "connection-1:cancel:" + callRef,
    });
  /** 等到某次调用被回包。 */
  const responseOf = async (callRef: string): Promise<RespondToolCallInput> => {
    await vi.waitFor(() => {
      expect(runtime.responses.some((response) => response.callRef === callRef)).toBe(true);
    });
    return runtime.responses.find((response) => response.callRef === callRef)!;
  };
  /** 等到确认卡入库。 */
  const pendingApprovalOf = async (callRef: string) => {
    await vi.waitFor(() => {
      expect(approvals.listBySession(session.id).some((approval) => approval.runtimeApprovalRef === callRef)).toBe(true);
    });
    return approvals.listBySession(session.id).find((approval) => approval.runtimeApprovalRef === callRef)!;
  };

  return {
    root,
    database,
    session,
    orphanSession,
    approvals,
    approvalService,
    published,
    runtime,
    remote,
    service,
    logs,
    call,
    cancel,
    responseOf,
    pendingApprovalOf,
  };
}

function textOf(response: { contentItems: RespondToolCallInput["contentItems"] }): string {
  return response.contentItems.map((item) => (item.type === "inputText" ? item.text : item.imageUrl)).join("\n");
}

function asObject(value: JsonValue | undefined | null): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, JsonValue>;
}

describe("SessionToolService：只读工具", () => {
  it("品牌更名前建的线程按旧前缀调用，照常按新名执行（ADR-0010）", async () => {
    const { call, responseOf } = setup();
    const callRef = call(["zj", "work_requirement_get"].join(""), { number: "" });
    const response = await responseOf(callRef);
    expect(response.success).toBe(true);
    expect(textOf(response)).toContain("# REQ-1「商家端-订单详情优化」");
  });

  it("只读工具被执行并回包，不生成确认卡；日志不带参数全文", async () => {
    const { call, responseOf, approvals, session, logs } = setup();
    const callRef = call("suduo_requirement_get", { number: "" });
    const response = await responseOf(callRef);
    expect(response.success).toBe(true);
    expect(textOf(response)).toContain("# REQ-1「商家端-订单详情优化」");
    expect(approvals.listBySession(session.id)).toEqual([]);
    await vi.waitFor(() => expect(logs.some((line) => line["event"] === "suduo.tool.call")).toBe(true));
    const log = logs.find((line) => line["event"] === "suduo.tool.call")!;
    expect(log).toMatchObject({ sessionId: session.id, tool: "suduo_requirement_get", success: true });
    expect(log).not.toHaveProperty("arguments");
  });

  it("未知工具回失败", async () => {
    const { call, responseOf } = setup();
    const response = await responseOf(call("suduo_nope", {}));
    expect(response).toEqual({
      callRef: expect.any(String),
      success: false,
      contentItems: [{ type: "inputText", text: "SuDuo 没有工具 suduo_nope。" }],
    });
  });

  it("没有关联项目的会话回失败（只读 / 写工具都一样）", async () => {
    const { call, responseOf, approvals, orphanSession } = setup();
    const read = await responseOf(call("suduo_requirement_get", {}, { threadRef: ORPHAN_THREAD_REF }));
    expect(read.success).toBe(false);
    expect(textOf(read)).toBe("这个会话没有关联 SuDuo 项目，不能使用 suduo 工具。");
    const write = await responseOf(call("suduo_comment_submit", { body: "hi" }, { threadRef: ORPHAN_THREAD_REF }));
    expect(write.success).toBe(false);
    expect(approvals.listBySession(orphanSession.id)).toEqual([]);
  });

  it("notes_read 之后被外部改过，notes_save 返回提示（按会话 + 需求记住读到的版本）", async () => {
    const { call, responseOf, root } = setup();
    await responseOf(call("suduo_notes_save", { content: "# 结论 v1" }));
    await responseOf(call("suduo_notes_read", {}));
    writeFileSync(join(root, ".suduo", "requirements", "REQ-1-商家端-订单详情优化", "notes.md"), "# 结论 v1\n用户加的");
    const saved = await responseOf(call("suduo_notes_save", { content: "# 结论 v2" }));
    expect(textOf(saved)).toContain("注意：在你上次读取之后，笔记被用户或其他会话改过");
  });

  it("回包已失效（连接换代）只记日志，不抛错", async () => {
    const { call, responseOf, runtime, logs } = setup();
    runtime.delivered = false;
    await responseOf(call("suduo_requirement_attachments", {}));
    await vi.waitFor(() => expect(logs.some((line) => line["event"] === "suduo.tool.respond_dropped")).toBe(true));
  });
});

describe("SessionToolService + ApprovalService：写工具确认", () => {
  it("写工具生成 kind=other 的 pending 确认卡，不立即执行也不回包", async () => {
    const { call, pendingApprovalOf, approvalService, runtime, remote, published, session } = setup();
    const callRef = call("suduo_comment_submit", { body: "请确认收货地址字段" });
    const approval = await pendingApprovalOf(callRef);
    expect(approval).toMatchObject({
      sessionId: session.id,
      kind: "other",
      status: "pending",
      runtimeApprovalRef: callRef,
      runtimeConnectionId: "connection-1",
      runtimeRequestId: expect.any(String),
    });
    const dto = approvalService.get(approval.id);
    const request = asObject(dto.request);
    expect(request["nativeMethod"]).toBe("item/tool/call");
    expect(request["suDuoTool"]).toEqual({
      tool: "comment_submit",
      requirement: { id: "req-1", projectId: "proj-1", number: 1, title: "商家端-订单详情优化" },
      comment: { body: "请确认收货地址字段" },
      duplicateOf: null,
    });
    expect(asObject(request["request"])).toMatchObject({ threadId: "thread-1", turnId: "turn-1", tool: "suduo_comment_submit" });
    expect(dto.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(published.map((event) => event.type)).toContain("approval.requested");
    expect(runtime.responses).toEqual([]);
    expect(remote.callsOf("createComment")).toEqual([]);
  });

  it("decide(accept)：执行远程写、回包成功、审批 resolved 且 decisionPayload 带 outcome", async () => {
    const { call, pendingApprovalOf, approvalService, approvals, runtime, remote, published } = setup();
    const callRef = call("suduo_comment_submit", { body: "请确认收货地址字段" });
    const approval = await pendingApprovalOf(callRef);

    const decided = await approvalService.decide(approval.id, { decision: "accept" });
    expect(decided.status).toBe("resolved");
    expect(decided.decision).toBe("accept");
    expect(remote.callsOf("createComment")).toEqual([["req-1", { body: "请确认收货地址字段" }]]);
    expect(runtime.approvals).toEqual([]);
    expect(runtime.responses).toHaveLength(1);
    expect(runtime.responses[0]).toMatchObject({ callRef, success: true });
    const message = textOf(runtime.responses[0]!);
    expect(message).toContain("已发出评论到 REQ-1「商家端-订单详情优化」");

    const record = approvals.getById(approval.id)!;
    expect(record.decisionPayload).toEqual({
      decision: "accept",
      outcome: { executed: true, success: true, message, delivered: true },
    });
    const resolvedEvent = published.find((event) => event.type === "approval.resolved");
    expect(asObject(asObject(resolvedEvent?.payload)["outcome"])["success"]).toBe(true);

    // 已决定的确认卡不能再决定（现有状态机，不会重复发评论）。
    await expect(approvalService.decide(approval.id, { decision: "accept" })).rejects.toMatchObject({ statusCode: 409 });
    expect(remote.callsOf("createComment")).toHaveLength(1);
  });

  it("decline：回「用户没有同意」，远程未被调用", async () => {
    const { call, pendingApprovalOf, approvalService, approvals, runtime, remote } = setup();
    const callRef = call("suduo_comment_submit", { body: "hi" });
    const approval = await pendingApprovalOf(callRef);
    const decided = await approvalService.decide(approval.id, { decision: "decline" });
    expect(decided.status).toBe("resolved");
    expect(runtime.responses).toEqual([
      { callRef, success: false, contentItems: [{ type: "inputText", text: "用户没有同意，评论没有发出。" }] },
    ]);
    expect(remote.callsOf("createComment")).toEqual([]);
    expect(asObject(approvals.getById(approval.id)!.decisionPayload)["outcome"]).toMatchObject({
      executed: false,
      success: false,
    });
  });

  it("远程写失败（4xx）：回「未能发出」，审批照样 resolved，outcome.success=false", async () => {
    const { call, pendingApprovalOf, approvalService, approvals, runtime, remote } = setup();
    remote.fail.createComment = new ApiError(422, "VALIDATION_ERROR", "评论太长");
    const callRef = call("suduo_comment_submit", { body: "hi" });
    const approval = await pendingApprovalOf(callRef);
    await approvalService.decide(approval.id, { decision: "accept" });
    expect(textOf(runtime.responses[0]!)).toBe("未能发出评论：评论太长。");
    expect(approvals.getById(approval.id)!.status).toBe("resolved");
    expect(asObject(approvals.getById(approval.id)!.decisionPayload)["outcome"]).toMatchObject({
      executed: true,
      success: false,
    });
  });

  it("tool.call-cancelled 让 pending 确认卡变 orphaned，之后不能再决定", async () => {
    const { call, cancel, pendingApprovalOf, approvalService, approvals, published, remote } = setup();
    const callRef = call("suduo_comment_submit", { body: "hi" });
    const approval = await pendingApprovalOf(callRef);
    cancel(callRef);
    expect(approvals.getById(approval.id)!.status).toBe("orphaned");
    const orphaned = published.find((event) => event.type === "approval.orphaned");
    expect(asObject(orphaned?.payload)["reason"]).toBe("Codex 已撤回这次工具调用");
    expect(orphaned?.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    await expect(approvalService.decide(approval.id, { decision: "accept" })).rejects.toMatchObject({ statusCode: 409 });
    expect(remote.callsOf("createComment")).toEqual([]);
    // 不相干的 callRef 不影响别的卡。
    const other = await pendingApprovalOf(call("suduo_comment_submit", { body: "another" }));
    cancel("call-ref-unknown");
    expect(approvals.getById(other.id)!.status).toBe("pending");
  });

  it("准备阶段（查远程期间）Codex 就撤回了调用：准备完成后不建确认卡（审查第 2 条）", async () => {
    const { call, cancel, approvals, remote, logs, session } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getRequirement = remote.getRequirement.bind(remote);
    remote.getRequirement = async (id) => {
      await gate;
      return getRequirement(id);
    };
    const callRef = call("suduo_comment_submit", { body: "hi" });
    cancel(callRef);
    release();
    await vi.waitFor(() => {
      expect(logs.some((line) => line["event"] === "suduo.tool.confirmation_skipped")).toBe(true);
    });
    expect(approvals.listBySession(session.id)).toEqual([]);
  });

  it("准备完成时调用已失效（连接换代）：不建确认卡", async () => {
    const { call, approvals, runtime, logs, session } = setup();
    runtime.pendingCalls = false;
    call("suduo_comment_submit", { body: "hi" });
    await vi.waitFor(() => {
      expect(logs.some((line) => line["event"] === "suduo.tool.confirmation_skipped")).toBe(true);
    });
    expect(approvals.listBySession(session.id)).toEqual([]);
  });

  it("还有一张相同内容的待确认卡时，第二张卡标出「还有一张」（只告知，不拒绝；审查第 7 条）", async () => {
    const { call, pendingApprovalOf, approvalService } = setup();
    const first = await pendingApprovalOf(call("suduo_comment_submit", { body: "同一条" }));
    const second = await pendingApprovalOf(call("suduo_comment_submit", { body: "同一条" }));
    expect(asObject(asObject(approvalService.get(first.id).request)["suDuoTool"])["duplicateOf"]).toBeNull();
    expect(asObject(asObject(approvalService.get(second.id).request)["suDuoTool"])["duplicateOf"]).toEqual({
      at: first.requestedAt,
      pending: true,
    });
  });

  it("用户已点「发出」、远程写进行中时 Codex 撤回调用：确认卡不作废，执行结果照实入账", async () => {
    const { call, cancel, pendingApprovalOf, approvalService, approvals, runtime, remote } = setup();
    const callRef = call("suduo_comment_submit", { body: "hi" });
    const approval = await pendingApprovalOf(callRef);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createComment = remote.createComment.bind(remote);
    remote.createComment = async (requirementId, input) => {
      await gate;
      return createComment(requirementId, input);
    };
    runtime.delivered = false;

    const deciding = approvalService.decide(approval.id, { decision: "accept" });
    expect(approvals.getById(approval.id)!.status).toBe("deciding");
    cancel(callRef);
    release();
    const decided = await deciding;
    expect(decided.status).toBe("resolved");
    expect(remote.callsOf("createComment")).toHaveLength(1);
    expect(asObject(approvals.getById(approval.id)!.decisionPayload)["outcome"]).toMatchObject({
      executed: true,
      success: true,
      delivered: false,
    });
  });

  it("同内容第二次发评论：确认卡 duplicateOf 标出上次时间（只告知，不拒绝）；内容不同 / 上次失败则不标", async () => {
    const { call, pendingApprovalOf, approvalService, approvals, remote } = setup();
    const first = await pendingApprovalOf(call("suduo_comment_submit", { body: "同一句话" }));
    await approvalService.decide(first.id, { decision: "accept" });
    const firstDecidedAt = approvals.getById(first.id)!.decidedAt;

    const duplicate = await pendingApprovalOf(call("suduo_comment_submit", { body: "  同一句话 " }));
    const suDuoTool = asObject(asObject(approvalService.get(duplicate.id).request)["suDuoTool"]);
    expect(suDuoTool["duplicateOf"]).toEqual({ at: firstDecidedAt });
    // 不拒绝：仍是 pending，用户确认后照样发出。
    expect(duplicate.status).toBe("pending");
    await approvalService.decide(duplicate.id, { decision: "accept" });
    expect(remote.callsOf("createComment")).toHaveLength(2);

    const different = await pendingApprovalOf(call("suduo_comment_submit", { body: "另一句话" }));
    expect(asObject(asObject(approvalService.get(different.id).request)["suDuoTool"])["duplicateOf"]).toBeNull();

    remote.fail.createComment = new ApiError(422, "VALIDATION_ERROR", "bad");
    const failed = await pendingApprovalOf(call("suduo_comment_submit", { body: "失败的那句" }));
    await approvalService.decide(failed.id, { decision: "accept" });
    const retry = await pendingApprovalOf(call("suduo_comment_submit", { body: "失败的那句" }));
    expect(asObject(asObject(approvalService.get(retry.id).request)["suDuoTool"])["duplicateOf"]).toBeNull();
  });

  it("写工具参数不合法时直接回失败，不生成确认卡", async () => {
    const { call, responseOf, approvals, session } = setup();
    const response = await responseOf(call("suduo_comment_submit", { body: "   " }));
    expect(response.success).toBe(false);
    expect(textOf(response)).toBe("评论内容不能为空。");
    expect(approvals.listBySession(session.id)).toEqual([]);
  });

  it("确认版已停用：旧会话里调用三个撤下的工具（含旧前缀）都回「已停用」，不建确认卡、不调远程", async () => {
    const { session, call, responseOf, approvals, remote } = setup();
    // eslint-disable-next-line no-restricted-syntax -- ADR-0010：更名前的旧线程按旧前缀调用，这里验证它同样认作已停用
    for (const tool of ["suduo_artifact_publish", "suduo_artifact_versions", "zjwork_artifact_fetch"]) {
      const response = await responseOf(call(tool, { version: 1 }));
      expect(response.success).toBe(false);
      const current = tool.replace(/^[a-z]+_artifact_/u, "suduo_artifact_");
      expect(textOf(response)).toBe(
        `${current} 已停用：SuDuo 不再有「确认版」，需求的资料都在附件里。用 suduo_requirement_attachments 看附件清单（最新在前），用 suduo_attachment_view 查看内容。`,
      );
    }
    expect(approvals.listBySession(session.id)).toEqual([]);
    expect(remote.calls).toEqual([]);
  });

  it("回包未送达（调用已失效）时审批仍 resolved，outcome.delivered=false", async () => {
    const { call, pendingApprovalOf, approvalService, approvals, runtime } = setup();
    const approval = await pendingApprovalOf(call("suduo_comment_submit", { body: "hi" }));
    runtime.delivered = false;
    await approvalService.decide(approval.id, { decision: "accept" });
    expect(approvals.getById(approval.id)!.status).toBe("resolved");
    expect(asObject(asObject(approvals.getById(approval.id)!.decisionPayload)["outcome"])["delivered"]).toBe(false);
  });

  it("acceptForSession 视同同意", async () => {
    const { call, pendingApprovalOf, approvalService, remote } = setup();
    const approval = await pendingApprovalOf(call("suduo_comment_submit", { body: "hi" }));
    await approvalService.decide(approval.id, { decision: "acceptForSession" });
    expect(remote.callsOf("createComment")).toHaveLength(1);
  });
});
