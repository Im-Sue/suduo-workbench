import type { DatabasePort } from "../database-port.js";

export interface WorkspaceMappingRecord {
  remoteProjectId: string;
  localProjectId: string;
  /** 建立关联时连着的服务器（规范化后的地址）；null = 升级前的存量，启动时记为当前服务器。 */
  serverOrigin: string | null;
  createdAt: number;
  updatedAt: number;
  lastValidatedAt: number;
}

interface WorkspaceMappingRow {
  remote_project_id: string;
  local_project_id: string;
  server_origin: string | null;
  created_at: number;
  updated_at: number;
  last_validated_at: number;
}

/**
 * 远程项目 → 本机目录（本机项目）的关联。按服务器区分（迁移 018）：列表类查询只看给定服务器的关联；
 * 一个本机目录可以关联多个项目。会话的所属项目不从这里反查，见 ProjectSessionRefRepository。
 */
export class WorkspaceMappingRepository {
  constructor(private readonly database: DatabasePort) {}

  getByRemoteProjectId(remoteProjectId: string): WorkspaceMappingRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM v2_project_workspace_mappings WHERE remote_project_id = @remoteProjectId",
      )
      .get<WorkspaceMappingRow>({ remoteProjectId });
    return row ? mapRecord(row) : null;
  }

  /** 给定服务器的全部关联，最近使用在前；未配置服务器（null）时为空。 */
  list(serverOrigin: string | null): WorkspaceMappingRecord[] {
    if (serverOrigin === null) {
      return [];
    }
    return this.database
      .prepare(
        [
          "SELECT * FROM v2_project_workspace_mappings WHERE server_origin = @serverOrigin",
          "ORDER BY updated_at DESC, remote_project_id",
        ].join(" "),
      )
      .all<WorkspaceMappingRow>({ serverOrigin })
      .map(mapRecord);
  }

  /** 给定服务器上关联到这个本机目录（本机项目）的全部关联。 */
  listByLocalProjectId(serverOrigin: string | null, localProjectId: string): WorkspaceMappingRecord[] {
    if (serverOrigin === null) {
      return [];
    }
    return this.database
      .prepare(
        [
          "SELECT * FROM v2_project_workspace_mappings",
          "WHERE server_origin = @serverOrigin AND local_project_id = @localProjectId",
          "ORDER BY updated_at DESC, remote_project_id",
        ].join(" "),
      )
      .all<WorkspaceMappingRow>({ serverOrigin, localProjectId })
      .map(mapRecord);
  }

  save(input: {
    remoteProjectId: string;
    localProjectId: string;
    serverOrigin: string;
    now?: number;
  }): WorkspaceMappingRecord {
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO v2_project_workspace_mappings",
          "(remote_project_id, local_project_id, server_origin, created_at, updated_at, last_validated_at)",
          "VALUES (@remoteProjectId, @localProjectId, @serverOrigin, @now, @now, @now)",
          "ON CONFLICT(remote_project_id) DO UPDATE SET",
          "local_project_id = excluded.local_project_id,",
          "server_origin = excluded.server_origin,",
          "updated_at = excluded.updated_at,",
          "last_validated_at = excluded.last_validated_at",
        ].join(" "),
      )
      .run({ ...input, now });
    const saved = this.getByRemoteProjectId(input.remoteProjectId);
    if (!saved) {
      throw new Error("workspace mapping was not persisted");
    }
    return saved;
  }

  touchValidated(remoteProjectId: string, now = Date.now()): void {
    this.database
      .prepare(
        [
          "UPDATE v2_project_workspace_mappings",
          "SET last_validated_at = @now, updated_at = @now",
          "WHERE remote_project_id = @remoteProjectId",
        ].join(" "),
      )
      .run({ remoteProjectId, now });
  }

  /** 升级前的存量关联（server_origin 为空）记为给定服务器；返回改了几条。 */
  adoptUnscoped(serverOrigin: string): number {
    return this.database
      .prepare(
        "UPDATE v2_project_workspace_mappings SET server_origin = @serverOrigin WHERE server_origin IS NULL",
      )
      .run({ serverOrigin }).changes;
  }

  remove(remoteProjectId: string): boolean {
    return (
      this.database
        .prepare(
          "DELETE FROM v2_project_workspace_mappings WHERE remote_project_id = @remoteProjectId",
        )
        .run({ remoteProjectId }).changes === 1
    );
  }
}

function mapRecord(row: WorkspaceMappingRow): WorkspaceMappingRecord {
  return {
    remoteProjectId: row.remote_project_id,
    localProjectId: row.local_project_id,
    serverOrigin: row.server_origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at,
  };
}
