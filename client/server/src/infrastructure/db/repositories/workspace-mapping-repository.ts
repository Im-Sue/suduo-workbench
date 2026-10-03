import type { DatabasePort } from "../database-port.js";

export interface WorkspaceMappingRecord {
  remoteProjectId: string;
  localProjectId: string;
  createdAt: number;
  updatedAt: number;
  lastValidatedAt: number;
}

interface WorkspaceMappingRow {
  remote_project_id: string;
  local_project_id: string;
  created_at: number;
  updated_at: number;
  last_validated_at: number;
}

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

  getByLocalProjectId(localProjectId: string): WorkspaceMappingRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM v2_project_workspace_mappings WHERE local_project_id = @localProjectId",
      )
      .get<WorkspaceMappingRow>({ localProjectId });
    return row ? mapRecord(row) : null;
  }

  list(): WorkspaceMappingRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM v2_project_workspace_mappings ORDER BY updated_at DESC, remote_project_id",
      )
      .all<WorkspaceMappingRow>()
      .map(mapRecord);
  }

  save(input: {
    remoteProjectId: string;
    localProjectId: string;
    now?: number;
  }): WorkspaceMappingRecord {
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO v2_project_workspace_mappings",
          "(remote_project_id, local_project_id, created_at, updated_at, last_validated_at)",
          "VALUES (@remoteProjectId, @localProjectId, @now, @now, @now)",
          "ON CONFLICT(remote_project_id) DO UPDATE SET",
          "local_project_id = excluded.local_project_id,",
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at,
  };
}
