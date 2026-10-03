import type { RoomFileDto } from "@suduo/cloud-contracts";
import type { Database, QueryExecutor } from "../database.js";
import { FILE_COLUMNS, mapFile, requiredRow, type FileRow } from "./sql.js";

export interface RoomFileRecord {
  file: RoomFileDto;
  storageKey: string;
}

/** 房间文件元数据。文件只增不删（删除字节是 ADR-0004 红线）。 */
export class RoomFileRepository {
  constructor(private readonly database: Database) {}

  async insert(input: {
    id: string;
    roomId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
    uploadedBy: string;
  }): Promise<RoomFileDto> {
    await this.database.query(
      `
        INSERT INTO room_files (id, room_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        input.id,
        input.roomId,
        input.fileName,
        input.contentType,
        input.sizeBytes,
        input.sha256,
        input.storageKey,
        input.uploadedBy,
      ],
    );
    return requiredRow((await this.find(input.id)) ?? undefined).file;
  }

  async find(fileId: string): Promise<RoomFileRecord | null> {
    const result = await this.database.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM room_files f WHERE f.id = $1`, [fileId]);
    const row = result.rows[0];
    return row === undefined ? null : { file: mapFile(row), storageKey: row.storage_key };
  }

  /** 这些文件里哪些属于该房间。 */
  async idsInRoom(executor: QueryExecutor, roomId: string, fileIds: readonly string[]): Promise<Set<string>> {
    if (fileIds.length === 0) return new Set();
    const result = await executor.query<{ id: string }>(
      "SELECT id FROM room_files WHERE room_id = $1 AND id = ANY($2::uuid[])",
      [roomId, [...fileIds]],
    );
    return new Set(result.rows.map((row) => row.id));
  }
}
