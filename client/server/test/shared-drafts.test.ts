import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, SharedDraftDto } from "@suduo/client-contracts";
import type { HandoffContent, SnapshotContent } from "@suduo/cloud-contracts";
import { HandoffTools } from "../src/application/collab/handoff-tools.js";
import { scanSecrets } from "../src/application/collab/secret-scan.js";
import { scrubPaths, SharedDraftService } from "../src/application/collab/shared-draft-service.js";
import type { ProjectedRound } from "../src/application/context/session-projection.js";
import type { ToolSessionContext } from "../src/application/session-tools/requirement-tools.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { ReviewRepository } from "../src/infrastructure/db/repositories/review-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SharedDraftRepository } from "../src/infrastructure/db/repositories/shared-draft-repository.js";
import { DEV, FakeRequirementsRemote } from "./helpers/fake-requirements-remote.js";

/** 共享对象草稿与交接包（多 Agent 协作 S11，需求 4.7 / 4.13）：起草、编辑、疑似密钥提示、发布到需求、交接包工具。 */

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function round(patch: Partial<ProjectedRound>): ProjectedRound {
  return { index: 1, seq: 1, startedAt: 1, userText: "", attachmentCount: 0, status: "completed", error: null, answer: null, commands: [], tools: [], files: [], webSearches: [], ...patch } as ProjectedRound;
}

function setup() {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  closers.push(() => database.close());
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const reviews = new ReviewRepository(database);
  const project = projects.create({ name: "p", rootPath: "/work/shop", rootPathKey: "/work/shop" });
  const main = sessions.create({ projectId: project.id, title: "订单导出", state: "active", agentId: "claude-code" });
  const plain = sessions.create({ projectId: project.id, title: "随便聊聊", state: "active", agentId: "codex" });
  const requirementOf = new Map<string, string>([[main.id, "req-1"]]);
  const rounds = new Map<string, ProjectedRound[]>();
  const ledger: Array<{ sessionId: string; type: string; payload: JsonValue }> = [];
  const remote = new FakeRequirementsRemote();
  const drafts = new SharedDraftService({
    drafts: new SharedDraftRepository(database),
    sessions,
    requirementOf: (sessionId) => requirementOf.get(sessionId) ?? null,
    sessionRoot: () => "/work/shop",
    reviews,
    rounds: (sessionId) => rounds.get(sessionId) ?? [],
    remote,
    ledger: {
      append: (input) => {
        ledger.push({ sessionId: input.sessionId, type: input.event.type, payload: input.event.payload });
        return {} as never;
      },
    },
    threads: { getPrimary: (sessionId) => ({ id: "binding-" + sessionId, threadRef: { runtimeId: "r", runtimeKind: "codex", threadId: "t-" + sessionId } }) as never },
    home: "/Users/sue",
  });
  const tools = new HandoffTools({ drafts, remote, agentName: (agentId) => ({ codex: "Codex", "claude-code": "Claude Code" })[agentId] ?? agentId });
  const ctx = (sessionId: string, patch: Partial<ToolSessionContext> = {}): ToolSessionContext => ({
    sessionId,
    locale: "zh-CN",
    projectRoot: "/work/shop",
    remoteProjectId: "proj-1",
    requirement: requirementOf.has(sessionId) ? { remoteRequirementId: requirementOf.get(sessionId)!, startVersion: 1, startedAt: "2026-10-01T00:00:00.000Z" } : null,
    ...patch,
  });
  return { sessions, reviews, main, plain, rounds, ledger, remote, drafts, tools, ctx };
}

const text = (result: { contentItems: Array<{ type: string; text?: string }> }) => result.contentItems.map((item) => item.text ?? "").join("\n");

describe("疑似密钥检查", () => {
  it("常见密钥、令牌、私钥、赋值形式都标出字段与遮住中间的片段；占位与普通文字不报；同一段只报一次", () => {
    const hits = scanSecrets({
      summary: "用 sk-proj-abcdefghijklmnopqrstuvwxyz123456 调接口",
      todo: ["换掉 ghp_abcdefghijklmnopqrstuvwxyz0123456789", "普通的一句话"],
      risks: ["-----BEGIN OPENSSH PRIVATE KEY----- 别外传", "AKIAABCDEFGHIJKLMNOP"],
      nested: { answer: 'api_key = "Zx9Qw8Er7Ty6Ui5Op4As"', placeholder: "api_key=<your key here>", anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwx" },
    });
    expect(hits.map((hit) => [hit.field, hit.kind])).toEqual([
      ["summary", "openai-key"],
      ["todo[0]", "github-token"],
      ["risks[0]", "private-key"],
      ["risks[1]", "aws-access-key"],
      ["nested.answer", "assignment"],
      ["nested.anthropic", "anthropic-key"],
    ]);
    expect(hits[0]!.excerpt).toBe("sk-p…3456");
    expect(JSON.stringify(hits)).not.toContain("abcdefghijklmnop");
    expect(scanSecrets({ summary: "改了 token 校验的逻辑，见 src/auth.ts" })).toEqual([]);
    // 环境变量、连接串、请求头的写法也认。
    const more = scanSecrets({
      env: "OPENAI_API_KEY=abcd1234efgh5678\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY\nDATABASE_PASSWORD: hunter2hunter2",
      url: "连上 postgres://admin:s3cretpass@db.internal:5432/app 看看",
      header: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'",
      placeholder: "OPENAI_API_KEY=${OPENAI_API_KEY} 或 API_KEY=<your key>",
    });
    expect(more.map((hit) => [hit.field, hit.kind])).toEqual([
      ["env", "assignment"],
      ["env", "assignment"],
      ["env", "assignment"],
      ["url", "url-credentials"],
      ["header", "bearer"],
    ]);
  });

  it("长串不会让检查卡住（规则不回溯成平方级，第二轮复核）", () => {
    const started = performance.now();
    scanSecrets({
      answer: "token_".repeat(4000),
      more: "a".repeat(20000) + "=",
      jwt: "eyJ-".repeat(40000),
      url: "a.".repeat(80000),
      creds: "x://" + "a:".repeat(40000),
    });
    expect(performance.now() - started).toBeLessThan(500);
    // 正例照常命中。
    expect(scanSecrets({ token: "Bearer x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" }).map((hit) => hit.kind)).toEqual(["jwt"]);
  });

  it("要发出去的文字里：工作目录换成相对路径、用户目录换成 ~，别处的文字不动", () => {
    expect(scrubPaths("已新建 [a.js](/work/shop/src/a.js)，见 /work/shop 与 /work/shopping/x、/Users/sue/.npmrc", "/work/shop", "/Users/sue")).toBe(
      "已新建 [a.js](src/a.js)，见 . 与 /work/shopping/x、~/.npmrc",
    );
    // 只换路径的开头：别的路径里恰好含这一段的不动（根目录 /app 时 /srv/app/x 原样）。
    expect(scrubPaths("见 /app/src/a.ts、/srv/app/x 与 `/app`", "/app", "/home/u")).toBe("见 src/a.ts、/srv/app/x 与 `.`");
    // 写成 file:// 或 vscode://file 链接的连同前缀一起换。
    expect(scrubPaths("[a](file:///work/shop/src/a.ts) vscode://file/work/shop/b.ts:3 file:///Users/sue/x", "/work/shop", "/Users/sue")).toBe("[a](src/a.ts) b.ts:3 ~/x");
  });
});

describe("共享对象草稿", () => {
  it("交接包：handoff_submit 起草（时间线记一条草稿卡）；再交覆盖还没发布的那份；参数不对说明哪个字段；子会话、非需求会话不能交", () => {
    const { main, plain, ledger, tools, drafts, ctx } = setup();
    const first = tools.submit(ctx(main.id), { summary: "导出做完一半", todo: ["补测试", "  "], branch: "suduo/REQ-1-codex", extra: "x" });
    expect(text(first)).toContain("交接包草稿「交接：订单导出」已交给用户");
    const [draft] = drafts.listBySession(main.id);
    expect(draft).toMatchObject({ kind: "handoff", status: "draft", remoteRequirementId: "req-1", agentId: "claude-code", secretHits: [] });
    expect(draft!.content).toEqual({ summary: "导出做完一半", decisions: [], todo: ["补测试"], risks: [], branch: "suduo/REQ-1-codex", files: [] });
    tools.submit(ctx(main.id), { summary: "导出做完了，见 /work/shop/src/export.ts", decisions: ["按月分页"] });
    expect(drafts.listBySession(main.id)).toHaveLength(1);
    expect((drafts.listBySession(main.id)[0]!.content as HandoffContent).summary).toBe("导出做完了，见 src/export.ts");
    // 时间线只记卡片要的字段（不把全文一遍遍写进账本）。
    const events = ledger.filter((entry) => entry.type === "shared_draft.updated");
    expect(events).toHaveLength(2);
    expect(Object.keys(events[1]!.payload as object).sort()).toEqual(["id", "kind", "publishedItemId", "secretHitCount", "sessionId", "status", "title", "updatedAt"]);
    // 用户在对话框里改过的那份，Agent 再交时另起一份，不覆盖。
    drafts.update(drafts.listBySession(main.id)[0]!.id, { title: "我改过的标题" });
    tools.submit(ctx(main.id), { summary: "Agent 又交了一版" });
    expect(drafts.listBySession(main.id).map((item) => [item.title, (item.content as HandoffContent).summary])).toEqual([
      ["我改过的标题", "导出做完了，见 src/export.ts"],
      ["交接：订单导出", "Agent 又交了一版"],
    ]);
    expect(first.success).toBe(true);
    expect(text(tools.submit(ctx(main.id), { summary: "" }))).toContain("交接包参数 summary 不对");
    expect(text(tools.submit(ctx(main.id), { summary: "x", todo: "补测试" }))).toContain("交接包参数 todo 不对");
    expect(text(tools.submit(ctx(main.id, { delegateChild: true }), { summary: "x" }))).toContain("不能提交交接包");
    expect(text(tools.submit(ctx(plain.id), { summary: "x" }))).toContain("只有需求会话");
  });

  it("评审报告：从交回了结构化意见的评审生成；会话快照：选定的回合，文件路径换成相对工作目录的", async () => {
    const { main, reviews, rounds, drafts } = setup();
    const review = reviews.create({ targetSessionId: main.id, agentId: "codex", origin: "user", focus: ["correctness"], note: null, now: 1 });
    expect(() => drafts.createReviewDraft(review.id, "zh-CN")).toThrow();
    reviews.update(review.id, { status: "submitted", summary: "两处问题", findings: [{ id: "f1", severity: "high", file: "a.ts", line: 3, title: "空数组", detail: "会抛异常", suggestion: null }] }, 2);
    const report = drafts.createReviewDraft(review.id, "zh-CN");
    expect(report).toMatchObject({ kind: "review", reviewId: review.id, agentId: "codex", title: "评审报告：订单导出" });
    expect(report.content).toEqual({ summary: "两处问题", findings: [{ severity: "high", file: "a.ts", line: 3, title: "空数组", detail: "会抛异常", suggestion: null }], targetAgentId: "claude-code" });
    expect(drafts.latestForReview(review.id)?.id).toBe(report.id);
    // 再点一次「发布到需求」：用这份没发布的草稿，不再新起。
    expect(drafts.createReviewDraft(review.id, "zh-CN").id).toBe(report.id);

    rounds.set(main.id, [
      round({ index: 1, userText: "做导出", answer: "好了", files: [{ path: "/work/shop/src/export.ts", kind: "add", diff: "" }], commands: [{ command: "pnpm test", exitCode: 0, output: "ok" }] }),
      round({ index: 2, userText: "再加分页", answer: null }),
      round({ index: 3, userText: "改文案", files: [{ path: "/elsewhere/x.ts", kind: "update", diff: "" }] }),
    ]);
    const snapshot = drafts.createSnapshot(main.id, [1, 3], "zh-CN");
    expect(snapshot.title).toBe("会话快照：订单导出（第 1、3 轮）");
    expect((snapshot.content as SnapshotContent).rounds).toEqual([
      { userText: "做导出", answer: "好了", files: ["src/export.ts"], commands: [{ command: "pnpm test", exitCode: 0 }], startedAt: 1 },
      { userText: "改文案", answer: null, files: ["/elsewhere/x.ts"], commands: [], startedAt: 1 },
    ]);
    expect(() => drafts.createSnapshot(main.id, [9], "zh-CN")).toThrow();
    // 总大小超过快照上限（1.5 MB）：生成时就说少选几轮（快照内容不能编辑）。
    rounds.set(main.id, Array.from({ length: 100 }, (_, index) => round({ index: index + 1, userText: "x".repeat(19_000) })));
    expect(() => drafts.createSnapshot(main.id, Array.from({ length: 100 }, (_, index) => index + 1), "zh-CN")).toThrow(/少选几轮/u);
    await Promise.resolve();
  });

  it("编辑后重新扫疑似密钥（标题也扫）；发布到需求（来源带 Agent 与会话句柄）；已发布的可以再发一份；丢弃的不能再改再发", async () => {
    const { main, tools, drafts, remote, ctx } = setup();
    tools.submit(ctx(main.id), { summary: "做完了" });
    const draft = drafts.listBySession(main.id)[0]!;
    const edited: SharedDraftDto = drafts.update(draft.id, {
      title: "交接 sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      content: { summary: "密码 password: Zx9Qw8Er7Ty6Ui5Op4As", decisions: [], todo: [], risks: [], branch: null, files: [] },
    });
    expect(edited.secretHits.map((hit) => hit.field)).toEqual(["title", "summary"]);
    expect(() => drafts.update(draft.id, { content: { summary: 1 } })).toThrow();
    // 预览之后草稿变了（Agent 又交了一版）：发布到团队不可逆，不发，带上最新的请人再看（ADR-0004 红线 2）。
    await expect(drafts.publish(draft.id, edited.updatedAt - 1)).rejects.toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    // 编辑时同理：告诉人变了，由人选载入还是覆盖（不带版本就是覆盖）。
    expect(() => drafts.update(draft.id, { title: "x" }, edited.updatedAt - 1)).toThrow(expect.objectContaining({ statusCode: 409 }));
    const published = await drafts.publish(draft.id, edited.updatedAt);
    expect(published).toMatchObject({ status: "published", publishedItemId: "item-1" });
    expect(remote.callsOf("publishSharedItem")[0]).toEqual([
      "req-1",
      expect.objectContaining({ kind: "handoff", title: edited.title, agentId: "claude-code", sessionRef: main.id }),
    ]);
    // 已发布的可以再发一份（比如被团队里别人撤回了）。
    const again = await drafts.publish(draft.id);
    expect(again).toMatchObject({ status: "published", publishedItemId: "item-2" });
    tools.submit(ctx(main.id), { summary: "第二份" });
    const second = drafts.listBySession(main.id).find((item) => item.status === "draft")!;
    // 已发布的不能在本机丢弃（团队服务器上那份还在，会误导）。
    expect(() => drafts.discard(draft.id)).toThrow();
    expect(drafts.discard(second.id).status).toBe("discarded");
    await expect(drafts.publish(second.id)).rejects.toMatchObject({ statusCode: 400 });
    expect(() => drafts.update(second.id, { title: "x" })).toThrow();
  });
});

describe("handoff_read", () => {
  it("手写交接包：新起一份空的（Agent 没有工具时的退路）；summary 没填不能发", async () => {
    const { main, drafts } = setup();
    const manual = drafts.createManualHandoff(main.id, "zh-CN");
    expect(manual).toMatchObject({ kind: "handoff", status: "draft", agentId: null, content: { summary: "" } });
    await expect(drafts.publish(manual.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("列出这条需求上的交接包（含已撤回标记）；读全文带材料提示；已撤回的说明内容不在；别的需求的不读；服务器不支持时说明", async () => {
    const { main, tools, remote, ctx } = setup();
    expect(text(await tools.read(ctx(main.id), {}))).toBe("这条需求上还没有发布的交接包。");
    const base = { kind: "handoff" as const, source: { agentId: "codex", sessionRef: "s-x" }, publishedBy: DEV, publishedAt: "2026-10-08T02:00:00.000Z", sizeBytes: 10, readCount: 0, retractedBy: null };
    remote.sharedItems.push(
      { ...base, id: "h2", requirementId: "req-1", title: "交接：导出", retractedAt: null, content: { summary: "导出做完一半", decisions: ["按月分页"], todo: [], risks: ["时区"], branch: "suduo/REQ-1-codex", files: [] } },
      { ...base, id: "h1", requirementId: "req-1", title: "旧交接", retractedAt: "2026-10-08T03:00:00.000Z", content: null },
      { ...base, id: "h9", requirementId: "req-9", title: "别的需求", retractedAt: null, content: { summary: "x", decisions: [], todo: [], risks: [], branch: null, files: [] } },
    );
    const list = text(await tools.read(ctx(main.id), {}));
    expect(list).toContain("- h2 · 交接：导出 · 陈思远");
    expect(list).toContain("- h1 · 旧交接 · 陈思远");
    expect(list).toContain("已撤回");
    expect(list).not.toContain("h9");
    const full = text(await tools.read(ctx(main.id), { id: "h2" }));
    expect(full).toContain("交接包「交接：导出」（陈思远");
    expect(full).toContain("Codex");
    expect(full.startsWith("以下是同事发布在这条需求上的材料")).toBe(true);
    expect(full).toContain("关键决定：\n- 按月分页");
    expect(full).toContain("分支：suduo/REQ-1-codex");
    expect(list.startsWith("以下是同事发布在这条需求上的材料")).toBe(true);
    expect(text(await tools.read(ctx(main.id), { id: "h1" }))).toContain("已被撤回");
    // 别的需求的交接包：先按列表确认，不去读（也不替那条需求记「读过」）。
    const before = remote.callsOf("getSharedItem").length;
    expect((await tools.read(ctx(main.id), { id: "h9" })).success).toBe(false);
    expect(remote.callsOf("getSharedItem")).toHaveLength(before);
    remote.fail.listSharedItems = new Error("404");
    expect(text(await tools.read(ctx(main.id), {}))).toContain("团队服务器可能还不支持");
  });
});
