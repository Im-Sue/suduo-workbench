import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AttachmentMutationResponse,
  type CommentDto,
  type CommentFileDto,
  type ListAttachmentsResponse,
  type ListCommentsResponse,
  type ListRequirementActivityResponse,
  type RequirementDto,
  type RequirementsEventDto,
} from "@suduo/cloud-contracts";
import { AttachmentService } from "../src/application/attachment-service.js";
import { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import { AuthService } from "../src/application/auth-service.js";
import { CollaborationService } from "../src/application/collaboration-service.js";
import { CommentFileService } from "../src/application/comment-file-service.js";
import { RequirementsEventHub } from "../src/application/event-hub.js";
import { ROOM_FILE_ROOT_MARKER } from "../src/application/rooms/constants.js";
import type { RequirementsServiceConfig } from "../src/config.js";
import { buildHttpServer } from "../src/http/server.js";
import { ArtifactVersionRepository } from "../src/infrastructure/artifact-version-repository.js";
import { AttachmentRepository } from "../src/infrastructure/attachment-repository.js";
import { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import { CollaborationRepository } from "../src/infrastructure/collaboration-repository.js";
import { CommentFileRepository } from "../src/infrastructure/comment-file-repository.js";
import { Database } from "../src/infrastructure/database.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { LocalDiskBlobStore } from "../src/infrastructure/storage/local-disk-blob-store.js";
import { UserRepository } from "../src/infrastructure/user-repository.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";
import { createProject, createRequirement, createUser, type RoomsTestContext, type TestUser } from "./rooms-test-support.js";

/** 评论文件（需求附件评论文件与优先级 S3）：上传、随评论发出、只有文件的评论、下载、存为附件。 */

const PG_CONFIG = { host: "127.0.0.1", port: 15_432, user: "suduo" };
const DATABASE = `suduo_comment_files_${randomUUID().replaceAll("-", "")}`;
const MAX_FILE_BYTES = 64;
const ALLOWED = new Set([".txt", ".png", ".zip"]);
/** 附件上限压小，好测「存为附件」到顶。 */
const MAX_ATTACHMENTS = 3;

let pool: Pool;
let server: Awaited<ReturnType<typeof buildHttpServer>>;
let attachments: AttachmentService;
let roots: string[] = [];
let databaseCreated = false;
const events: RequirementsEventDto[] = [];
let context: RoomsTestContext;

beforeAll(async () => {
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${DATABASE}"`);
    databaseCreated = true;
  } finally {
    await admin.end();
  }
  pool = ignoreTerminatedConnections(new Pool({ ...PG_CONFIG, database: DATABASE }));
  await runMigrations(pool);
  const database = new Database(pool);
  const attachmentRoot = await mkdtemp(join(tmpdir(), "suduo-comment-files-attachments-"));
  const roomFileRoot = await mkdtemp(join(tmpdir(), "suduo-comment-files-rooms-"));
  roots = [attachmentRoot, roomFileRoot];
  const blobStore = new LocalDiskBlobStore(roomFileRoot, ROOM_FILE_ROOT_MARKER);
  await blobStore.initialize();
  const artifactRepository = new ArtifactVersionRepository(database);
  const attachmentStorage = new AttachmentStorage(attachmentRoot, 1_024, ALLOWED);
  attachments = new AttachmentService(
    new AttachmentRepository(database, MAX_ATTACHMENTS),
    attachmentStorage,
    artifactRepository,
  );
  await attachments.initialize();
  const hub = new RequirementsEventHub();
  hub.subscribe((event) => events.push(event));
  server = await buildHttpServer({
    config: testConfig(attachmentRoot),
    database,
    auth: new AuthService(new UserRepository(database)),
    collaboration: new CollaborationService(new CollaborationRepository(database)),
    attachments,
    artifactVersions: new ArtifactVersionService(artifactRepository),
    attachmentStorage,
    events: hub,
    commentFiles: new CommentFileService(new CommentFileRepository(database), blobStore, attachments, ALLOWED, MAX_FILE_BYTES),
  });
  context = { pool, server } as unknown as RoomsTestContext;
});

afterAll(async () => {
  await server?.close();
  await attachments?.close();
  await pool?.end();
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  if (!databaseCreated) return;
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE "${DATABASE}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

beforeEach(() => {
  events.length = 0;
});

function multipart(fileName: string, content: Buffer) {
  const boundary = `----suduo-comment-${randomUUID()}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function upload(user: TestUser, requirementId: string, fileName: string, content: Buffer) {
  const body = multipart(fileName, content);
  return server.inject({
    method: "POST",
    url: `/v2/requirements/${requirementId}/comment-files`,
    headers: { ...user.headers, "content-type": body.contentType },
    payload: body.payload,
  });
}

async function uploaded(user: TestUser, requirementId: string, fileName: string, content = Buffer.from(fileName)): Promise<CommentFileDto> {
  const response = await upload(user, requirementId, fileName, content);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<CommentFileDto>();
}

function postComment(user: TestUser, requirementId: string, payload: Record<string, unknown>) {
  return server.inject({ method: "POST", url: `/v2/requirements/${requirementId}/comments`, headers: user.headers, payload });
}

async function setupRequirement(name: string): Promise<{ user: TestUser; requirement: RequirementDto }> {
  const user = await createUser(context, name);
  const project = await createProject(context, user, `${name}的项目`);
  const requirement = await createRequirement(context, user, project.id, { title: `${name}的需求` });
  return { user, requirement };
}

describe("评论文件：上传", () => {
  it("按扩展名定类型与种类；还没挂到评论上；不允许的类型 400；超限 413；需求不存在 404", async () => {
    const { user, requirement } = await setupRequirement("上传人");
    const png = Buffer.from("png-bytes");
    const file = await uploaded(user, requirement.id, "报错截图.png", png);
    expect(file).toMatchObject({
      requirementId: requirement.id,
      commentId: null,
      fileName: "报错截图.png",
      contentType: "image/png",
      kind: "image",
      sizeBytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
      uploadedBy: { id: user.id, displayName: "上传人" },
    });
    expect((await upload(user, requirement.id, "tool.exe", Buffer.from("MZ"))).statusCode).toBe(400);
    expect((await upload(user, requirement.id, "big.txt", Buffer.alloc(MAX_FILE_BYTES + 1, 1))).statusCode).toBe(413);
    expect((await upload(user, requirement.id, "edge.txt", Buffer.alloc(MAX_FILE_BYTES, 1))).statusCode).toBe(201);
    expect((await upload(user, randomUUID(), "a.txt", Buffer.from("a"))).statusCode).toBe(404);
    const meta = await server.inject({ method: "GET", url: `/v2/comment-files/${file.id}`, headers: user.headers });
    expect(meta.json<CommentFileDto>()).toEqual(file);
  });
});

describe("评论文件：随评论发出", () => {
  it("按传入顺序挂上（去重）；评论、评论列表、活动都带出文件；审计记下文件；推 comment.created", async () => {
    const { user, requirement } = await setupRequirement("发评论的人");
    const first = await uploaded(user, requirement.id, "日志.txt");
    const second = await uploaded(user, requirement.id, "截图.png");
    events.length = 0;
    const response = await postComment(user, requirement.id, { body: "  导出按钮点了没反应  ", fileIds: [second.id, first.id, second.id] });
    expect(response.statusCode, response.body).toBe(201);
    const comment = response.json<CommentDto>();
    expect(comment.body).toBe("导出按钮点了没反应");
    expect(comment.system).toBeUndefined();
    expect(comment.files?.map((file) => [file.id, file.commentId])).toEqual([
      [second.id, comment.id],
      [first.id, comment.id],
    ]);
    expect(events.map((event) => event.type)).toEqual(["comment.created"]);

    const list = (await server.inject({ method: "GET", url: `/v2/requirements/${requirement.id}/comments`, headers: user.headers }))
      .json<ListCommentsResponse>();
    expect(list.items[0]?.files?.map((file) => file.fileName)).toEqual(["截图.png", "日志.txt"]);
    const activity = (await server.inject({ method: "GET", url: `/v2/requirements/${requirement.id}/activity`, headers: user.headers }))
      .json<ListRequirementActivityResponse>();
    const entry = activity.items.find((item) => item.action === "comment.created");
    expect(entry?.comment?.files?.map((file) => file.fileName)).toEqual(["截图.png", "日志.txt"]);
    const audit = await pool.query<{ after_json: Record<string, unknown> }>(
      "SELECT after_json FROM audit_logs WHERE action = 'comment.created' AND resource_id = $1",
      [comment.id],
    );
    expect(audit.rows[0]?.after_json["files"]).toEqual([
      { id: second.id, fileName: "截图.png" },
      { id: first.id, fileName: "日志.txt" },
    ]);

    // 没有文件的评论：照旧，files 为空数组。
    const plain = await postComment(user, requirement.id, { body: "只有文字" });
    expect(plain.json<CommentDto>().files).toEqual([]);
  });

  it("文件已随别的评论发出、属于别的需求、不存在：400，评论不会建出来（整个事务回滚）", async () => {
    const { user, requirement } = await setupRequirement("挂错文件的人");
    const other = await setupRequirement("别人");
    const sent = await uploaded(user, requirement.id, "已发.txt");
    expect((await postComment(user, requirement.id, { body: "第一次", fileIds: [sent.id] })).statusCode).toBe(201);
    const fresh = await uploaded(user, requirement.id, "新的.txt");
    const foreign = await uploaded(other.user, other.requirement.id, "别处.txt");
    for (const fileIds of [[sent.id], [fresh.id, foreign.id], [randomUUID()]]) {
      const response = await postComment(user, requirement.id, { body: "重发", fileIds });
      expect(response.statusCode, JSON.stringify(fileIds)).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    const comments = await pool.query("SELECT count(*)::integer AS count FROM requirement_comments WHERE requirement_id = $1", [requirement.id]);
    expect(comments.rows[0]).toEqual({ count: 1 });
    // fresh 没被半截挂上：还能随下一条评论发出。
    expect((await postComment(user, requirement.id, { body: "", fileIds: [fresh.id] })).statusCode).toBe(201);
  });

  it("只有文件的评论：存英文兜底正文并标 comment_files；正文和文件都没有、超过 10 个文件都是 400", async () => {
    const { user, requirement } = await setupRequirement("只发文件的人");
    const a = await uploaded(user, requirement.id, "a.png");
    const b = await uploaded(user, requirement.id, "b.zip");
    const response = await postComment(user, requirement.id, { fileIds: [a.id, b.id] });
    expect(response.statusCode, response.body).toBe(201);
    const comment = response.json<CommentDto>();
    expect(comment.body).toBe("Attached 2 files: a.png, b.zip");
    expect(comment.system).toEqual({ kind: "comment_files", params: { fileCount: 2 } });
    const single = await uploaded(user, requirement.id, "c.txt");
    expect((await postComment(user, requirement.id, { body: "   ", fileIds: [single.id] })).json<CommentDto>().body).toBe(
      "Attached 1 file: c.txt",
    );

    for (const payload of [{}, { body: "   " }, { body: "" }, { fileIds: [] }]) {
      expect((await postComment(user, requirement.id, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const many = Array.from({ length: 11 }, () => randomUUID());
    expect((await postComment(user, requirement.id, { body: "多", fileIds: many })).statusCode).toBe(400);
  });
});

describe("评论文件：下载与存为附件", () => {
  it("内联：图片原样、文本按纯文本、压缩包只能下载；支持分段", async () => {
    const { user, requirement } = await setupRequirement("看文件的人");
    const png = await uploaded(user, requirement.id, "图.png", Buffer.from("0123456789"));
    const inline = await server.inject({ method: "GET", url: `/v2/comment-files/${png.id}/content?disposition=inline`, headers: user.headers });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-type"]).toBe("image/png");
    expect(String(inline.headers["content-disposition"])).toMatch(/^inline;/u);
    expect(inline.body).toBe("0123456789");
    const range = await server.inject({
      method: "GET",
      url: `/v2/comment-files/${png.id}/content`,
      headers: { ...user.headers, range: "bytes=2-4" },
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe("234");
    const text = await uploaded(user, requirement.id, "说明.txt", Buffer.from("<b>hi</b>"));
    const textInline = await server.inject({ method: "GET", url: `/v2/comment-files/${text.id}/content?disposition=inline`, headers: user.headers });
    expect(textInline.headers["content-type"]).toBe("text/plain; charset=utf-8");
    const zip = await uploaded(user, requirement.id, "包.zip", Buffer.from("PK"));
    const zipInline = await server.inject({ method: "GET", url: `/v2/comment-files/${zip.id}/content?disposition=inline`, headers: user.headers });
    expect(zipInline.headers["content-type"]).toBe("application/octet-stream");
    expect(String(zipInline.headers["content-disposition"])).toMatch(/^attachment;/u);
    expect((await server.inject({ method: "GET", url: `/v2/comment-files/${randomUUID()}/content`, headers: user.headers })).statusCode).toBe(404);
  });

  it("存为附件：复制成新附件（上传人是操作人），可重复存；推 attachment.changed；原评论文件不变", async () => {
    const { user, requirement } = await setupRequirement("评论人");
    const saver = await createUser(context, "存附件的人");
    const content = Buffer.from("screenshot-bytes");
    const file = await uploaded(user, requirement.id, "报错截图.png", content);
    await postComment(user, requirement.id, { body: "看图", fileIds: [file.id] });

    const save = () => server.inject({ method: "POST", url: `/v2/comment-files/${file.id}/save-as-attachment`, headers: saver.headers });
    const first = await save();
    expect(first.statusCode, first.body).toBe(201);
    const saved = first.json<AttachmentMutationResponse>().attachment;
    expect(saved).toMatchObject({
      requirementId: requirement.id,
      fileName: "报错截图.png",
      sizeBytes: content.length,
      sha256: file.sha256,
      uploadedBy: { id: saver.id, displayName: "存附件的人" },
    });
    expect(events.map((event) => event.type)).toContain("attachment.changed");
    expect((await save()).statusCode).toBe(201);
    const list = (await server.inject({ method: "GET", url: `/v2/requirements/${requirement.id}/attachments`, headers: user.headers }))
      .json<ListAttachmentsResponse>();
    expect(list.items.map((item) => item.fileName)).toEqual(["报错截图.png", "报错截图.png"]);
    const download = await server.inject({ method: "GET", url: `/v2/attachments/${saved.id}/content`, headers: user.headers });
    expect(download.body).toBe("screenshot-bytes");
    const meta = await server.inject({ method: "GET", url: `/v2/comment-files/${file.id}`, headers: user.headers });
    expect(meta.json<CommentFileDto>().commentId).not.toBeNull();
    expect((await server.inject({ method: "POST", url: `/v2/comment-files/${randomUUID()}/save-as-attachment`, headers: saver.headers })).statusCode).toBe(404);
  });

  it("存为附件到了附件上限：照附件规则拒绝，不多出附件；之后照常能存别的需求", async () => {
    const { user, requirement } = await setupRequirement("存满的人");
    const file = await uploaded(user, requirement.id, "满.txt");
    const save = () => server.inject({ method: "POST", url: `/v2/comment-files/${file.id}/save-as-attachment`, headers: user.headers });
    for (let index = 0; index < MAX_ATTACHMENTS; index += 1) expect((await save()).statusCode).toBe(201);
    const over = await save();
    expect(over.statusCode).toBeGreaterThanOrEqual(400);
    expect(over.statusCode).toBeLessThan(500);
    const list = (await server.inject({ method: "GET", url: `/v2/requirements/${requirement.id}/attachments`, headers: user.headers }))
      .json<ListAttachmentsResponse>();
    expect(list.items).toHaveLength(MAX_ATTACHMENTS);
    // 被拒绝的那次没把流留开：同一个文件之后还能正常读出来。
    const content = await server.inject({ method: "GET", url: `/v2/comment-files/${file.id}/content`, headers: user.headers });
    expect(content.body).toBe("满.txt");
  });
});

function testConfig(attachmentRoot: string): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 1_000,
    authSecret: "comment-files-test-secret-at-least-thirty-two-chars",
    authTtlSeconds: 3_600,
    authIssuer: "suduo-requirements-service",
    authAudience: "suduo-local-bff",
    attachmentRoot,
    maxAttachmentBytes: 1_024,
    maxAttachmentsPerRequirement: MAX_ATTACHMENTS,
    allowedAttachmentExtensions: ALLOWED,
    runMigrations: false,
    logger: false,
  };
}
