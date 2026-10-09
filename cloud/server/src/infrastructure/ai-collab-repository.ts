import { randomUUID } from "node:crypto";
import type {
  AiActivityDto,
  ProjectAiRulesDto,
  ProjectAiRulesVersionDetailDto,
  ProjectAiRulesVersionDto,
  SaveProjectAiRulesResponse,
  SharedItemContent,
  SharedItemDetailDto,
  SharedItemDto,
  SharedItemKind,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import { AI_ACTIVITY_LIST_LIMIT } from "@suduo/cloud-contracts";
import { notFound } from "../application/errors.js";
import { insertAuditLog } from "./audit-log.js";
import type { Database, QueryExecutor } from "./database.js";

interface SharedItemRow {
  id: string;
  requirement_id: string;
  project_id: string;
  kind: SharedItemKind;
  title: string;
  content?: SharedItemContent | null;
  size_bytes: number;
  agent_id: string | null;
  session_ref: string | null;
  published_by_user: UserSummaryDto;
  published_at: Date;
  retracted_at: Date | null;
  retracted_by_user: UserSummaryDto | null;
  read_count: string | number;
}

interface RulesRow {
  version: number;
  content: string;
  updated_by_user: UserSummaryDto;
  created_at: Date;
  size_bytes: string | number;
}

interface ActivityRow {
  id: string;
  requirement_id: string;
  member_user: UserSummaryDto;
  agent_id: string;
  kind: string;
  status: string;
  branch: string | null;
  occurred_at: Date;
  created_at: Date;
  updated_at: Date;
}

const SHARED_ITEM_SELECT = `
  SELECT
    s.id, s.requirement_id, s.project_id, s.kind, s.title, s.size_bytes, s.agent_id, s.session_ref,
    json_build_object('id', publisher.id, 'displayName', publisher.display_name) AS published_by_user,
    s.published_at, s.retracted_at,
    CASE WHEN retractor.id IS NULL THEN NULL
      ELSE json_build_object('id', retractor.id, 'displayName', retractor.display_name) END AS retracted_by_user,
    (SELECT COUNT(*) FROM requirement_shared_item_reads r WHERE r.item_id = s.id)::text AS read_count
`;

const SHARED_ITEM_FROM = `
  FROM requirement_shared_items s
  JOIN users publisher ON publisher.id = s.published_by
  LEFT JOIN users retractor ON retractor.id = s.retracted_by
`;

const RULES_SELECT = `
  SELECT r.version, octet_length(r.content)::text AS size_bytes, r.created_at,
    json_build_object('id', editor.id, 'displayName', editor.display_name) AS updated_by_user
`;

const ACTIVITY_SELECT = `
  SELECT a.id, a.requirement_id, a.agent_id, a.kind, a.status, a.branch, a.occurred_at, a.created_at, a.updated_at,
    json_build_object('id', member.id, 'displayName', member.display_name) AS member_user
  FROM requirement_ai_activity a
  JOIN users member ON member.id = a.member_id
`;

/**
 * 多 Agent 协作的团队共享部分（迁移 017）：需求共享对象、项目 AI 规范、协作记录。审计与写入同一事务。
 */
export class AiCollabRepository {
  constructor(private readonly database: Database) {}

  /** 需求所属项目；需求不在为 404。 */
  async requirementProject(requirementId: string, executor: QueryExecutor = this.database): Promise<string> {
    const result = await executor.query<{ project_id: string }>("SELECT project_id FROM requirements WHERE id = $1", [requirementId]);
    const row = result.rows[0];
    if (row === undefined) throw notFound("Requirement");
    return row.project_id;
  }

  async assertProject(projectId: string, executor: QueryExecutor = this.database): Promise<void> {
    const result = await executor.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
    if (result.rowCount === 0) throw notFound("Project");
  }

  // ───────────────────────────── 需求共享对象 ─────────────────────────────

  async publishSharedItem(input: {
    actorId: string;
    requirementId: string;
    kind: SharedItemKind;
    title: string;
    content: SharedItemContent;
    sizeBytes: number;
    agentId: string | null;
    sessionRef: string | null;
  }): Promise<{ item: SharedItemDetailDto; projectId: string }> {
    return this.database.transaction(async (client) => {
      const projectId = await this.requirementProject(input.requirementId, client);
      const id = randomUUID();
      await client.query(
        `
          INSERT INTO requirement_shared_items (id, project_id, requirement_id, kind, title, content, size_bytes, agent_id, session_ref, published_by)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
        `,
        [id, projectId, input.requirementId, input.kind, input.title, JSON.stringify(input.content), input.sizeBytes, input.agentId, input.sessionRef, input.actorId],
      );
      // 审计表只追加不删：不放标题（撤回后也收不回），只记种类、来源 Agent 与大小。
      await insertAuditLog(client, {
        actorId: input.actorId,
        projectId,
        requirementId: input.requirementId,
        resourceType: "shared_item",
        resourceId: id,
        action: "shared_item.published",
        before: null,
        after: { kind: input.kind, agentId: input.agentId, sizeBytes: input.sizeBytes },
      });
      return { item: await this.getSharedItem(id, client), projectId };
    });
  }

  /** 需求上的共享对象，新的在前（不带内容）。 */
  async listSharedItems(requirementId: string): Promise<SharedItemDto[]> {
    await this.requirementProject(requirementId);
    const result = await this.database.query<SharedItemRow>(
      `${SHARED_ITEM_SELECT} ${SHARED_ITEM_FROM} WHERE s.requirement_id = $1 ORDER BY s.published_at DESC, s.id DESC`,
      [requirementId],
    );
    return result.rows.map(mapSharedItem);
  }

  /**
   * 读一个共享对象（带内容）；读的人不是发布人时记一笔「读过」。共享锁住这一行：和撤回互斥，
   * 「读过」与拿到的内容、撤回时算的读过人数对得上。
   */
  async readSharedItem(id: string, readerId: string): Promise<SharedItemDetailDto> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<{ published_by: string; retracted_at: Date | null }>(
        "SELECT published_by, retracted_at FROM requirement_shared_items WHERE id = $1 FOR SHARE",
        [id],
      );
      const row = locked.rows[0];
      if (row === undefined) throw notFound("Shared item");
      if (row.published_by !== readerId && row.retracted_at === null) {
        await client.query(
          "INSERT INTO requirement_shared_item_reads (item_id, reader_id) VALUES ($1, $2) ON CONFLICT (item_id, reader_id) DO NOTHING",
          [id, readerId],
        );
      }
      return this.getSharedItem(id, client);
    });
  }

  /** 撤回：内容从服务器删掉，记下谁撤的；记录、标题与读过的人数留着。已撤回的再撤回原样返回。 */
  async retractSharedItem(id: string, actorId: string): Promise<{ item: SharedItemDetailDto; changed: boolean; projectId: string }> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<{ project_id: string; requirement_id: string }>(
        "SELECT project_id, requirement_id FROM requirement_shared_items WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = locked.rows[0];
      if (row === undefined) throw notFound("Shared item");
      const updated = await client.query(
        "UPDATE requirement_shared_items SET content = NULL, retracted_at = clock_timestamp(), retracted_by = $2 WHERE id = $1 AND retracted_at IS NULL",
        [id, actorId],
      );
      const changed = (updated.rowCount ?? 0) > 0;
      if (changed) {
        await insertAuditLog(client, {
          actorId,
          projectId: row.project_id,
          requirementId: row.requirement_id,
          resourceType: "shared_item",
          resourceId: id,
          action: "shared_item.retracted",
          before: null,
          after: null,
        });
      }
      return { item: await this.getSharedItem(id, client), changed, projectId: row.project_id };
    });
  }

  private async getSharedItem(id: string, executor: QueryExecutor): Promise<SharedItemDetailDto> {
    const result = await executor.query<SharedItemRow>(`${SHARED_ITEM_SELECT}, s.content ${SHARED_ITEM_FROM} WHERE s.id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined) throw notFound("Shared item");
    return { ...mapSharedItem(row), content: row.content ?? null };
  }

  // ───────────────────────────── 项目 AI 规范 ─────────────────────────────

  async currentRules(projectId: string): Promise<ProjectAiRulesDto> {
    await this.assertProject(projectId);
    return this.latestRules(projectId, this.database);
  }

  async listRuleVersions(projectId: string): Promise<ProjectAiRulesVersionDto[]> {
    await this.assertProject(projectId);
    const result = await this.database.query<RulesRow>(
      `${RULES_SELECT} FROM project_ai_rules r JOIN users editor ON editor.id = r.updated_by WHERE r.project_id = $1 ORDER BY r.version DESC`,
      [projectId],
    );
    return result.rows.map(mapVersion);
  }

  async getRuleVersion(projectId: string, version: number): Promise<ProjectAiRulesVersionDetailDto> {
    await this.assertProject(projectId);
    const result = await this.database.query<RulesRow>(
      `${RULES_SELECT}, r.content FROM project_ai_rules r JOIN users editor ON editor.id = r.updated_by WHERE r.project_id = $1 AND r.version = $2`,
      [projectId, version],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound("AI rules version");
    return { ...mapVersion(row), content: row.content };
  }

  /**
   * 保存即新版本：项目行加锁排队取下一个版本号（同时保存的两次依次成为两个版本，后写入的是当前版本，不拒绝，ADR-0004）。
   * 内容和当前版本一样时不新增。带了 baseVersion 时回包列出这期间别人存过的版本（只检测、告知）。
   */
  async saveRules(projectId: string, actorId: string, content: string, baseVersion?: number): Promise<{ rules: SaveProjectAiRulesResponse; changed: boolean }> {
    return this.database.transaction(async (client) => {
      // 同 collaboration-repository：只排队写，不挡别的事务插入引用这个项目的行。
      const locked = await client.query("SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE", [projectId]);
      if (locked.rowCount === 0) throw notFound("Project");
      const current = await this.latestRules(projectId, client);
      const skipped =
        baseVersion === undefined || baseVersion >= current.version
          ? []
          : (
              await client.query<RulesRow>(
                `${RULES_SELECT} FROM project_ai_rules r JOIN users editor ON editor.id = r.updated_by WHERE r.project_id = $1 AND r.version > $2 ORDER BY r.version DESC`,
                [projectId, baseVersion],
              )
            ).rows.map(mapVersion);
      if (current.version > 0 && current.content === content) return { rules: { ...current, skippedVersions: skipped }, changed: false };
      const version = current.version + 1;
      await client.query("INSERT INTO project_ai_rules (project_id, version, content, updated_by) VALUES ($1, $2, $3, $4)", [projectId, version, content, actorId]);
      await insertAuditLog(client, {
        actorId,
        projectId,
        requirementId: null,
        resourceType: "ai_rules",
        resourceId: projectId,
        action: "ai_rules.updated",
        before: current.version === 0 ? null : { version: current.version },
        after: { version, sizeBytes: Buffer.byteLength(content, "utf8") },
      });
      return { rules: { ...(await this.latestRules(projectId, client)), skippedVersions: skipped }, changed: true };
    });
  }

  private async latestRules(projectId: string, executor: QueryExecutor): Promise<ProjectAiRulesDto> {
    const result = await executor.query<RulesRow>(
      `${RULES_SELECT}, r.content FROM project_ai_rules r JOIN users editor ON editor.id = r.updated_by WHERE r.project_id = $1 ORDER BY r.version DESC LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) return { projectId, version: 0, content: "", updatedBy: null, updatedAt: null };
    return { projectId, version: row.version, content: row.content, updatedBy: row.updated_by_user, updatedAt: row.created_at.toISOString() };
  }

  // ───────────────────────────── 协作记录 ─────────────────────────────

  /**
   * 上报一条协作记录：同一成员、同一类型、同一本机编号再报时更新状态与分支；本机发生时间比记下的旧（补发的旧状态）
   * 不覆盖，照样返回现在记着的那条（不拒绝）。
   */
  async recordActivity(input: {
    actorId: string;
    requirementId: string;
    localRef: string;
    agentId: string;
    kind: string;
    status: string;
    branch: string | null;
    occurredAt: Date;
  }): Promise<{ activity: AiActivityDto; projectId: string; changed: boolean }> {
    return this.database.transaction(async (client) => {
      const projectId = await this.requirementProject(input.requirementId, client);
      const upserted = await client.query(
        `
          INSERT INTO requirement_ai_activity (id, project_id, requirement_id, member_id, local_ref, agent_id, kind, status, branch, occurred_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (requirement_id, member_id, kind, local_ref) DO UPDATE
            SET agent_id = EXCLUDED.agent_id, status = EXCLUDED.status, branch = EXCLUDED.branch,
                occurred_at = EXCLUDED.occurred_at, updated_at = clock_timestamp()
            WHERE requirement_ai_activity.occurred_at <= EXCLUDED.occurred_at
        `,
        [randomUUID(), projectId, input.requirementId, input.actorId, input.localRef, input.agentId, input.kind, input.status, input.branch, input.occurredAt],
      );
      const result = await client.query<ActivityRow>(`${ACTIVITY_SELECT} WHERE a.requirement_id = $1 AND a.member_id = $2 AND a.kind = $3 AND a.local_ref = $4`, [
        input.requirementId,
        input.actorId,
        input.kind,
        input.localRef,
      ]);
      return { activity: mapActivity(result.rows[0]!), projectId, changed: (upserted.rowCount ?? 0) > 0 };
    });
  }

  async listActivity(requirementId: string): Promise<AiActivityDto[]> {
    await this.requirementProject(requirementId);
    const result = await this.database.query<ActivityRow>(`${ACTIVITY_SELECT} WHERE a.requirement_id = $1 ORDER BY a.updated_at DESC, a.id DESC LIMIT $2`, [
      requirementId,
      AI_ACTIVITY_LIST_LIMIT,
    ]);
    return result.rows.map(mapActivity);
  }
}

function mapSharedItem(row: SharedItemRow): SharedItemDto {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    kind: row.kind,
    title: row.title,
    source: { agentId: row.agent_id, sessionRef: row.session_ref },
    publishedBy: row.published_by_user,
    publishedAt: row.published_at.toISOString(),
    sizeBytes: row.size_bytes,
    retractedAt: row.retracted_at === null ? null : row.retracted_at.toISOString(),
    retractedBy: row.retracted_by_user,
    readCount: Number(row.read_count),
  };
}

function mapVersion(row: RulesRow): ProjectAiRulesVersionDto {
  return { version: row.version, updatedBy: row.updated_by_user, updatedAt: row.created_at.toISOString(), sizeBytes: Number(row.size_bytes) };
}

function mapActivity(row: ActivityRow): AiActivityDto {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    member: row.member_user,
    agentId: row.agent_id,
    kind: row.kind,
    status: row.status,
    branch: row.branch,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
