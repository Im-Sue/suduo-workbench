import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  JsonValue,
  Locale,
  RespondToolCallInput,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
  SuDuoToolConfirmationDto,
} from "@suduo/client-contracts";
import type { ArtifactVersionDetailDto } from "@suduo/cloud-contracts";
import { ApiError } from "../src/application/api-error.js";
import { ApprovalService } from "../src/application/approval-service.js";
import { EventLedger } from "../src/application/event-ledger.js";
import type { ToolResult } from "../src/application/session-tools/format.js";
import { RequirementTools, describeActivity, type ToolSessionContext } from "../src/application/session-tools/requirement-tools.js";
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
import { WorkspaceMappingRepository } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";
import { mapApprovalDecision } from "../src/infrastructure/runtime/codex/codex-approval-mapper.js";
import { OMITTED_IMAGE_URL, normalizeCodexNotification } from "../src/infrastructure/runtime/codex/codex-event-normalizer.js";
import {
  DEV,
  FakeRequirementsRemote,
  PM,
  activityFixture,
  attachmentFixture,
  commentFixture,
  requirementFixture,
} from "./helpers/fake-requirements-remote.js";

/**
 * 需求相关 SuDuo 工具的回包按会话语言（中英双语 S7）：英文会话拿到英文；人写的内容（中文需求标题、
 * 中文评论、附件名、人名、笔记）原样保留，除此之外没有中文；系统代写的评论按会话语言渲染。
 */

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
const TITLE = "商家端-订单详情优化";
/** 夹具里人写的内容：剔掉它们之后，英文回包里不该再有中文。 */
const HUMAN = [TITLE, "另一个需求", "李娜", "陈思远", "请补充\n收货地址", "请补充 收货地址", "第 1 条评论", "需求问题截图.png", "说明.md", "流程图.png", "旧标题", "新标题", "订单详情弹窗增加客户收货信息。", "结论", "请确认收货地址字段", "设计稿.png"];
const STARTED_AT = "2026-09-25T00:00:00.000Z";

function withoutHuman(text: string): string {
  return HUMAN.reduce((rest, piece) => rest.split(piece).join(""), text);
}

function expectNoFrameworkChinese(text: string): void {
  const rest = withoutHuman(text);
  expect(rest.match(CJK)?.[0] ?? null, rest).toBeNull();
}

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "suduo-tool-reply-en-"));
  temporaryPaths.push(directory);
  return directory;
}

function ctxOf(projectRoot: string, locale: Locale = "en"): ToolSessionContext {
  return {
    sessionId: "session-1",
    locale,
    projectRoot,
    remoteProjectId: "proj-1",
    requirement: { remoteRequirementId: "req-1", startVersion: 2, startedAt: STARTED_AT },
  };
}

function textOf(result: ToolResult | SuDuoToolConfirmationDto): string {
  if (!("contentItems" in result)) {
    throw new Error("expected a tool result, got a confirmation card");
  }
  return result.contentItems.map((item) => (item.type === "inputText" ? item.text : "")).join("\n");
}

function setup() {
  const root = temporaryDirectory();
  const remote = new FakeRequirementsRemote();
  remote.requirements.set(
    "req-2",
    requirementFixture({ id: "req-2", number: 2, title: "另一个需求", version: 1, summary: "x", assignee: null }),
  );
  return { root, remote, tools: new RequirementTools(remote), ctx: ctxOf(root) };
}

function version(id: string, versionNumber: number, files: Array<[string, string]>): ArtifactVersionDetailDto {
  return {
    id,
    requirementId: "req-1",
    versionNumber,
    publishedBy: DEV,
    publishedAt: `2026-09-2${String(versionNumber)}T02:00:00.000Z`,
    fileCount: files.length,
    files: files.map(([fileId, fileName]) => ({
      id: fileId,
      artifactVersionId: id,
      attachmentId: "att-" + fileId,
      fileName,
      sizeBytes: 6,
      sha256: "0".repeat(64),
    })),
  };
}

describe("英文会话：需求只读工具", () => {
  it("requirement_get：框架文字是英文，标题 / 人名 / 正文 / 评论原样；系统评论按英文渲染", async () => {
    const { remote, tools, ctx } = setup();
    remote.activity.set("req-1", [
      activityFixture("a4", "2026-09-28T04:00:00.000Z", {
        action: "comment.created",
        resourceType: "comment",
        changes: [],
        // 旧数据：正文是中文句子，但带了 system，应按会话语言渲染。
        comment: { id: "c2", body: "发布了产物 v1，含 5 个文件。", system: { kind: "artifact_published", params: { versionNumber: 1, fileCount: 5 } } },
      }),
      activityFixture("a3", "2026-09-28T03:00:00.000Z", {
        action: "comment.created",
        resourceType: "comment",
        changes: [],
        comment: { id: "c1", body: "请补充\n收货地址" },
      }),
      activityFixture("a2", "2026-09-27T03:00:00.000Z", {
        action: "requirement.updated",
        changes: [
          { field: "title", from: "旧标题", to: "新标题" },
          { field: "assignee", from: null, to: DEV },
        ],
      }),
      activityFixture("a1", "2026-09-26T03:00:00.000Z"),
    ]);
    const text = textOf(await tools.requirementGet({ ...ctx, requirement: { ...ctx.requirement!, anchorKnown: false } }, {}));
    expect(text.startsWith("The following comes from the SuDuo requirements service.")).toBe(true);
    expect(text).toContain(`# REQ-1 “${TITLE}”`);
    expect(text).toContain("- Status: Draft; Assignee: 陈思远; Current version: v3 (v2 when work started)");
    expect(text).toContain("- 1 comment; 1 attachment (view them with suduo_requirement_comments / suduo_requirement_attachments)");
    expect(text).toContain("## Changes since work started (work started at ");
    expect(text).toContain("- Note: the requirements service's change-log boundary wasn't available");
    expect(text).toContain("李娜 changed the status from “Draft” to “Refining”");
    expect(text).toContain("李娜 changed the title from “旧标题” to “新标题”, changed the assignee from “Unassigned” to “陈思远”");
    expect(text).toContain("李娜 commented: “请补充 收货地址”");
    expect(text).toContain("李娜 commented: “Published confirmed version 1 with 5 files.”");
    expect(text.endsWith("## Description\n订单详情弹窗增加客户收货信息。")).toBe(true);
    expectNoFrameworkChinese(text);
  });

  it("requirement_get：正文太长时存成英文文件名；变化查不到 / 没有变化 / 当前需求查不到", async () => {
    const { root, remote, tools, ctx } = setup();
    remote.requirements.set("req-1", { ...remote.requirements.get("req-1")!, summary: "长".repeat(9_000) });
    const long = textOf(await tools.requirementGet(ctx, {}));
    const saved = join(".suduo", "requirements", `REQ-1-${TITLE}`, "materials", "requirement-description-v3.md");
    expect(long).toContain(`The description has 9000 characters, which is too long. The full text was saved to ${saved}; read that file directly. The beginning:`);
    expect(long).toContain("- No changes since work started.");
    expect(readFileSync(join(root, saved), "utf8")).toBe("长".repeat(9_000));
    expect(long.endsWith("\n…")).toBe(true);

    remote.fail.listRequirementActivity = new ApiError(503, "DEPENDENCY_UNAVAILABLE", "timeout");
    const unavailable = textOf(await tools.requirementGet(ctx, {}));
    expect(unavailable).toContain(
      "- Couldn't look up the changes since work started: The requirements service can't be reached right now (timeout). This doesn't mean there were no changes.",
    );

    remote.fail.getRequirement = new ApiError(401, "AUTH_REQUIRED", "x");
    const failed = await tools.requirementGet(ctx, {});
    expect(failed.success).toBe(false);
    expect(textOf(failed)).toBe(
      "Couldn't look up the current requirement: SuDuo isn't signed in to the requirements service, or the sign-in has expired (ask the user to sign in again in SuDuo settings). This doesn't mean there isn't any. Tell the user plainly that it couldn't be looked up.",
    );
  });

  it("变化太多：只列最近的，英文说明条数", async () => {
    const { remote, tools, ctx } = setup();
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        activityFixture("e" + String(index), new Date(Date.parse("2026-09-29T00:00:00.000Z") - index * 60_000).toISOString()),
      );
    remote.activity.set("req-1", entries(40));
    expect(textOf(await tools.requirementGet(ctx, {}))).toContain("- (40 changes in total; only the latest 30 are listed)\n");
    remote.activity.set("req-1", entries(320));
    expect(textOf(await tools.requirementGet(ctx, {}))).toContain("- (There are many changes; only the latest ones are listed)\n");
  });

  it("参数错误与项目会话", async () => {
    const { root, tools, ctx } = setup();
    expect(textOf(await tools.requirementGet(ctx, { number: { id: 2 } }))).toBe(
      "The number parameter should be a requirement number, e.g. \"REQ-12\" or 12.",
    );
    expect(textOf(await tools.requirementGet(ctx, { number: "第二个" }))).toBe(
      "The requirement number “第二个” isn't in the right format. It should be REQ-12 or 12.",
    );
    expect(textOf(await tools.requirementGet(ctx, { number: "99" }))).toContain("Couldn't look up requirement REQ-99: ");
    expect(textOf(await tools.requirementGet({ ...ctx, requirement: null }, {}))).toBe(
      "This is a project session with no linked requirement. Give a requirement number in the number parameter, e.g. REQ-12.",
    );
    expect(textOf(await tools.attachmentView(ctx, {}))).toBe("Missing parameter attachmentId.");
    expect(textOf(await tools.notesSave(ctxOf(root), {}, () => undefined, () => undefined))).toBe("Missing parameter content.");
  });

  it("comments：翻页提示、截断、发布说明；中文评论原样，系统评论按英文（不用存下的正文）", async () => {
    const { remote, tools, ctx } = setup();
    expect(textOf(await tools.requirementComments(ctx, {}))).toBe(`REQ-1 “${TITLE}” has no comments yet.`);
    remote.comments.set(
      "req-1",
      Array.from({ length: 22 }, (_, index) =>
        commentFixture(
          index + 1,
          index === 1
            ? { body: "长".repeat(3_000) }
            : index === 20
              ? { artifactVersionId: "ver-2", body: "Published confirmed version 2 with 3 files.", system: { kind: "artifact_published", params: { versionNumber: 2, fileCount: 3 } } }
              : index === 21
                ? { artifactVersionId: "ver-1", body: "请确认收货地址字段" }
                : {},
        ),
      ),
    );
    const first = textOf(await tools.requirementComments(ctx, {}));
    expect(first).toContain(`Comments on REQ-1 “${TITLE}” (20 on this page; next page: cursor=20):`);
    expect(first).toContain("\n第 1 条评论");
    expect(first).toContain("… (This comment has 3000 characters; the rest is cut off. For the full text, ask the user to view it on the requirement page.)");
    expect(first.endsWith("Next page: cursor=20")).toBe(true);
    expect(withoutHuman(first.replace(/第 \d+ 条评论/gu, "").replace(/长+/gu, "")).match(CJK)).toBeNull();

    const second = textOf(await tools.requirementComments(ctx, { cursor: "20" }));
    expect(second).toContain("(2 on this page; this is the last page):");
    expect(second).toContain(" (publish note for a confirmed version)\nPublished confirmed version 2 with 3 files.");
    expect(second).toContain(" (publish note for a confirmed version)\n请确认收货地址字段");
    expect(second.endsWith("This is the last page.")).toBe(true);
    expectNoFrameworkChinese(second);

    remote.fail.listComments = new ApiError(404, "NOT_FOUND", "x");
    expect(textOf(await tools.requirementComments(ctx, {}))).toBe(
      `Couldn't look up the comments on REQ-1 “${TITLE}”: It doesn't exist in the requirements service (it may have been deleted, or the number may be wrong). This doesn't mean there isn't any. Tell the user plainly that it couldn't be looked up.`,
    );
  });

  it("中文会话：系统评论按中文渲染，不用存下的英文兜底正文", async () => {
    const { remote, tools, root } = setup();
    remote.comments.set("req-1", [
      commentFixture(1, {
        artifactVersionId: "ver-2",
        body: "Published confirmed version 2 with 3 files.",
        system: { kind: "artifact_published", params: { versionNumber: 2, fileCount: 3 } },
      }),
    ]);
    const text = textOf(await tools.requirementComments(ctxOf(root, "zh-CN"), {}));
    expect(text).toContain("（确认版发布说明）\n发布了产物 v2，含 3 个文件。");
    expect(text).not.toContain("Published confirmed version");
  });

  it("attachments / attachment_view：英文说明，附件名与内容原样", async () => {
    const { root, remote, tools, ctx } = setup();
    expect(textOf(await tools.requirementAttachments(ctx, {}))).toBe(`REQ-1 “${TITLE}” has no attachments.`);
    remote.attachments.set("req-1", [
      attachmentFixture({ id: "att-md", fileName: "说明.md", contentType: "text/markdown", sizeBytes: 30 }),
      attachmentFixture({ id: "att-pdf", fileName: "..", contentType: "application/pdf", sizeBytes: 8 }),
    ]);
    remote.attachmentContent.set("att-md", Buffer.from("# 结论"));
    remote.attachmentContent.set("att-pdf", Buffer.from("%PDF-1.7"));
    const list = textOf(await tools.requirementAttachments(ctx, {}));
    expect(list).toContain(`Attachments of REQ-1 “${TITLE}” (2 attachments; view their content with suduo_attachment_view):`);
    expectNoFrameworkChinese(list);

    const markdown = textOf(await tools.attachmentView(ctx, { attachmentId: "att-md" }));
    expect(markdown).toMatch(/^Attachment “说明\.md” \(text\/markdown, 30B, uploaded by 李娜 at .+\)\nThe following comes from the SuDuo requirements service/u);
    expect(markdown.endsWith("\n\n# 结论")).toBe(true);
    expectNoFrameworkChinese(markdown);

    // 文件名清理后为空：兜底名按会话语言。
    const pdf = textOf(await tools.attachmentView(ctx, { attachmentId: "att-pdf" }));
    const saved = join(".suduo", "requirements", `REQ-1-${TITLE}`, "materials", "attachment");
    expect(pdf).toContain(`\nSaved in the project at ${saved}. You can read that file directly.`);
    expect(existsSync(join(root, saved))).toBe(true);

    expect(textOf(await tools.attachmentView(ctx, { attachmentId: "att-x" }))).toBe(
      `REQ-1 “${TITLE}” has no attachment with ID att-x (it may have been deleted, or it belongs to another requirement). First check the attachment list with suduo_requirement_attachments.`,
    );
    remote.fail.downloadAttachment = new ApiError(503, "DEPENDENCY_UNAVAILABLE", "reset");
    expect(textOf(await tools.attachmentView(ctx, { attachmentId: "att-md" }))).toContain(
      "Couldn't look up the content of attachment “说明.md”: The requirements service can't be reached right now (reset).",
    );
  });

  it("artifact_versions / artifact_fetch：英文说明，保存目录用英文名", async () => {
    const { root, remote, tools, ctx } = setup();
    expect(textOf(await tools.artifactVersions(ctx, {}))).toBe(`No confirmed version of REQ-1 “${TITLE}” has been published yet.`);
    remote.versions.set("req-1", [
      version("ver-1", 1, [["f1", "旧.md"]]),
      version("ver-2", 2, [["f2", "PRD.md"], ["f3", "流程图.png"]]),
    ]);
    remote.versionFileContent.set("f2", Buffer.from("PRD v2"));
    remote.versionFileContent.set("f3", Buffer.from("png"));
    const list = textOf(await tools.artifactVersions(ctx, {}));
    expect(list).toContain(`Confirmed versions of REQ-1 “${TITLE}” (2, newest first):`);
    expect(list).toMatch(/## v2 · 陈思远 · .+ \(2 files\)\n- PRD\.md \(6B\)\n- 流程图\.png \(6B\)/u);
    expect(list).toMatch(/## v1 · 陈思远 · .+ \(1 file\)/u);
    expect(list.endsWith("To read the files, use suduo_artifact_fetch to save a version locally.")).toBe(true);
    expectNoFrameworkChinese(list.replace("旧.md", ""));

    const fetched = textOf(await tools.artifactFetch(ctx, { version: 2 }));
    const dir = join(".suduo", "requirements", `REQ-1-${TITLE}`, "materials", "confirmed-version-v2");
    expect(fetched).toMatch(new RegExp(`^Saved confirmed version v2 of REQ-1 “${TITLE}” \\(陈思远, .+\\) to ${dir.replace(/[.\\/]/gu, "\\$&")}/:`, "u"));
    expect(readFileSync(join(root, dir, "PRD.md"), "utf8")).toBe("PRD v2");

    expect(textOf(await tools.artifactFetch(ctx, { version: "x" }))).toBe("version must be a positive integer, e.g. 2.");
    expect(textOf(await tools.artifactFetch(ctx, { version: 9 }))).toBe(
      `REQ-1 “${TITLE}” has no confirmed version v9 (existing: v1, v2).`,
    );
    remote.fail.getArtifactVersion = new ApiError(503, "DEPENDENCY_UNAVAILABLE", "timeout");
    expect(textOf(await tools.artifactVersions(ctx, {}))).toContain(
      "- Couldn't look up the file list (the requirements service is unavailable right now). You can try again later.",
    );
    expect(textOf(await tools.artifactFetch(ctx, { version: 2 }))).toContain("Couldn't look up the file list of confirmed version v2: ");
  });

  it("notes：英文说明，笔记内容原样", async () => {
    const { tools, ctx } = setup();
    const memory = new Map<string, string | null>();
    const remember = (id: string, sha: string | null) => {
      memory.set(id, sha);
    };
    const lastRead = (id: string) => (memory.has(id) ? memory.get(id) : undefined);
    const notesPath = join(".suduo", "requirements", `REQ-1-${TITLE}`, "notes.md");
    expect(textOf(await tools.notesRead(ctx, {}, remember))).toBe(
      `REQ-1 “${TITLE}” has no conclusion notes on this computer yet (${notesPath}).`,
    );
    expect(textOf(await tools.notesSave(ctx, { content: "# 结论" }, lastRead, remember))).toBe(
      `Updated the conclusion notes of REQ-1 “${TITLE}”: ${notesPath} (on this computer only; not shared automatically).`,
    );
    memory.set("req-1", "stale");
    const changed = textOf(await tools.notesSave(ctx, { content: "# 结论\n- 入口" }, lastRead, remember));
    expect(changed).toContain("\nThe old content was archived: ");
    expect(changed).toContain(
      "\nNote: after you last read them, the notes were changed by the user or another session; the old content was archived. Tell the user, and confirm that this write didn't drop what they added.",
    );
    expect(textOf(await tools.notesRead(ctx, {}, remember))).toBe(`Conclusion notes of REQ-1 “${TITLE}” (${notesPath}):\n\n# 结论\n- 入口`);
    await tools.notesSave(ctx, { content: "x".repeat(12_000) }, lastRead, remember);
    expect(textOf(await tools.notesRead(ctx, {}, remember))).toBe(
      `The conclusion notes of REQ-1 “${TITLE}” have 12000 characters, which is too long to show here. Read the full text of the file ${notesPath} directly; to update them, revise on top of the full text and write the whole thing back with suduo_notes_save.`,
    );
  });
});

describe("英文会话：对外写工具（确认卡与执行结果）", () => {
  it("准备阶段的报错", async () => {
    const { root, tools, ctx } = setup();
    expect(textOf(await tools.prepareComment(ctx, { body: " " }))).toBe("The comment can't be empty.");
    expect(textOf(await tools.prepareComment(ctx, { body: "x".repeat(4_001) }))).toBe(
      "A comment can be at most 4000 characters; this one is 4001 characters. Shorten it before sending.",
    );
    expect(textOf(await tools.prepareComment({ ...ctx, requirement: null }, { body: "hi" }))).toBe(
      "Only a session created from a requirement can post comments or publish confirmed versions.",
    );
    expect(textOf(await tools.preparePublish(ctx, {}))).toBe(
      "Give at least one file to publish: paths (files in the project) or attachmentIds (existing attachments).",
    );
    expect(textOf(await tools.preparePublish(ctx, { paths: ["nope.md"] }))).toBe(
      "Couldn't find the file nope.md in the project (the path must be relative to the project folder and must be a file).",
    );
    expect(textOf(await tools.preparePublish(ctxOf(root), { attachmentIds: ["att-x"] }))).toBe(
      `REQ-1 “${TITLE}” has no attachment with ID att-x.`,
    );
  });

  it("发评论：成功、4xx「没发出」、其他失败「结果未确认，核对前不要重发」，英文同样明确", async () => {
    const { remote, tools, ctx } = setup();
    const card = (await tools.prepareComment(ctx, { body: "请确认收货地址字段" })) as SuDuoToolConfirmationDto;
    const ok = textOf(await tools.executeWrite(ctx, card, "approval-1"));
    expect(ok).toMatch(new RegExp(`^Posted the comment to REQ-1 “${TITLE}” \\(陈思远, .+, comment ID comment-new-1\\)\\.$`, "u"));
    const untitled = textOf(await tools.executeWrite(ctx, { ...card, requirement: { ...card.requirement, number: null } }, "approval-1b"));
    expect(untitled.startsWith(`Posted the comment to requirement “${TITLE}” (`)).toBe(true);

    remote.fail.createComment = new ApiError(422, "VALIDATION_ERROR", "Comment is invalid");
    expect(textOf(await tools.executeWrite(ctx, card, "approval-2"))).toBe("Couldn't post the comment: Comment is invalid.");

    remote.fail.createComment = new TypeError("fetch failed");
    expect(textOf(await tools.executeWrite(ctx, card, "approval-3"))).toBe(
      "The result of posting the comment is unconfirmed: fetch failed. Ask the user to check on the requirement page whether it was posted. Don't post it again before they check.",
    );
  });

  it("发布确认版：确认后改过的文件、部分已上传、文件不见了、结果未确认", async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "PRD.md"), "# PRD");
    writeFileSync(join(root, "docs", "B.md"), "# B");
    const remote = new FakeRequirementsRemote();
    remote.attachments.set("req-1", [attachmentFixture({ id: "att-1", fileName: "设计稿.png", contentType: "image/png", sizeBytes: 900 })]);
    const tools = new RequirementTools(remote);
    const ctx = ctxOf(root);
    const card = (await tools.preparePublish(ctx, { paths: ["docs/PRD.md", "docs/B.md"], attachmentIds: ["att-1"] })) as SuDuoToolConfirmationDto;

    writeFileSync(join(root, "docs", "PRD.md"), "# PRD changed after confirm");
    const published = textOf(await tools.executeWrite(ctx, card, "approval-9"));
    expect(published).toMatch(new RegExp(`^Published confirmed version v3 of REQ-1 “${TITLE}” \\(3 files, .+\\)\\.\\n`, "u"));
    expect(published).toContain(
      "\nNote: these files changed after the user confirmed, and the latest content was published. Tell the user: docs/PRD.md (5B when confirmed, 27B when published).",
    );
    expectNoFrameworkChinese(published);

    remote.fail.publishArtifactVersion = new TypeError("socket hang up");
    const unknown = textOf(await tools.executeWrite(ctx, card, "approval-10"));
    expect(unknown).toBe(
      "The result of publishing the confirmed version is unconfirmed: socket hang up. Ask the user to check on the requirement page whether it was published. Don't publish it again before they check." +
        "\nFiles already uploaded as requirement attachments, but the confirmed version wasn't published: PRD.md (attachment ID att-uploaded-3); B.md (attachment ID att-uploaded-4). " +
        "These attachments stay on the requirement; when you retry, you can put their attachment IDs in attachmentIds to publish them directly without uploading again.",
    );

    remote.fail.publishArtifactVersion = new ApiError(409, "VALIDATION_ERROR", "Attachment was deleted");
    expect(textOf(await tools.executeWrite(ctx, card, "approval-11"))).toContain(
      "Couldn't publish the confirmed version: Attachment was deleted.\nFiles already uploaded",
    );

    rmSync(join(root, "docs", "B.md"));
    expect(textOf(await tools.executeWrite(ctx, card, "approval-12"))).toContain(
      "The project file docs/B.md can no longer be found (it may have been moved or deleted after it was confirmed), so the confirmed version wasn't published.",
    );
    expect(textOf(await tools.executeWrite(ctx, { ...card, publish: undefined } as unknown as SuDuoToolConfirmationDto, "a"))).toBe(
      "The confirmation card is incomplete, so nothing was done.",
    );
  });
});

describe("describeActivity（P1 需求卡也用）", () => {
  it("英文按会话语言，人写的标题 / 文件名 / 评论原样；系统评论按语言渲染", () => {
    const at = "2026-09-28T00:00:00.000Z";
    const en = (overrides: Parameters<typeof activityFixture>[2]) => describeActivity(activityFixture("x", at, overrides), "en");
    expect(en({ action: "requirement.created", changes: [] })).toBe("created the requirement");
    expect(en({ action: "attachment.created", changes: [], attachment: { id: "a", fileName: "设计稿.png" } })).toBe("uploaded attachment “设计稿.png”");
    expect(en({ action: "attachment.deleted", changes: [], attachment: { id: "a", fileName: "设计稿.png" } })).toBe("deleted attachment “设计稿.png”");
    expect(en({ action: "artifact_version.published", changes: [], artifactVersion: { id: "v", versionNumber: 4, fileCount: 1, note: null } })).toBe(
      "published confirmed version v4 (1 file)",
    );
    expect(en({ action: "artifact_version.published", changes: [], artifactVersion: null })).toBe("published confirmed version v? (0 files)");
    expect(
      en({
        action: "requirement.updated",
        changes: [
          { field: "summary", from: "a", to: "b" },
          { field: "status", from: "in_testing", to: "completed" },
          { field: "assignee", from: PM, to: null },
        ],
      }),
    ).toBe(
      "edited the description (see the current description above), changed the status from “In testing” to “Done”, changed the assignee from “李娜” to “Unassigned”",
    );
    expect(en({ action: "requirement.updated", changes: [] })).toBe("updated the requirement");
    expect(en({ action: "comment.created", changes: [], comment: { id: "c", body: "长".repeat(100) } })).toBe(
      `commented: “${"长".repeat(80)}\n… (truncated)”`,
    );
    const system = { id: "c", body: "Published confirmed version 2 with 3 files.", system: { kind: "artifact_published" as const, params: { versionNumber: 2, fileCount: 3 } } };
    expect(en({ action: "comment.created", changes: [], comment: system })).toBe("commented: “Published confirmed version 2 with 3 files.”");
    expect(describeActivity(activityFixture("x", at, { action: "comment.created", changes: [], comment: system }), "zh-CN")).toBe(
      "发了评论：「发布了产物 v2，含 3 个文件。」",
    );
  });
});

// ───────────────────────────── 工具调度（SessionToolService） ─────────────────────────────

const RUNTIME_ID = "codex-local";
const THREAD_REF = { runtimeId: RUNTIME_ID, runtimeKind: "codex", threadId: "thread-1" };
const ORPHAN_THREAD_REF = { runtimeId: RUNTIME_ID, runtimeKind: "codex", threadId: "thread-2" };
const ROOM_THREAD_REF = { runtimeId: RUNTIME_ID, runtimeKind: "codex", threadId: "thread-3" };

class RecordingRuntime implements AgentRuntime {
  readonly runtimeId = RUNTIME_ID;
  readonly runtimeKind = "codex";
  readonly responses: RespondToolCallInput[] = [];
  isToolCallPending(): boolean {
    return true;
  }
  async startThread(): Promise<StartThreadResult> {
    throw new Error("unused");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("unused");
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {}
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
  async respondToolCall(input: RespondToolCallInput): Promise<{ delivered: boolean }> {
    this.responses.push(input);
    return { delivered: true };
  }
}

function serviceSetup(options: { withSessions: boolean }) {
  const root = temporaryDirectory();
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const mappings = new WorkspaceMappingRepository(database);
  const refs = new RequirementSessionRefRepository(database);
  const approvals = new ApprovalRepository(database);
  const ledger = new EventLedger(database, new EventRepository(database), approvals, { publish: () => undefined });
  const project = projects.create({ name: "商家端", rootPath: root, rootPathKey: root });
  const session = sessions.create({ projectId: project.id, title: "REQ-1 session", locale: "en" });
  threads.attach({ sessionId: session.id, threadRef: THREAD_REF });
  refs.create({
    sessionId: session.id,
    remoteProjectId: "proj-1",
    remoteRequirementId: "req-1",
    requirementVersion: 2,
    requirementNumber: 1,
    requirementTitle: TITLE,
  });
  // 没有关联远程项目的英文会话。
  const otherRoot = join(root, "other");
  mkdirSync(otherRoot);
  const otherProject = projects.create({ name: "local", rootPath: otherRoot, rootPathKey: otherRoot });
  const orphan = sessions.create({ projectId: otherProject.id, title: "plain", locale: "en" });
  threads.attach({ sessionId: orphan.id, threadRef: ORPHAN_THREAD_REF });
  // 房间任务会话（英文所有者）：只挂只读工具。
  const roomSession = sessions.create({ projectId: project.id, title: "room task", locale: "en", kind: "room_task" });
  threads.attach({ sessionId: roomSession.id, threadRef: ROOM_THREAD_REF });
  const roomTasks = {
    getBySessionId: (sessionId: string) =>
      sessionId === roomSession.id
        ? {
            agentId: "agent-1",
            roomId: "room-1",
            threadRootId: "root-1",
            sessionId,
            remoteProjectId: "proj-1",
            roomName: "Checkout",
            requirementId: null,
            requirementVersion: null,
            lastTriggerSeq: 0,
            lastRunId: null,
            createdAt: Date.parse(STARTED_AT),
          }
        : null,
  };

  const runtime = new RecordingRuntime();
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const remote = new FakeRequirementsRemote();
  const service = new SessionToolService({
    runtimes: registry,
    threads,
    approvals,
    ledger,
    context: new SessionContextService({ sessions, projects, mappings, refs, remote, roomTasks }),
    tools: new RequirementTools(remote),
    // 不接会话记录时用查不到记录的替身：退回 FALLBACK_LOCALE。
    sessions: options.withSessions ? sessions : { getById: () => null },
    log: () => undefined,
  });
  const approvalService = new ApprovalService(approvals, threads, registry, ledger);
  approvalService.setToolConfirmationHandler(service);

  let ordinal = 0;
  const call = (tool: string, args: JsonValue, threadRef = THREAD_REF): string => {
    ordinal += 1;
    const callRef = "call-ref-" + String(ordinal);
    service.handle({
      source: "runtime:" + RUNTIME_ID,
      type: "tool.call-requested",
      payload: { callRef, connectionId: "connection-1", requestId: String(ordinal), callId: "call-" + String(ordinal), turnId: "turn-1", tool, arguments: args },
      threadRef,
      turnRef: { threadId: threadRef.threadId, turnId: "turn-1" },
      ts: Date.now(),
      dedupeKey: "connection-1:" + String(ordinal),
    });
    return callRef;
  };
  const responseOf = async (callRef: string): Promise<string> => {
    await vi.waitFor(() => {
      expect(runtime.responses.some((response) => response.callRef === callRef)).toBe(true);
    });
    const response = runtime.responses.find((item) => item.callRef === callRef)!;
    return response.contentItems.map((item) => (item.type === "inputText" ? item.text : "")).join("\n");
  };
  const pendingApprovalOf = async (callRef: string) => {
    await vi.waitFor(() => {
      expect(approvals.listBySession(session.id).some((approval) => approval.runtimeApprovalRef === callRef)).toBe(true);
    });
    return approvals.listBySession(session.id).find((approval) => approval.runtimeApprovalRef === callRef)!;
  };
  return { service, approvalService, approvals, runtime, remote, call, responseOf, pendingApprovalOf };
}

describe("英文会话：工具调度", () => {
  it("只读工具按会话语言回包；未知工具英文", async () => {
    const { call, responseOf } = serviceSetup({ withSessions: true });
    expect(await responseOf(call("suduo_requirement_get", {}))).toContain(`# REQ-1 “${TITLE}”`);
    expect(await responseOf(call("suduo_nope", {}))).toBe("SuDuo has no tool named suduo_nope.");
    expect(await responseOf(call("suduo_room_history", {}))).toBe("Room tools are unavailable right now.");
  });

  it("没关联项目的会话：按会话记录的语言回包；查不到会话记录时退回中文（与存量会话的默认一致）", async () => {
    const withSessions = serviceSetup({ withSessions: true });
    expect(await withSessions.responseOf(withSessions.call("suduo_requirement_get", {}, ORPHAN_THREAD_REF))).toBe(
      "This session isn't linked to a SuDuo project, so it can't use suduo tools.",
    );
    const without = serviceSetup({ withSessions: false });
    expect(await without.responseOf(without.call("suduo_requirement_get", {}, ORPHAN_THREAD_REF))).toBe(
      "这个会话没有关联 SuDuo 项目，不能使用 suduo 工具。",
    );
  });

  it("确认卡：拒绝、执行成功与失败的回包是英文；审批结果里的 message 同样是英文", async () => {
    const { call, pendingApprovalOf, approvalService, approvals, runtime, remote } = serviceSetup({ withSessions: true });
    const declined = await pendingApprovalOf(call("suduo_comment_submit", { body: "请确认收货地址字段" }));
    await approvalService.decide(declined.id, { decision: "decline" });
    expect(runtime.responses.at(-1)?.contentItems).toEqual([
      { type: "inputText", text: "The user didn't approve, so the comment wasn't posted." },
    ]);

    remote.fail.createComment = new ApiError(503, "DEPENDENCY_UNAVAILABLE", "timeout");
    const failing = await pendingApprovalOf(call("suduo_comment_submit", { body: "再发一次" }));
    await approvalService.decide(failing.id, { decision: "accept" });
    const message =
      "The result of posting the comment is unconfirmed: The requirements service can't be reached right now (timeout). Ask the user to check on the requirement page whether it was posted. Don't post it again before they check.";
    expect(runtime.responses.at(-1)?.contentItems).toEqual([{ type: "inputText", text: message }]);
    const outcome = (approvals.getById(failing.id)!.decisionPayload as { outcome: { message: string } }).outcome;
    expect(outcome.message).toBe(message);
  });

  it("房间任务会话调清单外的工具：只读限制的说明是英文", async () => {
    const { call, responseOf } = serviceSetup({ withSessions: true });
    expect(await responseOf(call("suduo_notes_save", { content: "x" }, ROOM_THREAD_REF))).toBe(
      "A shared agent in a room can only use read-only tools; it can't call suduo_notes_save.",
    );
  });
});

// ───────────────────────────── 拿不到会话语言的三处（可见变化） ─────────────────────────────

describe("拿不到会话语言的地方：英文或与语言无关", () => {
  it("旧式审批的拒绝原因回给 Codex 是英文", () => {
    expect(mapApprovalDecision("execCommandApproval", "decline")).toEqual({
      decision: { denied: { rejection: "The user declined this action." } },
    });
  });

  it("账本里的工具结果：图片占位是英文数据标记，截断只接省略号", () => {
    const event = normalizeCodexNotification({
      runtimeId: "codex-local",
      connectionId: "connection-a",
      ordinal: 1,
      message: {
        kind: "notification",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "dynamicToolCall",
            id: "item-1",
            tool: "suduo_attachment_view",
            contentItems: [
              { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
              { type: "inputText", text: "x".repeat(5_000) },
            ],
          },
        },
      },
    });
    const item = (event.payload as { item: { contentItems: Array<Record<string, string>> } }).item;
    expect(OMITTED_IMAGE_URL).toBe("[image omitted]");
    expect(item.contentItems[0]).toEqual({ type: "inputImage", imageUrl: "[image omitted]" });
    expect(item.contentItems[1]?.["text"]).toBe("x".repeat(4_000) + "\n…");
  });
});
