import { Readable } from "node:stream";
import { REQUIREMENTS_V2_SCHEMAS, type AttachmentMutationResponse } from "@suduo/cloud-contracts";
import type { FastifyInstance } from "fastify";
import type { CommentFileService } from "../../application/comment-file-service.js";
import { ApplicationError, errorResponse } from "../../application/errors.js";
import type { RequirementsEventHub } from "../../application/event-hub.js";
import { roomFileDisposition } from "../../application/rooms/file-types.js";
import { parseRangeHeader } from "../../infrastructure/storage/blob-store.js";
import { actorId, contentDisposition, headerValue, idSchema } from "../http-helpers.js";
import { singleMultipartFile } from "../multipart.js";

/**
 * 评论文件（需求附件评论文件与优先级 4.2）：上传、元数据、下载 / 内联、存为附件。全部需登录。
 * 下载规则同房间文件（图片 / 视频 / pdf 原样内联，文本按纯文本，其余一律下载；支持分段），下载不写审计。
 */
export function registerCommentFileRoutes(
  server: FastifyInstance,
  files: CommentFileService,
  events: RequirementsEventHub,
): void {
  // 上传：multipart 单个 `file` 字段；先传，发评论时再挂上。
  server.post<{ Params: { requirementId: string }; Body: Readable }>(
    "/v2/requirements/:requirementId/comment-files",
    { schema: { params: idSchema("requirementId") } },
    async (request, reply) => {
      const contentType = headerValue(request.headers["content-type"]);
      if (!contentType || !(request.body instanceof Readable)) {
        throw new ApplicationError(400, "ATTACHMENT_INVALID", "A multipart file upload is required");
      }
      try {
        await files.assertRequirementExists(request.params.requirementId);
      } catch (error) {
        request.body.resume();
        throw error;
      }
      // 解析器多放 1 字节：超限由存储层按 413 拒绝并清理半截文件，不会存下被截断的内容。
      const file = await singleMultipartFile(request.body, contentType, files.maxBytes + 1);
      try {
        const uploaded = await files.upload({
          actorId: actorId(request),
          requirementId: request.params.requirementId,
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

  // 元数据：会话工具据此确认文件属于哪条需求。
  server.get<{ Params: { fileId: string } }>(
    "/v2/comment-files/:fileId",
    { schema: { params: idSchema("fileId") } },
    async (request) => (await files.find(request.params.fileId)).file,
  );

  server.get<{ Params: { fileId: string }; Querystring: { disposition?: "inline" | "attachment" } }>(
    "/v2/comment-files/:fileId/content",
    { schema: { params: idSchema("fileId"), querystring: REQUIREMENTS_V2_SCHEMAS.commentFileContentQuery } },
    async (request, reply) => {
      const record = await files.find(request.params.fileId);
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
        const stream = await files.open(record);
        return reply.header("Content-Length", String(size)).send(stream);
      }
      const stream = await files.open(record, range);
      return reply
        .code(206)
        .headers({
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Content-Length": String(range.end - range.start + 1),
        })
        .send(stream);
    },
  );

  // 存为附件：复制成这条需求的新附件，广播 attachment.changed。
  server.post<{ Params: { fileId: string } }>(
    "/v2/comment-files/:fileId/save-as-attachment",
    { schema: { params: idSchema("fileId") } },
    async (request, reply) => {
      const result = await files.saveAsAttachment(actorId(request), request.params.fileId);
      events.publish({
        type: "attachment.changed",
        projectId: result.projectId,
        requirementId: result.attachment.requirementId,
        requirementVersion: result.requirementVersion,
      });
      return reply.code(201).send({
        attachment: result.attachment,
        requirementVersion: result.requirementVersion,
      } satisfies AttachmentMutationResponse);
    },
  );
}
