import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { ROOM_FILE_MAX_BYTES, type RoomFileDto } from "@suduo/cloud-contracts";
import type { RoomFileRecord, RoomFileRepository } from "../../infrastructure/rooms/file-repository.js";
import type { RoomRepository } from "../../infrastructure/rooms/room-repository.js";
import type { BlobRange, BlobStore } from "../../infrastructure/storage/blob-store.js";
import { ApplicationError, notFound } from "../errors.js";
import { normalizeRoomFile } from "./file-types.js";

/**
 * 房间文件（模块「存储」+「媒体」）：先上传、发消息时再关联。
 * 业务只认 BlobStore 接口（首期本机磁盘），存储只增不删；下载不写审计。
 */
export class RoomFileService {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly files: RoomFileRepository,
    private readonly store: BlobStore,
    private readonly allowedExtensions: ReadonlySet<string>,
    readonly maxBytes: number = ROOM_FILE_MAX_BYTES,
  ) {}

  /** 上传前检查房间存在（不读请求体就能拒绝）。 */
  async assertRoomExists(roomId: string): Promise<void> {
    await this.rooms.requireRef(roomId);
  }

  async upload(input: {
    actorId: string;
    roomId: string;
    stream: AsyncIterable<Uint8Array | string> & { truncated?: boolean };
    fileName: string;
    contentType: string;
    /** multipart 解析完成（上传没有中断）。 */
    completion: Promise<void>;
  }): Promise<RoomFileDto> {
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
      roomId: input.roomId,
      fileName: normalized.fileName,
      contentType: normalized.contentType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      uploadedBy: input.actorId,
    });
  }

  async find(fileId: string): Promise<RoomFileRecord> {
    const record = await this.files.find(fileId);
    if (record === null) throw notFound("File");
    return record;
  }

  open(record: RoomFileRecord, range?: BlobRange): Promise<Readable> {
    return this.store.open(record.storageKey, range);
  }
}

/**
 * 存储读流失败但不是业务错误时，多半是 multipart 解析器中断了流（多余字段、连接断开）：
 * 以解析器给出的原因为准（400 / 413），等不到就用原错误。
 */
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
