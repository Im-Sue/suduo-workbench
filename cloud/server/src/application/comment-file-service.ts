import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { COMMENT_FILE_MAX_BYTES, type CommentFileDto } from "@suduo/cloud-contracts";
import type { CommentFileRecord, CommentFileRepository } from "../infrastructure/comment-file-repository.js";
import type { BlobRange, BlobStore } from "../infrastructure/storage/blob-store.js";
import type { AttachmentService } from "./attachment-service.js";
import { ApplicationError, notFound } from "./errors.js";
import { normalizeRoomFile } from "./rooms/file-types.js";

/**
 * 评论文件（需求附件评论文件与优先级 4.2）：先上传、发评论时再挂上。
 * - 字节放在房间文件那份存储里（只增不删，备份与部署已覆盖），不放附件目录：附件存储启动时会清掉不认识的对象；
 * - 允许的类型取附件的清单，保证「存为附件」一定能存；内容类型按扩展名定，缩略图判断才可靠；
 * - 「存为附件」复制字节，交给附件服务按普通上传处理（上限、审计、sha256 都照旧）。
 */
export class CommentFileService {
  constructor(
    private readonly files: CommentFileRepository,
    private readonly store: BlobStore,
    private readonly attachments: AttachmentService,
    private readonly allowedExtensions: ReadonlySet<string>,
    readonly maxBytes: number = COMMENT_FILE_MAX_BYTES,
  ) {}

  /** 上传前检查需求存在（不读请求体就能拒绝）。 */
  async assertRequirementExists(requirementId: string): Promise<void> {
    if (!(await this.files.requirementExists(requirementId))) throw notFound("Requirement");
  }

  async upload(input: {
    actorId: string;
    requirementId: string;
    stream: AsyncIterable<Uint8Array | string> & { truncated?: boolean };
    fileName: string;
    contentType: string;
    /** multipart 解析完成（上传没有中断）。 */
    completion: Promise<void>;
  }): Promise<CommentFileDto> {
    const normalized = normalizeRoomFile(input.fileName, input.contentType, this.allowedExtensions);
    let stored;
    try {
      stored = await this.store.put({ stream: input.stream, maxBytes: this.maxBytes });
    } catch (error) {
      throw error instanceof ApplicationError ? error : await parseFailure(input.completion, error);
    }
    // 之后的失败只会留下一个没有元数据的对象：存储只增不删（ADR-0004 红线），不在这里删除字节。
    await input.completion;
    if (input.stream.truncated === true) {
      throw new ApplicationError(413, "ATTACHMENT_TOO_LARGE", "File exceeds the 300 MiB limit");
    }
    return this.files.insert({
      id: randomUUID(),
      requirementId: input.requirementId,
      fileName: normalized.fileName,
      contentType: normalized.contentType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      uploadedBy: input.actorId,
    });
  }

  async find(fileId: string): Promise<CommentFileRecord> {
    const record = await this.files.find(fileId);
    if (record === null) throw notFound("Comment file");
    return record;
  }

  open(record: CommentFileRecord, range?: BlobRange): Promise<Readable> {
    return this.store.open(record.storageKey, range);
  }

  /** 把评论文件复制成这条需求的一个新附件（上传人记为操作人）。计入附件上限。 */
  async saveAsAttachment(actorId: string, fileId: string) {
    const record = await this.find(fileId);
    const stream = await this.open(record);
    try {
      return await this.attachments.upload({
        actorId,
        attachmentId: randomUUID(),
        requirementId: record.file.requirementId,
        stream,
        fileName: record.file.fileName,
        contentType: record.file.contentType,
        declaredSize: record.file.sizeBytes,
      });
    } finally {
      // 附件服务在读流之前就可能拒绝（到达上限、类型不允许、磁盘空间不足）：没读完的流要关掉，免得泄漏文件句柄。
      stream.destroy();
    }
  }
}

/** 同房间文件：存储读流失败但不是业务错误时，以 multipart 解析器给出的原因为准。 */
async function parseFailure(completion: Promise<void>, original: unknown): Promise<unknown> {
  const reason = await Promise.race([
    completion.then(
      () => null,
      (error: unknown) => error,
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000).unref()),
  ]);
  return reason instanceof ApplicationError ? reason : original;
}
