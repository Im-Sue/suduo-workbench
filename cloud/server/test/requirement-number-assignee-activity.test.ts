import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import {
  REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
  type ArtifactVersionDetailDto,
  type AttachmentMutationResponse,
  type ListRequirementActivityResponse,
  type ListRequirementsResponse,
  type ListUsersResponse,
  type ProjectDto,
  type RequirementDetailDto,
  type RequirementDto,
  type RequirementsEventDto,
  type RequirementsV2ErrorResponse,
} from "@suduo/cloud-contracts";
import { AttachmentService } from "../src/application/attachment-service.js";
import { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import type { AuthService } from "../src/application/auth-service.js";
import { CollaborationService } from "../src/application/collaboration-service.js";
import { RequirementsEventHub } from "../src/application/event-hub.js";
import type { RequirementsServiceConfig } from "../src/config.js";
import { buildHttpServer } from "../src/http/server.js";
import { ArtifactVersionRepository } from "../src/infrastructure/artifact-version-repository.js";
import { AttachmentRepository } from "../src/infrastructure/attachment-repository.js";
import { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import { CollaborationRepository } from "../src/infrastructure/collaboration-repository.js";
import { Database } from "../src/infrastructure/database.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

const TEST_DATABASE = `suduo_p2_requirements_${randomUUID().replaceAll("-", "")}`;
const DATABASE_IDENTIFIER = quotedIdentifier(TEST_DATABASE);
const PG_CONFIG = { host: "127.0.0.1", port: 15_432, user: "suduo" };
const FILE_CONTENT = Buffer.from("p2 attachment\n");

let pool: Pool;
let server: Awaited<ReturnType<typeof buildHttpServer>>;
let attachments: AttachmentService;
let storageRoot: string;
let databaseCreated = false;
const events = new RequirementsEventHub();
const publishedEvents: RequirementsEventDto[] = [];

beforeAll(async () => {
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${DATABASE_IDENTIFIER}`);
    databaseCreated = true;
  } finally {
    await admin.end();
  }
  pool = ignoreTerminatedConnections(new Pool({ ...PG_CONFIG, database: TEST_DATABASE }));
  await runMigrations(pool);
  const database = new Database(pool);
  storageRoot = await mkdtemp(join(tmpdir(), "suduo-p2-requirements-"));
  const artifactRepository = new ArtifactVersionRepository(database);
  attachments = new AttachmentService(
    new AttachmentRepository(database, REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT),
    new AttachmentStorage(storageRoot, 1_024, new Set([".txt"])),
    artifactRepository,
  );
  await attachments.initialize();
  events.subscribe((event) => publishedEvents.push(event));
  server = await buildHttpServer({
    config: testConfig(storageRoot),
    database,
    auth: {} as AuthService,
    collaboration: new CollaborationService(new CollaborationRepository(database)),
    attachments,
    artifactVersions: new ArtifactVersionService(artifactRepository),
    attachmentStorage: new AttachmentStorage(storageRoot, 1_024, new Set([".txt"])),
    events,
  });
});

afterAll(async () => {
  await server?.close();
  await attachments?.close();
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
  if (!databaseCreated) return;
  const admin = new Client({ ...PG_CONFIG, database: "postgres" });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE ${DATABASE_IDENTIFIER} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  publishedEvents.length = 0;
});

describe("需求编号", () => {
  it("同项目连续取号，跨项目独立编号，失败的创建不消耗编号", async () => {
    const actor = await createUser("numbering", "编号人");
    const projectA = await createProject(actor, "项目甲");
    const projectB = await createProject(actor, "项目乙");

    const first = await createRequirement(actor, projectA.id, { title: "甲一" });
    const second = await createRequirement(actor, projectA.id, { title: "甲二" });
    const otherProject = await createRequirement(actor, projectB.id, { title: "乙一" });
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(otherProject.number).toBe(1);

    const invalidAssignee = await server.inject({
      method: "POST",
      url: `/v2/projects/${projectA.id}/requirements`,
      headers: authorization(actor),
      payload: { title: "负责人不存在", assigneeId: randomUUID() },
    });
    expect(invalidAssignee.statusCode).toBe(400);
    expect(invalidAssignee.json<RequirementsV2ErrorResponse>().error.code).toBe("VALIDATION_ERROR");

    const third = await createRequirement(actor, projectA.id, { title: "甲三" });
    expect(third.number).toBe(3);

    const archived = await server.inject({
      method: "PATCH",
      url: `/v2/projects/${projectB.id}`,
      headers: authorization(actor),
      payload: { isArchived: true },
    });
    expect(archived.statusCode).toBe(200);
    const rejected = await server.inject({
      method: "POST",
      url: `/v2/projects/${projectB.id}/requirements`,
      headers: authorization(actor),
      payload: { title: "归档项目不能建" },
    });
    expect(rejected.statusCode).toBe(409);
    const counter = await pool.query<{ next_requirement_number: number }>(
      "SELECT next_requirement_number FROM projects WHERE id = $1",
      [projectB.id],
    );
    expect(counter.rows[0]?.next_requirement_number).toBe(2);
  });

  it("同项目并发创建拿到连续且不重复的编号", async () => {
    const actor = await createUser("concurrent", "并发人");
    const project = await createProject(actor, "并发项目");
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createRequirement(actor, project.id, { title: `并发 ${String(index)}` })),
    );
    expect(created.map((item) => item.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it("按编号搜索与按编号读取", async () => {
    const actor = await createUser("search", "搜索人");
    const project = await createProject(actor, "搜索项目");
    const alpha = await createRequirement(actor, project.id, { title: "登录页改版" });
    const beta = await createRequirement(actor, project.id, { title: "导出报表" });
    await createRequirement(actor, project.id, { title: "第三条" });

    for (const search of ["2", "REQ-2", "req-2", " REQ 2 ", "#2"]) {
      const page = await listRequirements(actor, project.id, { search });
      expect(page.items.map((item) => item.id), search).toEqual([beta.id]);
    }
    const byTitle = await listRequirements(actor, project.id, { search: "登录" });
    expect(byTitle.items.map((item) => item.id)).toEqual([alpha.id]);
    const missing = await listRequirements(actor, project.id, { search: "REQ-99" });
    expect(missing.items).toEqual([]);

    const found = await server.inject({
      method: "GET",
      url: `/v2/projects/${project.id}/requirements/by-number/1`,
      headers: authorization(actor),
    });
    expect(found.statusCode).toBe(200);
    expect(found.json<RequirementDetailDto>()).toMatchObject({
      id: alpha.id,
      number: 1,
      project: { id: project.id, name: "搜索项目" },
    });
    const notFound = await server.inject({
      method: "GET",
      url: `/v2/projects/${project.id}/requirements/by-number/42`,
      headers: authorization(actor),
    });
    expect(notFound.statusCode).toBe(404);
    const invalid = await server.inject({
      method: "GET",
      url: `/v2/projects/${project.id}/requirements/by-number/0`,
      headers: authorization(actor),
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("描述与负责人", () => {
  it("描述可省略、可为空，也可更新为空", async () => {
    const actor = await createUser("summary", "描述人");
    const project = await createProject(actor, "描述项目");
    const omitted = await createRequirement(actor, project.id, { title: "无描述" });
    expect(omitted.summary).toBe("");
    const empty = await createRequirement(actor, project.id, { title: "空描述", summary: "" });
    expect(empty.summary).toBe("");
    const filled = await createRequirement(actor, project.id, { title: "有描述", summary: "正文" });
    const cleared = await patchRequirement(actor, filled.id, { summary: "" });
    expect(cleared.summary).toBe("");
    expect(cleared.version).toBe(filled.version + 1);
  });

  it("设置、更换、清空负责人：不递增正文版本，写审计并发 SSE；同值不写", async () => {
    const actor = await createUser("owner", "甲");
    const colleague = await createUser("colleague", "乙");
    const project = await createProject(actor, "负责人项目");
    const created = await createRequirement(actor, project.id, {
      title: "带负责人创建",
      assigneeId: colleague,
    });
    expect(created.assignee).toEqual({ id: colleague, displayName: "乙" });
    const createdAudit = await auditRows(created.id, "requirement.created");
    expect(createdAudit[0]?.after_json).toMatchObject({
      assignee: { id: colleague, displayName: "乙" },
    });

    publishedEvents.length = 0;
    const reassigned = await patchRequirement(actor, created.id, { assigneeId: actor });
    expect(reassigned.assignee).toEqual({ id: actor, displayName: "甲" });
    expect(reassigned.version).toBe(created.version);
    expect(reassigned.updatedAt > created.updatedAt).toBe(true);
    expect(publishedEvents).toEqual([
      expect.objectContaining({
        type: "requirement.changed",
        requirementId: created.id,
        requirementVersion: created.version,
      }),
    ]);

    const cleared = await patchRequirement(actor, created.id, { assigneeId: null });
    expect(cleared.assignee).toBeNull();

    publishedEvents.length = 0;
    const unchanged = await patchRequirement(actor, created.id, { assigneeId: null });
    expect(unchanged.updatedAt).toBe(cleared.updatedAt);
    expect(publishedEvents).toEqual([]);

    const audits = await auditRows(created.id, "requirement.assignee_changed");
    expect(audits.map((row) => [row.before_json, row.after_json])).toEqual([
      [
        { assignee: { id: colleague, displayName: "乙" } },
        { assignee: { id: actor, displayName: "甲" } },
      ],
      [{ assignee: { id: actor, displayName: "甲" } }, { assignee: null }],
    ]);

    const combined = await patchRequirement(actor, created.id, {
      title: "同时改标题与负责人",
      assigneeId: colleague,
    });
    expect(combined.version).toBe(created.version + 1);
    expect(await auditRows(created.id, "requirement.updated")).toHaveLength(1);
    expect(await auditRows(created.id, "requirement.assignee_changed")).toHaveLength(3);

    const invalid = await server.inject({
      method: "PATCH",
      url: `/v2/requirements/${created.id}`,
      headers: authorization(actor),
      payload: { assigneeId: randomUUID() },
    });
    expect(invalid.statusCode).toBe(400);
    const malformed = await server.inject({
      method: "PATCH",
      url: `/v2/requirements/${created.id}`,
      headers: authorization(actor),
      payload: { assigneeId: "not-a-uuid" },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("换负责人持有的行锁不挡其他事务插入引用该需求的评论（外键 KEY SHARE）", async () => {
    const actor = await createUser("lock-owner", "锁人");
    const colleague = await createUser("lock-colleague", "锁同事");
    const project = await createProject(actor, "行锁项目");
    const requirement = await createRequirement(actor, project.id, { title: "行锁需求" });
    let probed = false;
    // 在换负责人的事务读完旧值、持锁未提交时，另开一个事务插入评论；被挡住会触发 lock_timeout。
    const repository = new CollaborationRepository(
      new QueryProbeDatabase(pool, async (text) => {
        if (probed || !/\bassignee_id\b[\s\S]*\bFOR\b[\s\S]*\bUPDATE\b/u.test(text)) return;
        probed = true;
        const other = await pool.connect();
        try {
          await other.query("BEGIN");
          await other.query("SET LOCAL lock_timeout = '2s'");
          await other.query(
            `
              INSERT INTO requirement_comments (id, requirement_id, body, author_id)
              VALUES ($1, $2, '并发评论', $3)
            `,
            [randomUUID(), requirement.id, colleague],
          );
          await other.query("COMMIT");
        } catch (error) {
          await other.query("ROLLBACK");
          throw error;
        } finally {
          other.release();
        }
      }),
    );
    const result = await repository.updateRequirement({
      actorId: actor,
      requirementId: requirement.id,
      assigneeId: colleague,
    });
    expect(probed).toBe(true);
    expect(result.requirement.assignee).toEqual({ id: colleague, displayName: "锁同事" });
    expect((await getRequirement(actor, requirement.id)).commentCount).toBe(1);
  });

  it("按负责人过滤：用户 id、me、none", async () => {
    const actor = await createUser("filter-me", "我");
    const colleague = await createUser("filter-other", "同事");
    const project = await createProject(actor, "过滤项目");
    const mine = await createRequirement(actor, project.id, { title: "我的", assigneeId: actor });
    const theirs = await createRequirement(actor, project.id, {
      title: "同事的",
      assigneeId: colleague,
    });
    const unassigned = await createRequirement(actor, project.id, { title: "未指派" });

    expect(ids(await listRequirements(actor, project.id, { assignee: "me" }))).toEqual([mine.id]);
    expect(ids(await listRequirements(colleague, project.id, { assignee: "me" }))).toEqual([
      theirs.id,
    ]);
    expect(ids(await listRequirements(actor, project.id, { assignee: colleague }))).toEqual([
      theirs.id,
    ]);
    expect(ids(await listRequirements(actor, project.id, { assignee: "none" }))).toEqual([
      unassigned.id,
    ]);
    expect(
      ids(await listRequirements(actor, project.id, { assignee: "none", search: "REQ-3" })),
    ).toEqual([unassigned.id]);
    const invalid = await server.inject({
      method: "GET",
      url: `/v2/projects/${project.id}/requirements?assignee=someone`,
      headers: authorization(actor),
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("创建人筛选与新评论", () => {
  it("按创建人过滤：me 与用户 id，可与负责人筛选组合（我提的、还没人负责）", async () => {
    const actor = await createUser("creator-me", "我");
    const colleague = await createUser("creator-other", "同事");
    const project = await createProject(actor, "创建人项目");
    const mineUnassigned = await createRequirement(actor, project.id, { title: "我提的没人管" });
    await createRequirement(actor, project.id, { title: "我提的有人管", assigneeId: colleague });
    const theirs = await createRequirement(colleague, project.id, { title: "同事提的" });

    expect(ids(await listRequirements(actor, project.id, { creator: "me", assignee: "none" }))).toEqual([mineUnassigned.id]);
    expect(ids(await listRequirements(actor, project.id, { creator: colleague }))).toEqual([theirs.id]);
    const invalid = await server.inject({
      method: "GET",
      url: `/v2/projects/${project.id}/requirements?creator=none`,
      headers: authorization(actor),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("新评论数只算别人发的、在我上次打开之后的；打开后清零，别人再评论又加一", async () => {
    const actor = await createUser("unread-me", "我");
    const colleague = await createUser("unread-other", "同事");
    const project = await createProject(actor, "新评论项目");
    const requirement = await createRequirement(actor, project.id, { title: "要跟进的", assigneeId: actor });
    await createComment(colleague, requirement.id, "同事第一条");
    await createComment(actor, requirement.id, "我自己回的");
    await createComment(colleague, requirement.id, "同事第二条");

    const unread = async (userId: string) =>
      (await listRequirements(userId, project.id, { assignee: "me" })).items[0]?.unreadCommentCount ?? -1;
    // 从没打开过：只往回算最近几天，这里都是刚发的。
    expect(await unread(actor)).toBe(2);

    const mark = await server.inject({ method: "PUT", url: `/v2/requirements/${requirement.id}/read`, headers: authorization(actor) });
    expect(mark.statusCode).toBe(204);
    expect(await unread(actor)).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await createComment(colleague, requirement.id, "同事第三条");
    expect(await unread(actor)).toBe(1);

    const missing = await server.inject({ method: "PUT", url: `/v2/requirements/${randomUUID()}/read`, headers: authorization(actor) });
    expect(missing.statusCode).toBe(404);
  });

  it("带水位时只记到界面上看到的那条；已读位置只往后挪；从没打开过的只算最近 7 天", async () => {
    const actor = await createUser("watermark-me", "我");
    const colleague = await createUser("watermark-other", "同事");
    const project = await createProject(actor, "水位项目");
    const requirement = await createRequirement(actor, project.id, { title: "看了一半", assigneeId: actor });
    // 8 天前的老评论：从没打开过时不算。
    await pool.query(
      "INSERT INTO requirement_comments (id, requirement_id, body, author_id, created_at) VALUES ($1, $2, '很久以前', $3, now() - interval '8 days')",
      [randomUUID(), requirement.id, colleague],
    );
    await createComment(colleague, requirement.id, "看到的那条");
    const seen = (await pool.query<{ created_at: Date }>(
      "SELECT created_at FROM requirement_comments WHERE requirement_id = $1 AND body = '看到的那条'",
      [requirement.id],
    )).rows[0]!.created_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createComment(colleague, requirement.id, "还没刷出来的那条");
    const unread = async () => (await listRequirements(actor, project.id, { assignee: "me" })).items[0]?.unreadCommentCount ?? -1;
    expect(await unread()).toBe(2);

    const put = (upTo?: string) =>
      server.inject({
        method: "PUT",
        url: `/v2/requirements/${requirement.id}/read`,
        headers: authorization(actor),
        ...(upTo === undefined ? {} : { payload: { upTo } }),
      });
    expect((await put(seen.toISOString())).statusCode).toBe(204);
    expect(await unread()).toBe(1);
    // 更早的水位不会把位置改回去。
    expect((await put(new Date(seen.getTime() - 60_000).toISOString())).statusCode).toBe(204);
    expect(await unread()).toBe(1);
    // 将来的水位按现在算，不会把之后的新评论提前记成已读。
    expect((await put(new Date(Date.now() + 3_600_000).toISOString())).statusCode).toBe(204);
    expect(await unread()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createComment(colleague, requirement.id, "之后又来一条");
    expect(await unread()).toBe(1);
    // 只收带时区的 ISO 时间：宽松写法、超大年份一律 400（不会落成很早的位置，也不会让数据库报错）。
    for (const invalid of ["not-a-date", "1", "Sep 29 2026", "2026-09-29", "+100000-01-01T00:00:00Z"]) {
      expect((await put(invalid)).statusCode, invalid).toBe(400);
    }
  });

  it("首次记已读不早于 7 天基线：看到一条很早的评论后，基线外的老评论不会反而变成未读", async () => {
    const actor = await createUser("floor-me", "我");
    const colleague = await createUser("floor-other", "同事");
    const project = await createProject(actor, "基线项目");
    const requirement = await createRequirement(actor, project.id, { title: "老需求", assigneeId: actor });
    await pool.query(
      "INSERT INTO requirement_comments (id, requirement_id, body, author_id, created_at) VALUES ($1, $2, '一个月前', $3, now() - interval '30 days'), ($4, $2, '八天前', $3, now() - interval '8 days')",
      [randomUUID(), requirement.id, colleague, randomUUID()],
    );
    const unread = async () => (await listRequirements(actor, project.id, { assignee: "me" })).items[0]?.unreadCommentCount ?? -1;
    expect(await unread()).toBe(0);
    const response = await server.inject({
      method: "PUT",
      url: `/v2/requirements/${requirement.id}/read`,
      headers: authorization(actor),
      payload: { upTo: new Date(Date.now() - 30 * 86_400_000).toISOString() },
    });
    expect(response.statusCode).toBe(204);
    expect(await unread()).toBe(0);
  });

  it("确认版的发布说明不算新评论（与时间线「评论」筛选看到的一致）", async () => {
    const actor = await createUser("publish-note-me", "我");
    const colleague = await createUser("publish-note-other", "同事");
    const project = await createProject(actor, "发布说明项目");
    const requirement = await createRequirement(actor, project.id, { title: "要发确认版的", assigneeId: actor });
    const uploaded = await uploadAttachment(colleague, requirement.id, "spec.txt");
    await publish(colleague, requirement.id, [uploaded.attachment.id], "第一版说明");
    await publish(colleague, requirement.id, [uploaded.attachment.id]);
    const unread = async () => (await listRequirements(actor, project.id, { assignee: "me" })).items[0]?.unreadCommentCount ?? -1;
    expect(await unread()).toBe(0);
    await createComment(colleague, requirement.id, "发完来说一声");
    expect(await unread()).toBe(1);
  });

  it("看板列表等其他筛选不算新评论数", async () => {
    const actor = await createUser("unread-scope-me", "我");
    const project = await createProject(actor, "新评论范围");
    await createRequirement(actor, project.id, { title: "随便一条", assigneeId: actor });
    const page = await listRequirements(actor, project.id, {});
    expect(page.items[0]?.unreadCommentCount).toBeUndefined();
  });
});

describe("用户列表", () => {
  it("需登录，按显示名排序返回全部用户", async () => {
    const actor = await createUser("zeta", "王五");
    await createUser("alpha", "Alice");
    await createUser("beta", "Bob");
    const unauthenticated = await server.inject({ method: "GET", url: "/v2/users" });
    expect(unauthenticated.statusCode).toBe(401);
    const response = await server.inject({
      method: "GET",
      url: "/v2/users",
      headers: authorization(actor),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ListUsersResponse>();
    expect(body.items.map((user) => user.displayName)).toEqual(["Alice", "Bob", "王五"]);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["displayName", "id"]);
  });
});

describe("计数与活动时间线", () => {
  it("列表与详情的评论数、附件数（不含已删除附件）", async () => {
    const actor = await createUser("counts", "计数人");
    const project = await createProject(actor, "计数项目");
    const requirement = await createRequirement(actor, project.id, { title: "计数" });
    expect(requirement).toMatchObject({ commentCount: 0, attachmentCount: 0 });
    await createComment(actor, requirement.id, "第一条");
    await createComment(actor, requirement.id, "第二条");
    const kept = await uploadAttachment(actor, requirement.id, "kept.txt");
    const removed = await uploadAttachment(actor, requirement.id, "removed.txt");
    expect(kept.attachment.id).not.toBe(removed.attachment.id);
    await deleteAttachment(actor, removed.attachment.id);

    const detail = await getRequirement(actor, requirement.id);
    expect(detail).toMatchObject({ commentCount: 2, attachmentCount: 1 });
    const listed = await listRequirements(actor, project.id, {});
    expect(listed.items[0]).toMatchObject({ commentCount: 2, attachmentCount: 1 });
  });

  it("合并需求、评论、附件、产物审计；排除下载；发布评论并入发布条目", async () => {
    const actor = await createUser("activity", "活动人");
    const colleague = await createUser("activity-2", "协作者");
    const project = await createProject(actor, "活动项目");
    const requirement = await createRequirement(actor, project.id, { title: "活动需求" });
    const unrelated = await createRequirement(actor, project.id, { title: "无关需求" });
    await createComment(actor, unrelated.id, "不应出现");

    await patchRequirement(actor, requirement.id, { title: "活动需求（改）" });
    await patchRequirement(actor, requirement.id, { status: "in_refinement" });
    await patchRequirement(actor, requirement.id, { assigneeId: colleague });
    await createComment(colleague, requirement.id, "**评论** 正文");
    const uploaded = await uploadAttachment(actor, requirement.id, "spec.txt");
    const download = await server.inject({
      method: "GET",
      url: `/v2/attachments/${uploaded.attachment.id}/content`,
      headers: authorization(actor),
    });
    expect(download.statusCode).toBe(200);
    const withNote = await publish(actor, requirement.id, [uploaded.attachment.id], "第一版说明");
    const withoutNote = await publish(actor, requirement.id, [uploaded.attachment.id]);
    await deleteAttachment(actor, uploaded.attachment.id);

    const all = await listActivity(actor, requirement.id, 100);
    expect(all.nextCursor).toBeNull();
    expect(all.items.map((item) => item.action)).toEqual([
      "attachment.deleted",
      "artifact_version.published",
      "artifact_version.published",
      "attachment.created",
      "comment.created",
      "requirement.assignee_changed",
      "requirement.status_changed",
      "requirement.updated",
      "requirement.created",
    ]);
    expect(all.items.every((item) => item.requirementId === requirement.id)).toBe(true);
    // 时间线不带审计原始前后值，控制响应体积。
    expect(all.items.some((item) => "before" in item || "after" in item)).toBe(false);

    const [deleted, secondPublish, firstPublish, created, comment, assignee, status, updated] =
      all.items;
    expect(deleted?.attachment).toEqual({ id: uploaded.attachment.id, fileName: "spec.txt" });
    expect(created?.attachment).toEqual({ id: uploaded.attachment.id, fileName: "spec.txt" });
    expect(firstPublish?.artifactVersion).toEqual({
      id: withNote.id,
      versionNumber: 1,
      fileCount: 1,
      note: "第一版说明",
    });
    expect(secondPublish?.artifactVersion).toEqual({
      id: withoutNote.id,
      versionNumber: 2,
      fileCount: 1,
      note: null,
    });
    expect(comment?.comment).toMatchObject({ body: "**评论** 正文" });
    expect(comment?.actor).toEqual({ id: colleague, displayName: "协作者" });
    expect(assignee?.changes).toEqual([
      { field: "assignee", from: null, to: { id: colleague, displayName: "协作者" } },
    ]);
    expect(status?.changes).toEqual([
      { field: "status", from: "draft", to: "in_refinement" },
    ]);
    expect(updated?.changes).toEqual([
      { field: "title", from: "活动需求", to: "活动需求（改）" },
    ]);
    expect(updated).toMatchObject({ comment: null, attachment: null, artifactVersion: null });

    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listActivity(actor, requirement.id, 2, cursor);
      paged.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(paged).toEqual(all.items.map((item) => item.id));

    const missing = await server.inject({
      method: "GET",
      url: `/v2/requirements/${randomUUID()}/activity`,
      headers: authorization(actor),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("同一 PATCH 同时改正文与负责人：两条审计按写入先后排列，时间线顺序稳定", async () => {
    const actor = await createUser("ordering", "顺序人");
    const colleague = await createUser("ordering-2", "顺序同事");
    const project = await createProject(actor, "顺序项目");
    const requirement = await createRequirement(actor, project.id, { title: "顺序需求" });
    // 同一事务的两条审计若取事务开始时刻，created_at 相同、只能按随机 id 排序；
    // 连续六次都排对的概率只有 1/64。
    const assignees = [colleague, actor, colleague, actor, colleague, actor];
    for (const [index, assigneeId] of assignees.entries()) {
      await patchRequirement(actor, requirement.id, {
        title: `顺序需求 ${String(index + 1)}`,
        assigneeId,
      });
    }
    const all = await listActivity(actor, requirement.id, 100);
    // 最新在前：每次 PATCH 先写正文审计、再写负责人审计，所以负责人变更在上。
    expect(all.items.map((item) => item.action)).toEqual([
      ...assignees.flatMap(() => ["requirement.assignee_changed", "requirement.updated"]),
      "requirement.created",
    ]);
  });

  it("同一毫秒内的多条活动跨页不丢（游标保留微秒）", async () => {
    const actor = await createUser("micro", "微秒人");
    const project = await createProject(actor, "微秒项目");
    const requirement = await createRequirement(actor, project.id, { title: "微秒需求" });
    for (const microseconds of ["100", "300", "200"]) {
      await pool.query(
        `
          INSERT INTO audit_logs (
            id, actor_id, project_id, requirement_id, resource_type, resource_id,
            action, before_json, after_json, created_at
          ) VALUES ($1, $2, $3, $4, 'requirement', $4, 'requirement.updated', NULL, NULL, $5)
        `,
        [randomUUID(), actor, project.id, requirement.id, `2030-01-01T00:00:00.123${microseconds}Z`],
      );
    }
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listActivity(actor, requirement.id, 1, cursor);
      paged.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = await listActivity(actor, requirement.id, 100);
    expect(all.items).toHaveLength(4);
    expect(paged).toEqual(all.items.map((item) => item.id));
  });
});

describe("项目改名 / 归档", () => {
  it("后写生效不再 409；实变才自增、写审计、发事件；旧客户端带的 expectedVersion 被丢弃", async () => {
    const actor = await createUser("project-editor", "项目编辑人");
    const project = await createProject(actor, "原名");

    // 两个客户端基于同一版本各改一次：后写覆盖前写。
    const first = await patchProject(actor, project.id, { name: "甲改的名" });
    expect(first.version).toBe(project.version + 1);
    publishedEvents.length = 0;
    const second = await patchProject(actor, project.id, {
      name: "乙改的名",
      expectedVersion: project.version,
    });
    expect(second).toMatchObject({ name: "乙改的名", version: project.version + 2 });
    expect(publishedEvents).toEqual([
      expect.objectContaining({ type: "project.changed", projectId: project.id }),
    ]);

    // 同名 / 同状态：不写入、不自增、不写审计、不发事件。
    const auditsBefore = await projectAuditCount(project.id);
    publishedEvents.length = 0;
    const unchanged = await patchProject(actor, project.id, { name: "乙改的名", isArchived: false });
    expect(unchanged).toEqual(second);
    expect(await projectAuditCount(project.id)).toBe(auditsBefore);
    expect(publishedEvents).toEqual([]);

    const archived = await patchProject(actor, project.id, { isArchived: true });
    expect(archived).toMatchObject({ isArchived: true, version: project.version + 3 });
    expect(await patchProject(actor, project.id, { isArchived: true })).toEqual(archived);
    expect(await projectAuditCount(project.id)).toBe(auditsBefore + 1);

    const onlyLegacyField = await server.inject({
      method: "PATCH",
      url: `/v2/projects/${project.id}`,
      headers: authorization(actor),
      payload: { expectedVersion: archived.version },
    });
    expect(onlyLegacyField.statusCode).toBe(400);
  });
});

describe("游标分页保留微秒（同一时间戳多行 + limit=1 翻页不漏不重）", () => {
  // 三行完全同一时间戳，再加一行同一毫秒内的更晚微秒；毫秒截断的游标会在这里漏行。
  const SHARED_TIMESTAMP = "2030-01-01T00:00:00.123456Z";
  const LATER_SAME_MILLISECOND = "2030-01-01T00:00:00.123789Z";

  it("项目列表", async () => {
    const actor = await createUser("cursor-projects", "游标项目人");
    const projects = await Promise.all(
      ["一", "二", "三", "四"].map((name) => createProject(actor, `游标项目${name}`)),
    );
    await pool.query("UPDATE projects SET updated_at = $1 WHERE id = ANY($2::uuid[])", [
      SHARED_TIMESTAMP,
      projects.slice(1).map((project) => project.id),
    ]);
    await pool.query("UPDATE projects SET updated_at = $1 WHERE id = $2", [
      LATER_SAME_MILLISECOND,
      projects[0]!.id,
    ]);
    await expectStablePaging(actor, "/v2/projects", {}, 4);
  });

  it("需求列表", async () => {
    const actor = await createUser("cursor-requirements", "游标需求人");
    const project = await createProject(actor, "游标需求项目");
    const requirements = [];
    for (const title of ["甲", "乙", "丙", "丁"]) {
      requirements.push(await createRequirement(actor, project.id, { title }));
    }
    await pool.query("UPDATE requirements SET updated_at = $1 WHERE project_id = $2", [
      SHARED_TIMESTAMP,
      project.id,
    ]);
    await pool.query("UPDATE requirements SET updated_at = $1 WHERE id = $2", [
      LATER_SAME_MILLISECOND,
      requirements[0]!.id,
    ]);
    await expectStablePaging(actor, `/v2/projects/${project.id}/requirements`, {}, 4);
  });

  it("评论列表", async () => {
    const actor = await createUser("cursor-comments", "游标评论人");
    const project = await createProject(actor, "游标评论项目");
    const requirement = await createRequirement(actor, project.id, { title: "游标评论需求" });
    for (const body of ["一", "二", "三", "四"]) {
      await createComment(actor, requirement.id, body);
    }
    await pool.query("UPDATE requirement_comments SET created_at = $1 WHERE requirement_id = $2", [
      SHARED_TIMESTAMP,
      requirement.id,
    ]);
    await pool.query(
      `
        UPDATE requirement_comments SET created_at = $1
        WHERE id = (SELECT id FROM requirement_comments WHERE requirement_id = $2 LIMIT 1)
      `,
      [LATER_SAME_MILLISECOND, requirement.id],
    );
    await expectStablePaging(actor, `/v2/requirements/${requirement.id}/comments`, {}, 4);
  });

  it("审计列表", async () => {
    const actor = await createUser("cursor-audit", "游标审计人");
    const project = await createProject(actor, "游标审计项目");
    const requirement = await createRequirement(actor, project.id, { title: "游标审计需求" });
    for (const createdAt of [
      SHARED_TIMESTAMP,
      SHARED_TIMESTAMP,
      SHARED_TIMESTAMP,
      LATER_SAME_MILLISECOND,
    ]) {
      await pool.query(
        `
          INSERT INTO audit_logs (
            id, actor_id, project_id, requirement_id, resource_type, resource_id,
            action, before_json, after_json, created_at
          ) VALUES ($1, $2, $3, $4, 'requirement', $4, 'requirement.updated', NULL, NULL, $5)
        `,
        [randomUUID(), actor, project.id, requirement.id, createdAt],
      );
    }
    // 另有项目、需求创建时写入的两条审计。
    await expectStablePaging(actor, "/v2/audit", { projectId: project.id }, 6);
  });
});

/** limit=1 逐页翻到底，结果应与一次取全的顺序完全一致，且条数符合预期。 */
async function expectStablePaging(
  actorId: string,
  path: string,
  query: Record<string, string>,
  expectedCount: number,
): Promise<void> {
  const listPage = async (limit: number, cursor: string | null) => {
    const search = new URLSearchParams({ ...query, limit: String(limit) });
    if (cursor !== null) search.set("cursor", cursor);
    const response = await server.inject({
      method: "GET",
      url: `${path}?${search.toString()}`,
      headers: authorization(actorId),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
  };
  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await listPage(1, cursor);
    paged.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null && paged.length <= expectedCount);
  const all = await listPage(100, null);
  expect(all.items).toHaveLength(expectedCount);
  expect(paged).toEqual(all.items.map((item) => item.id));
}

/** 事务内每条语句执行后回调一次，用来在持锁期间插入并发操作。 */
class QueryProbeDatabase extends Database {
  constructor(
    pool: Pool,
    private readonly afterQuery: (text: string) => Promise<void>,
  ) {
    super(pool);
  }

  override transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const afterQuery = this.afterQuery;
    return super.transaction(async (client) => {
      const probed = new Proxy(client, {
        get(target, property) {
          if (property !== "query") {
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (text: string, values?: unknown[]) => {
            const result = await target.query(text, values);
            await afterQuery(text);
            return result;
          };
        },
      });
      return work(probed);
    });
  }
}

async function createUser(loginName: string, displayName: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO users (id, login_name, display_name, password_hash) VALUES ($1, $2, $3, 'hash')",
    [id, loginName, displayName],
  );
  return id;
}

async function createProject(actorId: string, name: string): Promise<ProjectDto> {
  const response = await server.inject({
    method: "POST",
    url: "/v2/projects",
    headers: authorization(actorId),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ProjectDto>();
}

async function createRequirement(
  actorId: string,
  projectId: string,
  payload: Record<string, unknown>,
): Promise<RequirementDto> {
  const response = await server.inject({
    method: "POST",
    url: `/v2/projects/${projectId}/requirements`,
    headers: authorization(actorId),
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<RequirementDto>();
}

async function patchProject(
  actorId: string,
  projectId: string,
  payload: Record<string, unknown>,
): Promise<ProjectDto> {
  const response = await server.inject({
    method: "PATCH",
    url: `/v2/projects/${projectId}`,
    headers: authorization(actorId),
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json<ProjectDto>();
}

async function projectAuditCount(projectId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM audit_logs WHERE resource_type = 'project' AND resource_id = $1",
    [projectId],
  );
  return result.rows[0]?.count ?? 0;
}

async function patchRequirement(
  actorId: string,
  requirementId: string,
  payload: Record<string, unknown>,
): Promise<RequirementDto> {
  const response = await server.inject({
    method: "PATCH",
    url: `/v2/requirements/${requirementId}`,
    headers: authorization(actorId),
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json<RequirementDto>();
}

async function getRequirement(actorId: string, requirementId: string): Promise<RequirementDetailDto> {
  const response = await server.inject({
    method: "GET",
    url: `/v2/requirements/${requirementId}`,
    headers: authorization(actorId),
  });
  expect(response.statusCode).toBe(200);
  return response.json<RequirementDetailDto>();
}

async function listRequirements(
  actorId: string,
  projectId: string,
  query: Record<string, string>,
): Promise<ListRequirementsResponse> {
  const search = new URLSearchParams(query).toString();
  const response = await server.inject({
    method: "GET",
    url: `/v2/projects/${projectId}/requirements${search ? `?${search}` : ""}`,
    headers: authorization(actorId),
  });
  expect(response.statusCode).toBe(200);
  return response.json<ListRequirementsResponse>();
}

async function listActivity(
  actorId: string,
  requirementId: string,
  limit: number,
  cursor: string | null = null,
): Promise<ListRequirementActivityResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== null) query.set("cursor", cursor);
  const response = await server.inject({
    method: "GET",
    url: `/v2/requirements/${requirementId}/activity?${query.toString()}`,
    headers: authorization(actorId),
  });
  expect(response.statusCode).toBe(200);
  return response.json<ListRequirementActivityResponse>();
}

async function createComment(actorId: string, requirementId: string, body: string): Promise<void> {
  const response = await server.inject({
    method: "POST",
    url: `/v2/requirements/${requirementId}/comments`,
    headers: authorization(actorId),
    payload: { body },
  });
  expect(response.statusCode).toBe(201);
}

async function uploadAttachment(
  actorId: string,
  requirementId: string,
  fileName: string,
): Promise<AttachmentMutationResponse> {
  const upload = multipartUpload(fileName, FILE_CONTENT);
  const response = await server.inject({
    method: "POST",
    url: `/v2/requirements/${requirementId}/attachments`,
    headers: {
      ...authorization(actorId),
      "content-type": upload.contentType,
      "idempotency-key": randomUUID(),
      "x-attachment-size": String(FILE_CONTENT.byteLength),
    },
    payload: upload.payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<AttachmentMutationResponse>();
}

async function deleteAttachment(actorId: string, attachmentId: string): Promise<void> {
  const response = await server.inject({
    method: "DELETE",
    url: `/v2/attachments/${attachmentId}/content`,
    headers: authorization(actorId),
  });
  expect(response.statusCode).toBe(200);
}

async function publish(
  actorId: string,
  requirementId: string,
  attachmentIds: string[],
  note?: string,
): Promise<ArtifactVersionDetailDto> {
  const response = await server.inject({
    method: "POST",
    url: `/v2/requirements/${requirementId}/artifact-versions`,
    headers: authorization(actorId),
    payload: {
      operationKey: randomUUID(),
      attachmentIds,
      ...(note === undefined ? {} : { note }),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<ArtifactVersionDetailDto>();
}

async function auditRows(
  requirementId: string,
  action: string,
): Promise<Array<{ before_json: unknown; after_json: unknown }>> {
  const result = await pool.query<{ before_json: unknown; after_json: unknown }>(
    `
      SELECT before_json, after_json
      FROM audit_logs
      WHERE resource_type = 'requirement' AND resource_id = $1 AND action = $2
      ORDER BY created_at ASC, id ASC
    `,
    [requirementId, action],
  );
  return result.rows;
}

function ids(page: ListRequirementsResponse): string[] {
  return page.items.map((item) => item.id);
}

function multipartUpload(fileName: string, content: Buffer): { contentType: string; payload: Buffer } {
  const boundary = `----suduo-p2-${randomUUID()}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function authorization(actorId: string): { authorization: string } {
  return { authorization: `Bearer ${server.jwt.sign({ sub: actorId, loginName: "p2-user" })}` };
}

function testConfig(attachmentRoot: string): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 100,
    authSecret: "p2-requirements-test-secret-at-least-thirty-two-characters",
    authTtlSeconds: 3_600,
    authIssuer: "suduo-requirements-service",
    authAudience: "suduo-local-bff",
    attachmentRoot,
    maxAttachmentBytes: 1_024,
    maxAttachmentsPerRequirement: REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
    allowedAttachmentExtensions: new Set([".txt"]),
    runMigrations: false,
    logger: false,
  };
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("临时 PostgreSQL 数据库名无效");
  }
  return `"${value}"`;
}
