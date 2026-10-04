import { Readable } from "node:stream";
import {
  REQUIREMENTS_V2_ROOM_SCHEMAS,
  type AddRoomMembersRequest,
  type CreateRequirementRoomRequest,
  type ListRoomMessagesQuery,
  type MarkRoomReadRequest,
  type SearchRoomMessagesQuery,
  type SendRoomMessageRequest,
  type UpdateRoomRequest,
} from "@suduo/cloud-contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApplicationError, errorResponse } from "../../application/errors.js";
import { roomFileDisposition } from "../../application/rooms/file-types.js";
import type { RoomsModule } from "../../application/rooms/module.js";
import { parseRangeHeader } from "../../infrastructure/storage/blob-store.js";
import { actorId, contentDisposition, emit, headerValue, idSchema } from "../http-helpers.js";
import { singleMultipartFile } from "../multipart.js";

const SCHEMAS = REQUIREMENTS_V2_ROOM_SCHEMAS;

/** 请求体全是可选字段的端点：没带请求体按空对象处理。 */
export async function defaultEmptyBody(request: FastifyRequest): Promise<void> {
  if (request.body === undefined || request.body === null) request.body = {};
}

/** 房间、成员、已读、消息、文件（模块「房间」「消息」「媒体」）。全部需登录。 */
export function registerRoomRoutes(server: FastifyInstance, module: RoomsModule): void {
  const { realtime } = module;

  server.get<{ Params: { projectId: string } }>(
    "/v2/projects/:projectId/rooms",
    { schema: { params: idSchema("projectId") } },
    async (request) => module.rooms.listProjectRooms(actorId(request), request.params.projectId),
  );

  server.get<{ Params: { requirementId: string } }>(
    "/v2/requirements/:requirementId/rooms",
    { schema: { params: idSchema("requirementId") } },
    async (request) => module.rooms.listRequirementRooms(actorId(request), request.params.requirementId),
  );

  server.post<{ Params: { requirementId: string }; Body: CreateRequirementRoomRequest }>(
    "/v2/requirements/:requirementId/rooms",
    {
      preValidation: defaultEmptyBody,
      schema: { params: idSchema("requirementId"), body: SCHEMAS.createRequirementRoom },
    },
    async (request, reply) => {
      const room = emit(
        realtime,
        await module.rooms.createRequirementRoom(actorId(request), request.params.requirementId, request.body),
      );
      return reply.code(201).send(room);
    },
  );

  server.get<{ Params: { roomId: string } }>(
    "/v2/rooms/:roomId",
    { schema: { params: idSchema("roomId") } },
    async (request) => module.rooms.get(actorId(request), request.params.roomId),
  );

  server.patch<{ Params: { roomId: string }; Body: UpdateRoomRequest }>(
    "/v2/rooms/:roomId",
    { schema: { params: idSchema("roomId"), body: SCHEMAS.updateRoom } },
    async (request) => emit(realtime, await module.rooms.update(actorId(request), request.params.roomId, request.body)),
  );

  server.get<{ Params: { roomId: string } }>(
    "/v2/rooms/:roomId/members",
    { schema: { params: idSchema("roomId") } },
    async (request) => module.rooms.listMembers(request.params.roomId),
  );

  server.post<{ Params: { roomId: string }; Body: AddRoomMembersRequest }>(
    "/v2/rooms/:roomId/members",
    {
      preValidation: defaultEmptyBody,
      schema: { params: idSchema("roomId"), body: SCHEMAS.addRoomMembers },
    },
    async (request) =>
      emit(realtime, await module.rooms.addMembers(actorId(request), request.params.roomId, request.body)),
  );

  // 已读：个人状态，不写审计、不推送；返回当前用户在房间里的视角。
  server.post<{ Params: { roomId: string }; Body: MarkRoomReadRequest }>(
    "/v2/rooms/:roomId/read",
    { schema: { params: idSchema("roomId"), body: SCHEMAS.markRoomRead } },
    async (request) => module.rooms.markRead(actorId(request), request.params.roomId, request.body),
  );

  server.get<{ Params: { roomId: string }; Querystring: ListRoomMessagesQuery }>(
    "/v2/rooms/:roomId/messages",
    { schema: { params: idSchema("roomId"), querystring: SCHEMAS.listRoomMessages } },
    async (request) => module.messages.list(request.params.roomId, request.query),
  );

  // 发消息：新消息 201；按客户端 ID 合并到已有消息时 200（不重复建任务、不重复推送）。
  server.post<{ Params: { roomId: string }; Body: SendRoomMessageRequest }>(
    "/v2/rooms/:roomId/messages",
    { schema: { params: idSchema("roomId"), body: SCHEMAS.sendRoomMessage } },
    async (request, reply) => {
      const result = emit(
        realtime,
        await module.messages.send(actorId(request), request.params.roomId, request.body),
      );
      return reply.code(result.created ? 201 : 200).send(result.message);
    },
  );

  server.get<{ Params: { roomId: string }; Querystring: SearchRoomMessagesQuery }>(
    "/v2/rooms/:roomId/messages/search",
    { schema: { params: idSchema("roomId"), querystring: SCHEMAS.searchRoomMessages } },
    async (request) => module.messages.search(request.params.roomId, request.query),
  );

  // 上传：multipart 单个 `file` 字段；文件先传，发消息时再关联。
  server.post<{ Params: { roomId: string }; Body: Readable }>(
    "/v2/rooms/:roomId/files",
    { schema: { params: idSchema("roomId") } },
    async (request, reply) => {
      const contentType = headerValue(request.headers["content-type"]);
      if (!contentType || !(request.body instanceof Readable)) {
        throw new ApplicationError(400, "ATTACHMENT_INVALID", "A multipart file upload is required");
      }
      try {
        await module.files.assertRoomExists(request.params.roomId);
      } catch (error) {
        request.body.resume();
        throw error;
      }
      // 解析器多放 1 字节：超限由存储层按 413 拒绝并清理半截文件，不会存下被截断的内容。
      const file = await singleMultipartFile(request.body, contentType, module.files.maxBytes + 1);
      try {
        const uploaded = await module.files.upload({
          actorId: actorId(request),
          roomId: request.params.roomId,
          stream: file.stream,
          fileName: file.filename,
          contentType: file.mimeType,
          completion: file.completion,
        });
        return reply.code(201).send(uploaded);
      } catch (error) {
        file.cancel();
        throw error;
      }
    },
  );

  // 下载 / 内联 / 分段（视频拖动进度）。下载不写审计。
  server.get<{ Params: { fileId: string }; Querystring: { disposition?: "inline" | "attachment" } }>(
    "/v2/room-files/:fileId/content",
    { schema: { params: idSchema("fileId"), querystring: SCHEMAS.roomFileContentQuery } },
    async (request, reply) => {
      const record = await module.files.find(request.params.fileId);
      const size = record.file.sizeBytes;
      const presentation = roomFileDisposition(record.file.contentType, request.query.disposition);
      reply.headers({
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: `"${record.file.sha256}"`,
        "X-Content-Type-Options": "nosniff",
        "X-Attachment-Sha256": record.file.sha256,
      });
      const range = parseRangeHeader(headerValue(request.headers.range), size);
      if (range === "unsatisfiable") {
        return reply
          .code(416)
          .header("Content-Range", `bytes */${size}`)
          .send(errorResponse(new ApplicationError(416, "VALIDATION_ERROR", "Requested range is outside the file size"), request.id));
      }
      reply.headers({
        "Content-Type": presentation.contentType,
        "Content-Disposition": contentDisposition(presentation.inline ? "inline" : "attachment", record.file.fileName),
      });
      if (range === null) {
        const stream = await module.files.open(record);
        return reply.header("Content-Length", String(size)).send(stream);
      }
      const stream = await module.files.open(record, range);
      return reply
        .code(206)
        .headers({
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Content-Length": String(range.end - range.start + 1),
        })
        .send(stream);
    },
  );
}
