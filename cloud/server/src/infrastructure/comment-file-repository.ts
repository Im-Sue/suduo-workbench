import type { CommentFileDto, UserSummaryDto } from "@suduo/cloud-contracts";
import { ApplicationError } from "../application/errors.js";
import { roomFileKind } from "../application/rooms/file-types.js";
import type { Database, QueryExecutor } from "./database.js";

/** 评论文件的元数据与存储键（存储键只在云端内部用）。 */
export interface CommentFileRecord {
  file: CommentFileDto;
  storageKey: string;
}

interface CommentFileRow {
  id: string;
  requirement_id: string;
  comment_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  created_at: Date;
  uploaded_by_user: UserSummaryDto;
}

const COLUMNS = `
  f.id, f.requirement_id, f.comment_id, f.file_name, f.content_type, f.size_bytes, f.sha256, f.storage_key, f.created_at,
  json_build_object('id', uploader.id, 'displayName', uploader.display_name) AS uploaded_by_user
`;

const FROM = `
  FROM requirement_comment_files f
  JOIN users uploader ON uploader.id = f.uploaded_by
`;

/**
 * 评论文件（需求附件评论文件与优先级 4.2）。只增不删（删除字节是 ADR-0004 红线）：
 * 上传后 comment_id 为空，发评论时挂上；没发出去的留着，不自动清理（需求 R7）。
 */
export class CommentFileRepository {
  constructor(private readonly database: Database) {}

  /** 上传前检查需求存在（不读请求体就能拒绝）。 */
  async requirementExists(requirementId: string): Promise<boolean> {
    const result = await this.database.query("SELECT 1 FROM requirements WHERE id = $1", [requirementId]);
    return (result.rowCount ?? 0) > 0;
  }

  async insert(input: {
    id: string;
    requirementId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
    uploadedBy: string;
  }): Promise<CommentFileDto> {
    await this.database.query(
      `
        INSERT INTO requirement_comment_files (
          id, requirement_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        input.id,
        input.requirementId,
        input.fileName,
        input.contentType,
        input.sizeBytes,
        input.sha256,
        input.storageKey,
        input.uploadedBy,
      ],
    );
    const record = await this.find(input.id);
    if (record === null) throw new Error("comment file disappeared right after insert");
    return record.file;
  }

  async find(fileId: string): Promise<CommentFileRecord | null> {
    const result = await this.database.query<CommentFileRow>(`SELECT ${COLUMNS} ${FROM} WHERE f.id = $1`, [fileId]);
    const row = result.rows[0];
    return row === undefined ? null : { file: mapCommentFile(row), storageKey: row.storage_key };
  }
}

/** 一批评论各自的文件，按发送时的顺序。没有文件的评论不在结果里。 */
export async function commentFilesByComment(
  executor: QueryExecutor,
  commentIds: readonly string[],
): Promise<Map<string, CommentFileDto[]>> {
  const byComment = new Map<string, CommentFileDto[]>();
  if (commentIds.length === 0) return byComment;
  const result = await executor.query<CommentFileRow>(
    `SELECT ${COLUMNS} ${FROM} WHERE f.comment_id = ANY($1::uuid[]) ORDER BY f.comment_id, f.position`,
    [[...new Set(commentIds)]],
  );
  for (const row of result.rows) {
    const commentId = row.comment_id!;
    const list = byComment.get(commentId) ?? [];
    list.push(mapCommentFile(row));
    byComment.set(commentId, list);
  }
  return byComment;
}

/**
 * 发评论时锁住要挂的文件：必须属于这条需求、还没随别的评论发出。对不上就 400，整个发评论事务回滚。
 * 不校验上传人（与房间文件一致）。挂到别的评论上的文件不能改挂：评论一经提交不可改（ADR-0004 红线），
 * 改挂会让原评论悄悄少掉文件、无法恢复。返回值按传入顺序。
 */
export async function lockUnsentCommentFiles(
  executor: QueryExecutor,
  requirementId: string,
  fileIds: readonly string[],
): Promise<Array<{ id: string; fileName: string }>> {
  const result = await executor.query<{ id: string; file_name: string }>(
    `
      SELECT id, file_name FROM requirement_comment_files
      WHERE id = ANY($1::uuid[]) AND requirement_id = $2 AND comment_id IS NULL
      FOR UPDATE
    `,
    [[...fileIds], requirementId],
  );
  const found = new Map(result.rows.map((row) => [row.id, row.file_name]));
  const missing = fileIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApplicationError(
      400,
      "VALIDATION_ERROR",
      "Some files don't exist, belong to another requirement, or were already sent with another comment",
      { field: "fileIds", fileIds: missing },
    );
  }
  return fileIds.map((id) => ({ id, fileName: found.get(id)! }));
}

/** 把已锁住的文件挂到评论上，position 从 1 起按传入顺序。 */
export async function attachFilesToComment(
  executor: QueryExecutor,
  commentId: string,
  fileIds: readonly string[],
): Promise<void> {
  await executor.query(
    `
      UPDATE requirement_comment_files f
      SET comment_id = $1, position = ordered.position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, position)
      WHERE f.id = ordered.id
    `,
    [commentId, [...fileIds]],
  );
}

function mapCommentFile(row: CommentFileRow): CommentFileDto {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    commentId: row.comment_id,
    fileName: row.file_name,
    contentType: row.content_type,
    kind: roomFileKind(row.content_type),
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    uploadedBy: row.uploaded_by_user,
    createdAt: row.created_at.toISOString(),
  };
}
