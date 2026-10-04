import { randomUUID } from "node:crypto";
import type {
  AddRoomMembersRequest,
  CreateRequirementRoomRequest,
  ListRoomMembersResponse,
  ListRoomsResponse,
  MarkRoomReadRequest,
  RoomDto,
  RoomViewerStateDto,
  RoomAuditAction,
  UpdateRoomRequest,
} from "@suduo/cloud-contracts";
import { insertAuditLog } from "../../infrastructure/audit-log.js";
import type { Database, QueryExecutor } from "../../infrastructure/database.js";
import type { RoomRef, RoomRepository } from "../../infrastructure/rooms/room-repository.js";
import { stripNul } from "../../infrastructure/rooms/sql.js";
import { ApplicationError, notFound } from "../errors.js";
import { roomEvent, type WithEvents } from "./events.js";

/**
 * 房间、成员、已读（模块「房间」）。
 * 房间对所有登录用户可见可加入，不做房间级权限；成员只决定未读、提醒与 @ 候选（需求 R1）。
 */
export class RoomService {
  constructor(
    private readonly database: Database,
    private readonly rooms: RoomRepository,
  ) {}

  /** 项目的房间：先惰性建默认房间（合并，不重复），再列出默认房间 + 需求房间。 */
  async listProjectRooms(viewerId: string, projectId: string): Promise<ListRoomsResponse> {
    if (!(await this.rooms.ensureDefaultRoom(projectId))) throw notFound("Project");
    return { items: await this.rooms.listProjectRooms(projectId, viewerId) };
  }

  async listRequirementRooms(viewerId: string, requirementId: string): Promise<ListRoomsResponse> {
    await this.requireRequirement(this.database, requirementId);
    return { items: await this.rooms.listRequirementRooms(requirementId, viewerId) };
  }

  get(viewerId: string, roomId: string): Promise<RoomDto> {
    return this.rooms.getRoom(roomId, viewerId);
  }

  /** 新建需求房间：初始成员 = 创建人 + 需求负责人 + 需求创建人 + memberIds。 */
  async createRequirementRoom(
    actorId: string,
    requirementId: string,
    request: CreateRequirementRoomRequest,
  ): Promise<WithEvents<RoomDto>> {
    const room = await this.database.transaction(async (client) => {
      const requirement = await this.requireRequirement(client, requirementId);
      const extraMembers = request.memberIds ?? [];
      await this.assertUsersExist(client, extraMembers, "memberIds");
      const name = request.name === undefined ? `REQ-${requirement.number} 讨论` : roomName(request.name);
      const id = randomUUID();
      await this.rooms.insertRequirementRoom(client, {
        id,
        projectId: requirement.projectId,
        requirementId,
        name,
        createdBy: actorId,
      });
      const memberIds = [
        actorId,
        requirement.assigneeId,
        requirement.createdBy,
        ...extraMembers,
      ].filter((value): value is string => value !== null);
      await this.rooms.addMembers(client, id, memberIds);
      await insertAuditLog(client, {
        actorId,
        projectId: requirement.projectId,
        requirementId,
        resourceType: "room",
        resourceId: id,
        action: "room.created",
        before: null,
        after: {
          kind: "requirement",
          name,
          requirementId,
          archived: false,
          memberIds: [...new Set(memberIds)].sort(),
        },
      });
      return this.rooms.getRoom(id, actorId, client);
    });
    return { value: room, events: [roomEvent.changed(room)] };
  }

  /**
   * 改名 / 归档：后写生效，不按版本拒绝（ADR-0004，人可自行改回）。
   * 默认房间名称跟随项目，改名是输入错误（400）。没有实际变化时不写审计、不推送。
   */
  async update(actorId: string, roomId: string, request: UpdateRoomRequest): Promise<WithEvents<RoomDto>> {
    const result = await this.database.transaction(async (client) => {
      const before = await this.rooms.lock(client, roomId);
      const actions: Array<{ action: RoomAuditAction; after: Record<string, unknown> }> = [];
      let current = roomAudit(before);
      if (request.name !== undefined) {
        if (before.kind === "project_default") {
          throw new ApplicationError(400, "VALIDATION_ERROR", "The project room is named after its project and can't be renamed", {
            field: "name",
          });
        }
        const name = roomName(request.name);
        if (name !== before.name) {
          await this.rooms.rename(client, roomId, name);
          current = { ...current, name };
          actions.push({ action: "room.renamed", after: current });
        }
      }
      if (request.archived !== undefined && request.archived !== (before.archivedAt !== null)) {
        await this.rooms.setArchived(client, roomId, request.archived);
        current = { ...current, archived: request.archived };
        actions.push({ action: request.archived ? "room.archived" : "room.restored", after: current });
      }
      let previous = roomAudit(before);
      for (const entry of actions) {
        await insertAuditLog(client, {
          actorId,
          projectId: before.projectId,
          requirementId: before.requirementId,
          resourceType: "room",
          resourceId: roomId,
          action: entry.action,
          before: previous,
          after: entry.after,
        });
        previous = entry.after;
      }
      return { room: await this.rooms.getRoom(roomId, actorId, client), changed: actions.length > 0 };
    });
    return { value: result.room, events: result.changed ? [roomEvent.changed(result.room)] : [] };
  }

  async listMembers(roomId: string): Promise<ListRoomMembersResponse> {
    const room = await this.rooms.requireRef(roomId);
    return { items: await this.rooms.listMembers(room) };
  }

  /**
   * 加入或拉人（缺省 = 自己加入）。已是成员的跳过（合并）。
   * 默认房间的成员是隐式的全部用户，不需要加，直接返回成员列表。
   */
  async addMembers(
    actorId: string,
    roomId: string,
    request: AddRoomMembersRequest,
  ): Promise<WithEvents<ListRoomMembersResponse>> {
    const userIds = request.userIds === undefined || request.userIds.length === 0 ? [actorId] : request.userIds;
    const { room, added } = await this.database.transaction(async (client) => {
      const room = await this.rooms.requireRef(roomId, client);
      if (room.kind === "project_default") return { room, added: [] as string[] };
      await this.assertUsersExist(client, userIds, "userIds");
      return { room, added: await this.rooms.addMembers(client, roomId, userIds) };
    });
    const members = { items: await this.rooms.listMembers(room) };
    if (added.length === 0) return { value: members, events: [] };
    const dto = await this.rooms.getRoom(roomId, null);
    return { value: members, events: [roomEvent.members(dto)] };
  }

  /**
   * 记已读：只前进，回退请求按「已读位置不变」处理，不报错。
   * 需求房间不是成员时不记（成员才有未读），返回的 viewer.joined=false。
   */
  async markRead(viewerId: string, roomId: string, request: MarkRoomReadRequest): Promise<RoomViewerStateDto> {
    const room = await this.rooms.requireRef(roomId);
    await this.rooms.recordRead(this.database, room, viewerId, request.upToSeq);
    return (await this.rooms.getRoom(roomId, viewerId)).viewer;
  }

  private async requireRequirement(
    executor: QueryExecutor,
    requirementId: string,
  ): Promise<{ projectId: string; number: number; createdBy: string; assigneeId: string | null }> {
    const result = await executor.query<{
      project_id: string;
      number: number;
      created_by: string;
      assignee_id: string | null;
    }>(
      "SELECT project_id, number, created_by, assignee_id FROM requirements WHERE id = $1",
      [requirementId],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("Requirement");
    return {
      projectId: row.project_id,
      number: row.number,
      createdBy: row.created_by,
      assigneeId: row.assignee_id,
    };
  }

  /** 引用的用户必须存在：输入校验（400），不是并发守卫。 */
  private async assertUsersExist(executor: QueryExecutor, userIds: readonly string[], field: string): Promise<void> {
    const existing = await this.rooms.existingUserIds(executor, userIds);
    const missing = [...new Set(userIds)].filter((id) => !existing.has(id));
    if (missing.length > 0) {
      throw new ApplicationError(400, "VALIDATION_ERROR", "User not found", { field, userIds: missing });
    }
  }
}

/** 房间名：去掉 NUL（PostgreSQL 不收，见 stripNul）与首尾空白后 1 到 120 个字。 */
function roomName(raw: string): string {
  const name = stripNul(raw).trim();
  if (name === "" || Array.from(name).length > 120) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "Room name must be 1 to 120 characters", { field: "name" });
  }
  return name;
}

function roomAudit(room: RoomRef): Record<string, unknown> {
  return {
    kind: room.kind,
    name: room.name,
    requirementId: room.requirementId,
    archived: room.archivedAt !== null,
  };
}
