import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import {
  RECORDED_AUDIT_ACTIONS,
  REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
  type ArtifactVersionDetailDto,
  type AttachmentMutationResponse,
  type RecordedAuditAction,
  type AuditResourceType,
  type CommentDto,
  type ListAuditResponse,
  type ProjectDto,
  type RequirementDto,
  type AgentDto,
  type AgentShareDto,
  type RoomDto,
  type SharedItemDetailDto,
} from "@suduo/cloud-contracts";
import { AiCollabService } from "../src/application/ai-collab-service.js";
import { AiCollabRepository } from "../src/infrastructure/ai-collab-repository.js";
import { AttachmentService } from "../src/application/attachment-service.js";
import { ArtifactVersionService } from "../src/application/artifact-version-service.js";
import type { AuthService } from "../src/application/auth-service.js";
import { CollaborationService } from "../src/application/collaboration-service.js";
import { RequirementsEventHub } from "../src/application/event-hub.js";
import { ROOM_FILE_ROOT_MARKER } from "../src/application/rooms/constants.js";
import { createRoomsModule } from "../src/application/rooms/module.js";
import type { RequirementsServiceConfig } from "../src/config.js";
import { buildHttpServer } from "../src/http/server.js";
import { ArtifactVersionRepository } from "../src/infrastructure/artifact-version-repository.js";
import { AttachmentRepository } from "../src/infrastructure/attachment-repository.js";
import { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import { CollaborationRepository } from "../src/infrastructure/collaboration-repository.js";
import { Database } from "../src/infrastructure/database.js";
import { runMigrations } from "../src/infrastructure/migration-runner.js";
import { LocalDiskBlobStore } from "../src/infrastructure/storage/local-disk-blob-store.js";
import { ignoreTerminatedConnections } from "./pg-test-support.js";

const TEST_DATABASE = process.env["SUDUO_AUDIT_PROJECT_ID_TEST_DB"] ??
  `suduo_audit_project_id_${randomUUID().replaceAll("-", "")}`;
const DATABASE_IDENTIFIER = quotedIdentifier(TEST_DATABASE);
const PG_CONFIG = { host: "127.0.0.1", port: 15_432, user: "suduo" };
const FILE_CONTENT = Buffer.from("audit attachment\n");
const PUBLISH_NOTE = "审计发布说明";

let pool: Pool;
let database: Database;
let server: Awaited<ReturnType<typeof buildHttpServer>>;
let attachments: AttachmentService;
let artifactRepository: ArtifactVersionRepository;
let storageRoot: string;
let roomFileRoot: string;
let databaseCreated = false;

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
  database = new Database(pool);
  storageRoot = await mkdtemp(join(tmpdir(), "suduo-audit-project-id-"));
  artifactRepository = new ArtifactVersionRepository(database);
  attachments = new AttachmentService(
    new AttachmentRepository(
      database,
      REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
    ),
    new AttachmentStorage(storageRoot, 1_024, new Set([".txt"])),
    artifactRepository,
  );
  await attachments.initialize();
  roomFileRoot = await mkdtemp(join(tmpdir(), "suduo-audit-room-files-"));
  const roomBlobStore = new LocalDiskBlobStore(roomFileRoot, ROOM_FILE_ROOT_MARKER);
  await roomBlobStore.initialize();
  server = await buildHttpServer({
    config: testConfig(storageRoot),
    database,
    auth: {} as AuthService,
    collaboration: new CollaborationService(new CollaborationRepository(database)),
    attachments,
    artifactVersions: new ArtifactVersionService(artifactRepository),
    attachmentStorage: new AttachmentStorage(storageRoot, 1_024, new Set([".txt"])),
    events: new RequirementsEventHub(),
    rooms: createRoomsModule({ database, blobStore: roomBlobStore }),
    aiCollab: new AiCollabService(new AiCollabRepository(database)),
  });
});

afterAll(async () => {
  await server?.close();
  await attachments?.close();
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
  if (roomFileRoot !== undefined) await rm(roomFileRoot, { recursive: true, force: true }).catch(() => undefined);
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
});

interface AuditExpectation {
  action: RecordedAuditAction;
  projectId: string;
  resourceType: AuditResourceType;
  resourceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

interface AuditCase {
  invoke(): Promise<readonly AuditExpectation[]>;
}

describe("审计项目归属与写入完备性", () => {
  it("所有 RECORDED_AUDIT_ACTIONS 都经 HTTP mutation 写入正确的审计 delta", async () => {
    const actorId = await createActor();
    let project: ProjectDto | undefined;
    let requirement: RequirementDto | undefined;
    let requirementVersion: number | undefined;
    let attachment: AttachmentMutationResponse["attachment"] | undefined;
    let room: RoomDto | undefined;
    let share: AgentShareDto | undefined;
    let sharedItem: SharedItemDetailDto | undefined;

    const cases: Record<RecordedAuditAction, AuditCase> = {
      "project.created": {
        invoke: async () => {
          const response = await server.inject({
            method: "POST", url: "/v2/projects", headers: authorization(actorId),
            payload: { name: "审计项目" },
          });
          expect(response.statusCode).toBe(201);
          project = response.json<ProjectDto>();
          return [{
            action: "project.created", projectId: project.id, resourceType: "project", resourceId: project.id,
            before: null, after: projectAudit(project),
          }];
        },
      },
      "project.updated": {
        invoke: async () => {
          const before = required(project, "项目");
          const response = await server.inject({
            method: "PATCH", url: `/v2/projects/${before.id}`, headers: authorization(actorId),
            payload: { name: "审计项目（已更新）" },
          });
          expect(response.statusCode).toBe(200);
          project = response.json<ProjectDto>();
          return [{
            action: "project.updated", projectId: project.id, resourceType: "project", resourceId: project.id,
            before: projectAudit(before), after: projectAudit(project),
          }];
        },
      },
      "project.archived": {
        invoke: async () => {
          const before = required(project, "项目");
          const response = await server.inject({
            method: "PATCH", url: `/v2/projects/${before.id}`, headers: authorization(actorId),
            payload: { isArchived: true },
          });
          expect(response.statusCode).toBe(200);
          project = response.json<ProjectDto>();
          return [{
            action: "project.archived", projectId: project.id, resourceType: "project", resourceId: project.id,
            before: projectAudit(before), after: projectAudit(project),
          }];
        },
      },
      "project.restored": {
        invoke: async () => {
          const before = required(project, "项目");
          const response = await server.inject({
            method: "PATCH", url: `/v2/projects/${before.id}`, headers: authorization(actorId),
            payload: { isArchived: false },
          });
          expect(response.statusCode).toBe(200);
          project = response.json<ProjectDto>();
          return [{
            action: "project.restored", projectId: project.id, resourceType: "project", resourceId: project.id,
            before: projectAudit(before), after: projectAudit(project),
          }];
        },
      },
      "requirement.created": {
        invoke: async () => {
          const currentProject = required(project, "项目");
          const response = await server.inject({
            method: "POST", url: `/v2/projects/${currentProject.id}/requirements`, headers: authorization(actorId),
            payload: { title: "审计需求", summary: "审计需求摘要", status: "draft" },
          });
          expect(response.statusCode).toBe(201);
          requirement = response.json<RequirementDto>();
          requirementVersion = requirement.version;
          return [{
            action: "requirement.created", projectId: currentProject.id, resourceType: "requirement", resourceId: requirement.id,
            before: null, after: { ...requirementAudit(requirement), assignee: null, priority: null },
          }];
        },
      },
      "requirement.updated": {
        invoke: async () => {
          const before = required(requirement, "需求");
          const response = await server.inject({
            method: "PATCH", url: `/v2/requirements/${before.id}`, headers: authorization(actorId),
            payload: { title: "审计需求（已更新）" },
          });
          expect(response.statusCode).toBe(200);
          requirement = response.json<RequirementDto>();
          requirementVersion = requirement.version;
          return [{
            action: "requirement.updated", projectId: requirement.projectId, resourceType: "requirement", resourceId: requirement.id,
            before: requirementAudit(before), after: requirementAudit(requirement),
          }];
        },
      },
      "requirement.status_changed": {
        invoke: async () => {
          const before = required(requirement, "需求");
          const response = await server.inject({
            method: "PATCH", url: `/v2/requirements/${before.id}`, headers: authorization(actorId),
            payload: { status: "in_refinement" },
          });
          expect(response.statusCode).toBe(200);
          requirement = response.json<RequirementDto>();
          requirementVersion = requirement.version;
          return [{
            action: "requirement.status_changed", projectId: requirement.projectId, resourceType: "requirement", resourceId: requirement.id,
            before: requirementAudit(before), after: requirementAudit(requirement),
          }];
        },
      },
      "requirement.assignee_changed": {
        invoke: async () => {
          const before = required(requirement, "需求");
          const response = await server.inject({
            method: "PATCH", url: `/v2/requirements/${before.id}`, headers: authorization(actorId),
            payload: { assigneeId: actorId },
          });
          expect(response.statusCode).toBe(200);
          requirement = response.json<RequirementDto>();
          expect(requirement.version).toBe(before.version);
          return [{
            action: "requirement.assignee_changed", projectId: requirement.projectId, resourceType: "requirement", resourceId: requirement.id,
            before: { assignee: null },
            after: { assignee: { id: actorId, displayName: "Audit User" } },
          }];
        },
      },
      "requirement.priority_changed": {
        invoke: async () => {
          const before = required(requirement, "需求");
          const response = await server.inject({
            method: "PATCH", url: `/v2/requirements/${before.id}`, headers: authorization(actorId),
            payload: { priority: "high" },
          });
          expect(response.statusCode).toBe(200);
          requirement = response.json<RequirementDto>();
          expect(requirement.version).toBe(before.version);
          return [{
            action: "requirement.priority_changed", projectId: requirement.projectId, resourceType: "requirement", resourceId: requirement.id,
            before: { priority: null },
            after: { priority: "high" },
          }];
        },
      },
      "comment.created": {
        invoke: async () => {
          const currentRequirement = required(requirement, "需求");
          const response = await server.inject({
            method: "POST", url: `/v2/requirements/${currentRequirement.id}/comments`, headers: authorization(actorId),
            payload: { body: "审计评论" },
          });
          expect(response.statusCode).toBe(201);
          const comment = response.json<CommentDto>();
          return [{
            action: "comment.created", projectId: currentRequirement.projectId, resourceType: "comment", resourceId: comment.id,
            before: null, after: { requirementId: comment.requirementId, body: comment.body },
          }];
        },
      },
      "attachment.created": {
        invoke: async () => {
          const currentRequirement = required(requirement, "需求");
          const attachmentId = randomUUID();
          const upload = multipartUpload("audit.txt", FILE_CONTENT);
          const response = await server.inject({
            method: "POST", url: `/v2/requirements/${currentRequirement.id}/attachments`,
            headers: {
              ...authorization(actorId), "content-type": upload.contentType,
              "idempotency-key": attachmentId, "x-attachment-size": String(FILE_CONTENT.byteLength),
            },
            payload: upload.payload,
          });
          expect(response.statusCode).toBe(201);
          const result = response.json<AttachmentMutationResponse>();
          attachment = result.attachment;
          requirementVersion = result.requirementVersion;
          return [{
            action: "attachment.created", projectId: currentRequirement.projectId, resourceType: "attachment", resourceId: attachment.id,
            before: null, after: attachmentAudit(attachment, result.requirementVersion),
          }];
        },
      },
      "attachment.downloaded": {
        invoke: async () => {
          const currentAttachment = required(attachment, "附件");
          const currentRequirement = required(requirement, "需求");
          const currentVersion = required(requirementVersion, "需求版本");
          const response = await server.inject({
            method: "GET", url: `/v2/attachments/${currentAttachment.id}/content`, headers: authorization(actorId),
          });
          expect(response.statusCode).toBe(200);
          expect(response.body).toBe(FILE_CONTENT.toString("utf8"));
          return [{
            action: "attachment.downloaded", projectId: currentRequirement.projectId, resourceType: "attachment", resourceId: currentAttachment.id,
            before: null, after: attachmentAudit(currentAttachment, currentVersion),
          }];
        },
      },
      "attachment.deleted": {
        invoke: async () => {
          const currentAttachment = required(attachment, "附件");
          const currentRequirement = required(requirement, "需求");
          const currentVersion = required(requirementVersion, "需求版本");
          const response = await server.inject({
            method: "DELETE", url: `/v2/attachments/${currentAttachment.id}/content`,
            headers: authorization(actorId),
          });
          expect(response.statusCode).toBe(200);
          const result = response.json<AttachmentMutationResponse>();
          requirementVersion = result.requirementVersion;
          return [{
            action: "attachment.deleted", projectId: currentRequirement.projectId, resourceType: "attachment", resourceId: currentAttachment.id,
            before: attachmentAudit(currentAttachment, currentVersion),
            after: { requirementId: currentRequirement.id, version: result.requirementVersion, deleted: true },
          }];
        },
      },
      "artifact_version.published": {
        invoke: async () => {
          const currentProject = required(project, "项目");
          const currentRequirement = required(requirement, "需求");
          const currentVersion = required(requirementVersion, "需求版本");
          const publishAttachmentId = randomUUID();
          await insertActiveAttachment(currentRequirement.id, actorId, publishAttachmentId, "publish.txt");
          const response = await server.inject({
            method: "POST", url: `/v2/requirements/${currentRequirement.id}/artifact-versions`, headers: authorization(actorId),
            payload: {
              operationKey: randomUUID(), attachmentIds: [publishAttachmentId], note: PUBLISH_NOTE,
            },
          });
          expect(response.statusCode).toBe(201);
          const artifactVersion = response.json<ArtifactVersionDetailDto>();
          requirementVersion = currentVersion;
          const comment = await publishComment(artifactVersion.id);
          return [
            {
              action: "artifact_version.published", projectId: currentProject.id, resourceType: "artifact_version", resourceId: artifactVersion.id,
              before: null,
              after: {
                requirementId: artifactVersion.requirementId,
                versionNumber: artifactVersion.versionNumber,
                fileCount: artifactVersion.fileCount,
                requirementVersion,
              },
            },
            {
              action: "comment.created", projectId: currentProject.id, resourceType: "comment", resourceId: comment.id,
              before: null,
              after: { requirementId: currentRequirement.id, artifactVersionId: artifactVersion.id, body: PUBLISH_NOTE },
            },
          ];
        },
      },
      "room.created": {
        invoke: async () => {
          const currentRequirement = required(requirement, "需求");
          const response = await server.inject({
            method: "POST", url: `/v2/requirements/${currentRequirement.id}/rooms`, headers: authorization(actorId),
            payload: { name: "审计房间" },
          });
          expect(response.statusCode).toBe(201);
          room = response.json<RoomDto>();
          return [{
            action: "room.created", projectId: currentRequirement.projectId, resourceType: "room", resourceId: room.id,
            before: null,
            after: { kind: "requirement", name: "审计房间", requirementId: currentRequirement.id, archived: false, memberIds: [actorId] },
          }];
        },
      },
      "room.renamed": {
        invoke: async () => {
          const before = required(room, "房间");
          const response = await server.inject({
            method: "PATCH", url: `/v2/rooms/${before.id}`, headers: authorization(actorId),
            payload: { name: "审计房间（改名）" },
          });
          expect(response.statusCode).toBe(200);
          room = response.json<RoomDto>();
          return [{
            action: "room.renamed", projectId: room.projectId, resourceType: "room", resourceId: room.id,
            before: roomAudit(before, false), after: roomAudit(room, false),
          }];
        },
      },
      "room.archived": {
        invoke: async () => {
          const before = required(room, "房间");
          const response = await server.inject({
            method: "PATCH", url: `/v2/rooms/${before.id}`, headers: authorization(actorId),
            payload: { archived: true },
          });
          expect(response.statusCode).toBe(200);
          room = response.json<RoomDto>();
          expect(room.archivedAt).not.toBeNull();
          return [{
            action: "room.archived", projectId: room.projectId, resourceType: "room", resourceId: room.id,
            before: roomAudit(before, false), after: roomAudit(room, true),
          }];
        },
      },
      "room.restored": {
        invoke: async () => {
          const before = required(room, "房间");
          const response = await server.inject({
            method: "PATCH", url: `/v2/rooms/${before.id}`, headers: authorization(actorId),
            payload: { archived: false },
          });
          expect(response.statusCode).toBe(200);
          room = response.json<RoomDto>();
          return [{
            action: "room.restored", projectId: room.projectId, resourceType: "room", resourceId: room.id,
            before: roomAudit(before, true), after: roomAudit(room, false),
          }];
        },
      },
      "agent_share.opened": {
        invoke: async () => {
          const currentRoom = required(room, "房间");
          const agentResponse = await server.inject({
            method: "POST", url: "/v2/agents", headers: authorization(actorId),
            payload: { deviceKey: "audit-device", deviceName: "审计设备" },
          });
          expect(agentResponse.statusCode).toBe(201);
          const agent = agentResponse.json<AgentDto>();
          const response = await server.inject({
            method: "POST", url: `/v2/rooms/${currentRoom.id}/shares`, headers: authorization(actorId),
            payload: { agentId: agent.id, duration: "until_closed" },
          });
          expect(response.statusCode).toBe(200);
          share = response.json<AgentShareDto>();
          return [{
            action: "agent_share.opened", projectId: currentRoom.projectId, resourceType: "agent_share", resourceId: share.id,
            before: null, after: { agentId: agent.id, roomId: currentRoom.id, expiresAt: null },
          }];
        },
      },
      "agent_share.closed": {
        invoke: async () => {
          const currentShare = required(share, "共享");
          const currentRoom = required(room, "房间");
          const response = await server.inject({
            method: "POST", url: `/v2/agent-shares/${currentShare.id}/close`, headers: authorization(actorId),
          });
          expect(response.statusCode).toBe(200);
          expect(response.json<AgentShareDto>().active).toBe(false);
          const audit = { agentId: currentShare.agent.id, roomId: currentRoom.id, expiresAt: null };
          return [{
            action: "agent_share.closed", projectId: currentRoom.projectId, resourceType: "agent_share", resourceId: currentShare.id,
            before: audit, after: { ...audit, closedReason: "closed" },
          }];
        },
      },
      "shared_item.published": {
        invoke: async () => {
          const currentRequirement = required(requirement, "需求");
          const response = await server.inject({
            method: "POST", url: `/v2/requirements/${currentRequirement.id}/shared-items`, headers: authorization(actorId),
            payload: { kind: "handoff", title: "审计交接包", content: { summary: "做到一半", decisions: [], todo: ["补测试"], risks: [], branch: null, files: [] }, agentId: "codex" },
          });
          expect(response.statusCode).toBe(201);
          sharedItem = response.json<SharedItemDetailDto>();
          return [{
            action: "shared_item.published", projectId: currentRequirement.projectId, resourceType: "shared_item", resourceId: sharedItem.id,
            before: null, after: { kind: "handoff", agentId: "codex", sizeBytes: sharedItem.sizeBytes },
          }];
        },
      },
      "shared_item.retracted": {
        invoke: async () => {
          const currentRequirement = required(requirement, "需求");
          const currentItem = required(sharedItem, "共享对象");
          const response = await server.inject({
            method: "POST", url: `/v2/shared-items/${currentItem.id}/retract`, headers: authorization(actorId),
          });
          expect(response.statusCode).toBe(200);
          return [{
            action: "shared_item.retracted", projectId: currentRequirement.projectId, resourceType: "shared_item", resourceId: currentItem.id,
            before: null, after: null,
          }];
        },
      },
      "ai_rules.updated": {
        invoke: async () => {
          const currentProject = required(project, "项目");
          const response = await server.inject({
            method: "PUT", url: `/v2/projects/${currentProject.id}/ai-rules`, headers: authorization(actorId),
            payload: { content: "# 规范\n- 先写测试" },
          });
          expect(response.statusCode).toBe(200);
          return [{
            action: "ai_rules.updated", projectId: currentProject.id, resourceType: "ai_rules", resourceId: currentProject.id,
            before: null, after: { version: 1, sizeBytes: Buffer.byteLength("# 规范\n- 先写测试", "utf8") },
          }];
        },
      },
    };

    for (const action of RECORDED_AUDIT_ACTIONS) {
      const beforeCount = await auditCount();
      const expected = await cases[action].invoke();
      expect(expected.some((entry) => entry.action === action)).toBe(true);
      await expectAuditDelta(beforeCount, expected);
    }

    const currentProject = required(project, "项目");
    const otherProjectResponse = await server.inject({
      method: "POST",
      url: "/v2/projects",
      headers: authorization(actorId),
      payload: { name: "其他项目" },
    });
    expect(otherProjectResponse.statusCode).toBe(201);
    const otherProject = otherProjectResponse.json<ProjectDto>();
    const unfiltered = await server.inject({
      method: "GET",
      url: "/v2/audit?limit=100",
      headers: authorization(actorId),
    });
    expect(unfiltered.statusCode).toBe(200);
    const unfilteredBody = unfiltered.json<ListAuditResponse>();
    expect(unfilteredBody.items.some((item) => item.resourceId === otherProject.id)).toBe(true);
    expect(unfilteredBody.items.every((item) => !("projectId" in item))).toBe(true);

    const filtered = await listAudit(actorId, currentProject.id, 100);
    // 过渡期 /v2/audit 只返回 AUDIT_ACTIONS：负责人变更已写入审计表，但不在此接口出现。
    expect(filtered.items).toHaveLength(13);
    expect(filtered.items.map((item) => item.action)).not.toContain(
      "requirement.assignee_changed",
    );
    expect(filtered.items.map((item) => item.action)).not.toContain(
      "requirement.priority_changed",
    );
    await expect(pool.query(
      "SELECT 1 FROM audit_logs WHERE project_id = $1 AND action = 'requirement.assignee_changed'",
      [currentProject.id],
    )).resolves.toMatchObject({ rowCount: 1 });
    const filteredIds = filtered.items.map((item) => item.id);
    const filteredProjects = await pool.query<{ project_id: string }>(
      "SELECT project_id FROM audit_logs WHERE id = ANY($1::uuid[])",
      [filteredIds],
    );
    expect(filteredProjects.rows).toHaveLength(13);
    expect(filteredProjects.rows.every((row) => row.project_id === currentProject.id)).toBe(true);

    const pagedIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listAudit(actorId, currentProject.id, 2, cursor);
      pagedIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(pagedIds).toEqual(filteredIds);
    expect(new Set(pagedIds).size).toBe(filteredIds.length);
  });

  it("附件 HTTP 忽略过期版本头并保持当前正文版本", async () => {
    const actorId = await createActor();
    const projectResponse = await server.inject({
      method: "POST",
      url: "/v2/projects",
      headers: authorization(actorId),
      payload: { name: "附件版本头兼容项目" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<ProjectDto>();
    const requirementResponse = await server.inject({
      method: "POST",
      url: `/v2/projects/${project.id}/requirements`,
      headers: authorization(actorId),
      payload: { title: "附件版本头兼容需求", summary: "验证旧头忽略", status: "draft" },
    });
    expect(requirementResponse.statusCode).toBe(201);
    const requirement = requirementResponse.json<RequirementDto>();
    const upload = multipartUpload("legacy-header.txt", FILE_CONTENT);
    const uploadResponse = await server.inject({
      method: "POST",
      url: `/v2/requirements/${requirement.id}/attachments`,
      headers: {
        ...authorization(actorId),
        "content-type": upload.contentType,
        "idempotency-key": randomUUID(),
        "x-attachment-size": String(FILE_CONTENT.byteLength),
        "x-requirement-expected-version": "999",
      },
      payload: upload.payload,
    });
    expect(uploadResponse.statusCode).toBe(201);
    const uploaded = uploadResponse.json<AttachmentMutationResponse>();
    expect(uploaded.requirementVersion).toBe(requirement.version);

    const deleteResponse = await server.inject({
      method: "DELETE",
      url: `/v2/attachments/${uploaded.attachment.id}/content`,
      headers: {
        ...authorization(actorId),
        "x-requirement-expected-version": "1",
      },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json<AttachmentMutationResponse>().requirementVersion)
      .toBe(requirement.version);
  });

  it("需求正文实变才写；同值与旧版本字段 PATCH 均返回当前 DTO", async () => {
    const actorId = await createActor();
    const original = await createMutationRequirement(actorId);
    const beforeAuditCount = await requirementAuditCount(original.id);

    const changedTitle = await patchRequirement(actorId, original.id, { title: "标题已改" });
    expect(changedTitle.version).toBe(original.version + 1);
    expect(changedTitle.updatedAt).not.toBe(original.updatedAt);

    const changedSummary = await patchRequirement(actorId, original.id, { summary: "摘要已改" });
    expect(changedSummary.version).toBe(original.version + 2);

    const changedStatus = await patchRequirement(actorId, original.id, { status: "in_refinement" });
    expect(changedStatus.version).toBe(original.version + 3);
    expect(await requirementAuditCount(original.id, "requirement.updated")).toBe(2);
    expect(await requirementAuditCount(original.id, "requirement.status_changed")).toBe(1);

    const noChangeBefore = await requirementWriteRow(original.id);
    const noChange = await server.inject({
      method: "PATCH",
      url: `/v2/requirements/${original.id}`,
      headers: authorization(actorId),
      payload: { title: changedStatus.title, summary: changedStatus.summary, status: changedStatus.status },
    });
    expect(noChange.statusCode).toBe(200);
    expect(noChange.json<RequirementDto>()).toEqual(changedStatus);
    expect(await requirementWriteRow(original.id)).toEqual(noChangeBefore);
    expect(await requirementAuditCount(original.id)).toBe(beforeAuditCount + 3);

    const direct = await new CollaborationService(new CollaborationRepository(database)).updateRequirement(
      actorId,
      original.id,
      { title: changedStatus.title },
    );
    expect(direct.changed).toBe(false);
    expect(direct.requirement).toEqual(changedStatus);

    const legacy = await server.inject({
      method: "PATCH",
      url: `/v2/requirements/${original.id}`,
      headers: authorization(actorId),
      payload: { title: "旧客户端字段仍可提交", expectedVersion: 999 },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json<RequirementDto>().version).toBe(original.version + 4);
  });

  it("两笔同值 PATCH 在预读屏障后只自增一次", async () => {
    const actorId = await createActor();
    const original = await createMutationRequirement(actorId);
    const barrierDatabase = databaseWithBeforeReadBarrier(pool);
    const collaboration = new CollaborationService(new CollaborationRepository(barrierDatabase));

    const results = await Promise.all([
      collaboration.updateRequirement(actorId, original.id, { title: "并发同值标题" }),
      collaboration.updateRequirement(actorId, original.id, { title: "并发同值标题" }),
    ]);

    expect(results.filter((result) => result.changed)).toHaveLength(1);
    const final = await getRequirementDto(original.id);
    expect(final.version).toBe(original.version + 1);
    expect(final.title).toBe("并发同值标题");
    expect(await requirementAuditCount(original.id, "requirement.updated")).toBe(1);
  });

  it("无版本前置时保留异字段合并与同字段后写覆盖", async () => {
    const actorId = await createActor();
    const merged = await createMutationRequirement(actorId);
    const clientARead = await getRequirementDto(merged.id);
    const clientBRead = await getRequirementDto(merged.id);
    expect(clientARead.version).toBe(clientBRead.version);

    await patchRequirement(actorId, merged.id, { title: "甲方标题" });
    await patchRequirement(actorId, merged.id, { summary: "乙方摘要" });
    const mergedFinal = await getRequirementDto(merged.id);
    expect(mergedFinal).toMatchObject({
      title: "甲方标题",
      summary: "乙方摘要",
      version: merged.version + 2,
    });
    expect(await requirementAuditCount(merged.id, "requirement.updated")).toBe(2);

    const overwritten = await createMutationRequirement(actorId);
    const overwriteARead = await getRequirementDto(overwritten.id);
    const overwriteBRead = await getRequirementDto(overwritten.id);
    expect(overwriteARead.version).toBe(overwriteBRead.version);
    await patchRequirement(actorId, overwritten.id, { title: "甲" });
    await patchRequirement(actorId, overwritten.id, { title: "乙" });
    const overwrittenFinal = await getRequirementDto(overwritten.id);
    expect(overwrittenFinal).toMatchObject({ title: "乙", version: overwritten.version + 2 });
    expect(await requirementAuditCount(overwritten.id, "requirement.updated")).toBe(2);
  });

  it("发布后续步骤失败时，自动评论审计与发布审计随同一事务回滚", async () => {
    const actorId = await createActor();
    const projectResponse = await server.inject({
      method: "POST",
      url: "/v2/projects",
      headers: authorization(actorId),
      payload: { name: "回滚审计项目" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<ProjectDto>();
    const requirementResponse = await server.inject({
      method: "POST",
      url: `/v2/projects/${project.id}/requirements`,
      headers: authorization(actorId),
      payload: { title: "回滚审计需求", summary: "验证事务", status: "draft" },
    });
    expect(requirementResponse.statusCode).toBe(201);
    const requirement = requirementResponse.json<RequirementDto>();
    const attachmentId = randomUUID();
    await insertActiveAttachment(requirement.id, actorId, attachmentId, "rollback.txt");
    const beforeCount = await auditCount();
    const recordOperation = vi.spyOn(artifactRepository, "recordPublishOperation")
      .mockRejectedValueOnce(new Error("模拟发布记录失败"));
    try {
      const response = await server.inject({
        method: "POST",
        url: `/v2/requirements/${requirement.id}/artifact-versions`,
        headers: authorization(actorId),
        payload: {
          operationKey: randomUUID(),
          attachmentIds: [attachmentId],
          note: PUBLISH_NOTE,
        },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      recordOperation.mockRestore();
    }
    await expect(auditCount()).resolves.toBe(beforeCount);
    await expect(tableCount("requirement_artifact_versions")).resolves.toBe(0);
    await expect(tableCount("requirement_comments")).resolves.toBe(0);
  });
});

async function createActor(): Promise<string> {
  const actorId = randomUUID();
  await pool.query(
    "INSERT INTO users (id, login_name, display_name, password_hash) VALUES ($1, 'audit-user', 'Audit User', 'test-password-hash')",
    [actorId],
  );
  return actorId;
}

async function createMutationRequirement(actorId: string): Promise<RequirementDto> {
  const projectResponse = await server.inject({
    method: "POST",
    url: "/v2/projects",
    headers: authorization(actorId),
    payload: { name: `正文实变项目-${randomUUID()}` },
  });
  expect(projectResponse.statusCode).toBe(201);
  const project = projectResponse.json<ProjectDto>();
  const requirementResponse = await server.inject({
    method: "POST",
    url: `/v2/projects/${project.id}/requirements`,
    headers: authorization(actorId),
    payload: { title: "初始标题", summary: "初始摘要", status: "draft" },
  });
  expect(requirementResponse.statusCode).toBe(201);
  return requirementResponse.json<RequirementDto>();
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

async function getRequirementDto(
  requirementId: string,
): Promise<Omit<RequirementDto, "assignee" | "commentCount" | "attachmentCount">> {
  const result = await pool.query<{
    id: string;
    project_id: string;
    number: number;
    title: string;
    summary: string;
    status: RequirementDto["status"];
    created_by_user: RequirementDto["createdBy"];
    updated_by_user: RequirementDto["updatedBy"];
    created_at: Date;
    updated_at: Date;
    version: number;
  }>(
    `
      SELECT r.id, r.project_id, r.number, r.title, r.summary, r.status,
             to_jsonb(creator) - 'password_hash' AS created_by_user,
             to_jsonb(updater) - 'password_hash' AS updated_by_user,
             r.created_at, r.updated_at, r.version
      FROM requirements r
      JOIN users creator ON creator.id = r.created_by
      JOIN users updater ON updater.id = r.updated_by
      WHERE r.id = $1
    `,
    [requirementId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("需求不存在");
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    title: row.title,
    summary: row.summary,
    status: row.status,
    createdBy: row.created_by_user,
    updatedBy: row.updated_by_user,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

async function requirementWriteRow(requirementId: string): Promise<{
  version: number;
  updated_at: Date;
  updated_by: string;
}> {
  const result = await pool.query<{
    version: number;
    updated_at: Date;
    updated_by: string;
  }>(
    "SELECT version, updated_at, updated_by FROM requirements WHERE id = $1",
    [requirementId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("需求不存在");
  return row;
}

async function requirementAuditCount(
  requirementId: string,
  action?: RecordedAuditAction,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM audit_logs
      WHERE resource_type = 'requirement'
        AND resource_id = $1
        ${action === undefined ? "" : "AND action = $2"}
    `,
    action === undefined ? [requirementId] : [requirementId, action],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function databaseWithBeforeReadBarrier(pool: Pool): Database {
  let arrivals = 0;
  let releaseBarrier: (() => void) | undefined;
  const allBeforeReads = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  return {
    pool,
    query: pool.query.bind(pool),
    async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let interceptedBeforeRead = false;
      const barrierClient = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "query") return Reflect.get(target, property, receiver);
          return async (text: unknown, values?: unknown) => {
            const result = await Reflect.apply(target.query, target, [text, values]);
            if (
              !interceptedBeforeRead &&
              typeof text === "string" &&
              text.includes("FROM requirements r")
            ) {
              interceptedBeforeRead = true;
              arrivals += 1;
              if (arrivals === 2) releaseBarrier?.();
              await allBeforeReads;
            }
            return result;
          };
        },
      }) as PoolClient;
      try {
        await client.query("BEGIN");
        const result = await work(barrierClient);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as Database;
}

async function insertActiveAttachment(
  requirementId: string,
  actorId: string,
  attachmentId: string,
  fileName: string,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO attachments (
        id, requirement_id, storage_key, file_name, content_type,
        size_bytes, sha256, uploaded_by
      ) VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, $7)
    `,
    [
      attachmentId,
      requirementId,
      `objects/${attachmentId.slice(0, 2)}/${attachmentId}`,
      fileName,
      FILE_CONTENT.byteLength,
      "a".repeat(64),
      actorId,
    ],
  );
}

async function publishComment(artifactVersionId: string): Promise<{ id: string }> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM requirement_comments WHERE artifact_version_id = $1",
    [artifactVersionId],
  );
  const comment = result.rows[0];
  if (comment === undefined) throw new Error("发布未创建自动评论");
  return comment;
}

async function auditCount(): Promise<number> {
  const result = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM audit_logs");
  return Number(result.rows[0]?.count ?? "0");
}

async function tableCount(table: "requirement_artifact_versions" | "requirement_comments"): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? "0");
}

async function listAudit(
  actorId: string,
  projectId: string,
  limit: number,
  cursor: string | null = null,
): Promise<ListAuditResponse> {
  const query = new URLSearchParams({ projectId, limit: String(limit) });
  if (cursor !== null) query.set("cursor", cursor);
  const response = await server.inject({
    method: "GET",
    url: `/v2/audit?${query.toString()}`,
    headers: authorization(actorId),
  });
  expect(response.statusCode).toBe(200);
  return response.json<ListAuditResponse>();
}

async function expectAuditDelta(
  beforeCount: number,
  expected: readonly AuditExpectation[],
): Promise<void> {
  await expect(auditCount()).resolves.toBe(beforeCount + expected.length);
  for (const entry of expected) {
    const rows = await pool.query<{
      project_id: string;
      resource_type: AuditResourceType;
      resource_id: string;
      action: RecordedAuditAction;
      before_json: Record<string, unknown> | null;
      after_json: Record<string, unknown> | null;
    }>(
      `
        SELECT project_id, resource_type, resource_id, action, before_json, after_json
        FROM audit_logs
        WHERE project_id = $1 AND resource_type = $2 AND resource_id = $3 AND action = $4
      `,
      [entry.projectId, entry.resourceType, entry.resourceId, entry.action],
    );
    expect(rows.rows).toEqual([{
      project_id: entry.projectId,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId,
      action: entry.action,
      before_json: entry.before,
      after_json: entry.after,
    }]);
  }
}

function multipartUpload(fileName: string, content: Buffer): { contentType: string; payload: Buffer } {
  const boundary = `----suduo-audit-${randomUUID()}`;
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
  return { authorization: `Bearer ${server.jwt.sign({ sub: actorId, loginName: "audit-user" })}` };
}

function roomAudit(room: RoomDto, archived: boolean): Record<string, unknown> {
  return { kind: room.kind, name: room.name, requirementId: room.requirement?.id ?? null, archived };
}

function projectAudit(project: ProjectDto): Record<string, unknown> {
  return { name: project.name, isArchived: project.isArchived, version: project.version };
}

function requirementAudit(requirement: RequirementDto): Record<string, unknown> {
  return {
    projectId: requirement.projectId,
    title: requirement.title,
    summary: requirement.summary,
    status: requirement.status,
    version: requirement.version,
  };
}

function attachmentAudit(
  attachment: AttachmentMutationResponse["attachment"],
  version: number,
): Record<string, unknown> {
  return {
    requirementId: attachment.requirementId,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    version,
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label}尚未由前置 HTTP case 创建`);
  return value;
}

function testConfig(attachmentRoot: string): RequirementsServiceConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgresql://unused",
    databasePoolMax: 2,
    databaseConnectionTimeoutMs: 100,
    authSecret: "audit-project-id-test-secret-at-least-thirty-two-characters",
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
