import type { DatabasePort } from "../database-port.js";

export type AuditAnchorState = "known" | "empty" | "unavailable" | "unknown";

/** tools = 挂 suduo_* 工具的新会话；legacy = 旧版（快照 + 现状文件，已不再刷新）。 */
export type RequirementSessionContextMode = "tools" | "legacy";

export interface RequirementAuditAnchor {
  state: AuditAnchorState;
  createdAt: string | null;
  id: string | null;
}

/**
 * 需求会话的开工登记：哪条需求、开工时的版本与审计水位线。工具回答「开工以后的
 * 变化」时以此为分界（需求会话上下文重做 R3）。
 */
export interface RequirementSessionRefRecord {
  sessionId: string;
  remoteProjectId: string;
  remoteRequirementId: string;
  /** 开工时的需求版本。 */
  requirementVersion: number;
  /** 旧版会话的需求快照目录；新会话为 null。 */
  materialPath: string | null;
  manifestSha256: string | null;
  auditAnchor: RequirementAuditAnchor;
  requirementNumber: number | null;
  requirementTitle: string | null;
  contextMode: RequirementSessionContextMode;
  createdAt: number;
}

interface RequirementSessionRefRow {
  session_id: string;
  remote_project_id: string;
  remote_requirement_id: string;
  requirement_version: number;
  material_path: string | null;
  manifest_sha256: string | null;
  audit_anchor_created_at: string | null;
  audit_anchor_id: string | null;
  anchor_state: AuditAnchorState;
  requirement_number: number | null;
  requirement_title: string | null;
  context_mode: RequirementSessionContextMode;
  created_at: number;
}

export class RequirementSessionRefRepository {
  constructor(private readonly database: DatabasePort) {}

  create(input: {
    sessionId: string;
    remoteProjectId: string;
    remoteRequirementId: string;
    requirementVersion: number;
    auditAnchor?: RequirementAuditAnchor;
    /** 默认 tools；只有测试会造旧版数据。 */
    contextMode?: RequirementSessionContextMode;
    materialPath?: string | null;
    manifestSha256?: string | null;
    now?: number;
    /** 远程需求编号快照（供跨项目会话列表）；旧版需求服务没有编号时为 null。 */
    requirementNumber?: number | null;
    /** 远程需求标题快照。 */
    requirementTitle?: string | null;
  }): RequirementSessionRefRecord {
    const now = input.now ?? Date.now();
    const auditAnchor = input.auditAnchor ?? { state: "unknown", createdAt: null, id: null };
    assertAuditAnchor(auditAnchor);
    const requirementNumber =
      typeof input.requirementNumber === "number" &&
      Number.isSafeInteger(input.requirementNumber) &&
      input.requirementNumber > 0
        ? input.requirementNumber
        : null;
    const requirementTitle =
      typeof input.requirementTitle === "string" && input.requirementTitle.trim() !== ""
        ? input.requirementTitle.trim()
        : null;
    this.database
      .prepare(
        [
          "INSERT INTO v2_requirement_session_refs",
          "(session_id, remote_project_id, remote_requirement_id, requirement_version, material_path, manifest_sha256, audit_anchor_created_at, audit_anchor_id, anchor_state, created_at, requirement_number, requirement_title, context_mode)",
          "VALUES (@sessionId, @remoteProjectId, @remoteRequirementId, @requirementVersion, @materialPath, @manifestSha256, @auditAnchorCreatedAt, @auditAnchorId, @anchorState, @now, @requirementNumber, @requirementTitle, @contextMode)",
        ].join(" "),
      )
      .run({
        sessionId: input.sessionId,
        remoteProjectId: input.remoteProjectId,
        remoteRequirementId: input.remoteRequirementId,
        requirementVersion: input.requirementVersion,
        materialPath: input.materialPath ?? null,
        manifestSha256: input.manifestSha256 ?? null,
        auditAnchorCreatedAt: auditAnchor.createdAt,
        auditAnchorId: auditAnchor.id,
        anchorState: auditAnchor.state,
        now,
        requirementNumber,
        requirementTitle,
        contextMode: input.contextMode ?? "tools",
      });
    const saved = this.getBySessionId(input.sessionId);
    if (!saved) {
      throw new Error("requirement session ref was not persisted");
    }
    return saved;
  }

  getBySessionId(sessionId: string): RequirementSessionRefRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM v2_requirement_session_refs WHERE session_id = @sessionId",
      )
      .get<RequirementSessionRefRow>({ sessionId });
    return row ? mapRecord(row) : null;
  }

  listAll(): RequirementSessionRefRecord[] {
    return this.database
      .prepare(
        [
          "SELECT * FROM v2_requirement_session_refs",
          "ORDER BY created_at DESC, session_id",
        ].join(" "),
      )
      .all<RequirementSessionRefRow>()
      .map(mapRecord);
  }

  listByRemoteProjectId(remoteProjectId: string): RequirementSessionRefRecord[] {
    return this.database
      .prepare(
        [
          "SELECT * FROM v2_requirement_session_refs",
          "WHERE remote_project_id = @remoteProjectId",
          "ORDER BY created_at DESC, session_id",
        ].join(" "),
      )
      .all<RequirementSessionRefRow>({ remoteProjectId })
      .map(mapRecord);
  }

  /** 同一条需求在本机最近一次开工的会话（不含 excludeSessionId、不含已删除会话）。 */
  latestForRequirement(
    remoteRequirementId: string,
    excludeSessionId?: string,
  ): RequirementSessionRefRecord | null {
    const row = this.database
      .prepare(
        [
          "SELECT ref.* FROM v2_requirement_session_refs ref",
          "JOIN sessions session ON session.id = ref.session_id",
          "WHERE ref.remote_requirement_id = @remoteRequirementId",
          "AND session.state <> 'deleted'",
          "AND ref.session_id <> @excludeSessionId",
          "ORDER BY ref.created_at DESC, ref.session_id",
          "LIMIT 1",
        ].join(" "),
      )
      .get<RequirementSessionRefRow>({
        remoteRequirementId,
        excludeSessionId: excludeSessionId ?? "",
      });
    return row ? mapRecord(row) : null;
  }

  /** 旧版会话重建线程、挂上工具之后改成新版（tools）。 */
  markContextMode(sessionId: string, contextMode: RequirementSessionContextMode): void {
    this.database
      .prepare("UPDATE v2_requirement_session_refs SET context_mode = @contextMode WHERE session_id = @sessionId")
      .run({ sessionId, contextMode });
  }

  /**
   * 每条远程需求在本机关联的未删除会话数（含已归档）。没有会话的需求不出现在结果里。
   */
  countLiveSessionsByRequirementIds(
    remoteRequirementIds: readonly string[],
  ): Map<string, number> {
    const ids = [...new Set(remoteRequirementIds)];
    if (ids.length === 0) return new Map();
    const rows = this.database
      .prepare(
        [
          "SELECT ref.remote_requirement_id AS requirement_id, COUNT(*) AS session_count",
          "FROM v2_requirement_session_refs ref",
          "JOIN sessions session ON session.id = ref.session_id",
          "WHERE session.state <> 'deleted'",
          "AND ref.remote_requirement_id IN (SELECT value FROM json_each(@ids))",
          "GROUP BY ref.remote_requirement_id",
        ].join(" "),
      )
      .all<{ requirement_id: string; session_count: number }>({
        ids: JSON.stringify(ids),
      });
    return new Map(rows.map((row) => [row.requirement_id, Number(row.session_count)]));
  }
}

function mapRecord(row: RequirementSessionRefRow): RequirementSessionRefRecord {
  return {
    sessionId: row.session_id,
    remoteProjectId: row.remote_project_id,
    remoteRequirementId: row.remote_requirement_id,
    requirementVersion: row.requirement_version,
    materialPath: row.material_path,
    manifestSha256: row.manifest_sha256,
    auditAnchor: {
      state: row.anchor_state,
      createdAt: row.audit_anchor_created_at,
      id: row.audit_anchor_id,
    },
    requirementNumber: row.requirement_number,
    requirementTitle: row.requirement_title,
    contextMode: row.context_mode,
    createdAt: row.created_at,
  };
}

function assertAuditAnchor(anchor: RequirementAuditAnchor): void {
  const hasCursor = anchor.createdAt !== null || anchor.id !== null;
  if (anchor.state === "known") {
    if (anchor.createdAt === null || anchor.id === null) {
      throw new Error("known audit anchor requires createdAt and id");
    }
    if (Number.isNaN(Date.parse(anchor.createdAt)) || !isUuid(anchor.id)) {
      throw new Error("known audit anchor contains an invalid remote cursor");
    }
    return;
  }
  if (hasCursor) {
    throw new Error(`${anchor.state} audit anchor must not contain a cursor`);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
