import { randomUUID } from "node:crypto";
import type {
  AuditAction,
  AuditEntryDto,
  AuditResourceType,
  CommentDto,
  ProjectDto,
  RequirementActivityAction,
  RequirementActivityChangeDto,
  RequirementActivityEntryDto,
  RequirementDetailDto,
  RequirementDto,
  RequirementStatus,
  RequirementsCursorPage,
  ProjectStatsResponse,
  ProjectStatsWindow,
  StaleRequirementDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import {
  AUDIT_ACTIONS,
  REQUIREMENT_ACTIVITY_ACTIONS,
  REQUIREMENT_STATUSES,
  REQUIREMENT_UNREAD_BASELINE_DAYS,
  STALE_RHYTHM,
  parseRequirementNumberQuery,
  staleLevel,
} from "@suduo/cloud-contracts";
import { decodeCursor } from "../application/cursor.js";
import { ApplicationError, notFound } from "../application/errors.js";
import { insertAuditLog } from "./audit-log.js";
import { cursorPage, cursorTimestampColumn, type CursorRow } from "./cursor-page.js";
import type { Database, QueryExecutor } from "./database.js";

interface ProjectRow {
  id: string;
  name: string;
  is_archived: boolean;
  created_by_user: UserSummaryDto;
  updated_by_user: UserSummaryDto;
  created_at: Date;
  updated_at: Date;
  version: number;
}

interface RequirementRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  summary: string;
  status: RequirementStatus;
  assignee_user: UserSummaryDto | null;
  comment_count: number;
  unread_comment_count?: number;
  attachment_count: number;
  created_by_user: UserSummaryDto;
  updated_by_user: UserSummaryDto;
  created_at: Date;
  updated_at: Date;
  version: number;
  project_name?: string;
  project_is_archived?: boolean;
  project_version?: number;
}

/** 负责人筛选：`"me"` 已在服务层换成当前用户 id。 */
export type RequirementAssigneeCondition =
  | { kind: "none" }
  | { kind: "user"; userId: string };

interface ActivityRow {
  id: string;
  requirement_id: string;
  actor_user: UserSummaryDto;
  resource_type: AuditResourceType;
  resource_id: string;
  action: RequirementActivityAction;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  created_at: Date;
  comment_body: string | null;
  attachment_file_name: string | null;
  artifact_version_number: number | null;
  artifact_file_count: number | null;
  artifact_note: string | null;
  artifact_note_system_kind: string | null;
}

interface CommentRow {
  id: string;
  requirement_id: string;
  artifact_version_id: string | null;
  body: string;
  system_kind: string | null;
  system_params: unknown;
  author_user: UserSummaryDto;
  created_at: Date;
}

interface AuditRow {
  id: string;
  actor_user: UserSummaryDto;
  resource_type: AuditResourceType;
  resource_id: string;
  action: AuditAction;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  created_at: Date;
}

interface StatusCountRow {
  status: RequirementStatus;
  count: number;
}

interface StaleRequirementRow {
  id: string;
  number: number;
  title: string;
  status: RequirementStatus;
  stale_days: number;
  updated_by_user: UserSummaryDto;
  updated_at: Date;
  total: number;
}

interface DailyTransitionRow {
  date: string;
  count: number;
  by_status: Record<string, number> | null;
}

/** 只保留已知状态（审计后值缺失或不认识时记为 unknown，不进图表）。 */
function knownStatusCounts(value: Record<string, number> | null): Partial<Record<RequirementStatus, number>> {
  const result: Partial<Record<RequirementStatus, number>> = {};
  for (const status of REQUIREMENT_STATUSES) {
    const count = value?.[status];
    if (typeof count === "number" && count > 0) result[status] = count;
  }
  return result;
}

const PROJECT_COLUMNS = `
    p.id,
    p.name,
    p.is_archived,
    json_build_object('id', creator.id, 'displayName', creator.display_name) AS created_by_user,
    json_build_object('id', updater.id, 'displayName', updater.display_name) AS updated_by_user,
    p.created_at,
    p.updated_at,
    p.version
`;

const PROJECT_FROM = `
  FROM projects p
  JOIN users creator ON creator.id = p.created_by
  JOIN users updater ON updater.id = p.updated_by
`;

const PROJECT_SELECT = `
  SELECT ${PROJECT_COLUMNS}
  ${PROJECT_FROM}
`;

const REQUIREMENT_COLUMNS = `
    r.id,
    r.project_id,
    r.number,
    r.title,
    r.summary,
    r.status,
    CASE
      WHEN assignee.id IS NULL THEN NULL
      ELSE json_build_object('id', assignee.id, 'displayName', assignee.display_name)
    END AS assignee_user,
    (
      SELECT count(*)::integer
      FROM requirement_comments requirement_comment
      WHERE requirement_comment.requirement_id = r.id
    ) AS comment_count,
    (
      SELECT count(*)::integer
      FROM attachments requirement_attachment
      WHERE requirement_attachment.requirement_id = r.id
        AND requirement_attachment.deleted_at IS NULL
    ) AS attachment_count,
    json_build_object('id', creator.id, 'displayName', creator.display_name) AS created_by_user,
    json_build_object('id', updater.id, 'displayName', updater.display_name) AS updated_by_user,
    r.created_at,
    r.updated_at,
    r.version
`;

const REQUIREMENT_JOINS = `
  JOIN users creator ON creator.id = r.created_by
  JOIN users updater ON updater.id = r.updated_by
  LEFT JOIN users assignee ON assignee.id = r.assignee_id
`;

const REQUIREMENT_SELECT = `
  SELECT ${REQUIREMENT_COLUMNS}
  FROM requirements r
  ${REQUIREMENT_JOINS}
`;

const REQUIREMENT_DETAIL_SELECT = `
  SELECT
    ${REQUIREMENT_COLUMNS},
    p.name AS project_name,
    p.is_archived AS project_is_archived,
    p.version AS project_version
  FROM requirements r
  JOIN projects p ON p.id = r.project_id
  ${REQUIREMENT_JOINS}
`;

export class CollaborationRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createProject(actorId: string, name: string): Promise<ProjectDto> {
    return this.database.transaction(async (client) => {
      const id = randomUUID();
      await client.query(
        `
          INSERT INTO projects (id, name, created_by, updated_by)
          VALUES ($1, $2, $3, $3)
        `,
        [id, name, actorId],
      );
      const project = await this.getProject(id, client);
      await insertAuditLog(client, {
        actorId,
        projectId: id,
        requirementId: null,
        resourceType: "project",
        resourceId: id,
        action: "project.created",
        before: null,
        after: projectAudit(project),
      });
      return project;
    });
  }

  async listProjects(input: {
    includeArchived: boolean;
    cursor?: string;
    limit: number;
  }): Promise<RequirementsCursorPage<ProjectDto>> {
    const cursor = decodeCursor(input.cursor);
    const values: unknown[] = [input.includeArchived, input.limit + 1];
    const cursorClause = cursor === null
      ? ""
      : "AND (p.updated_at, p.id) < ($3::timestamptz, $4::uuid)";
    if (cursor !== null) values.push(cursor.timestamp, cursor.id);
    const result = await this.database.query<ProjectRow & CursorRow>(
      `
        SELECT ${PROJECT_COLUMNS}, ${cursorTimestampColumn("p.updated_at")}
        ${PROJECT_FROM}
        WHERE ($1::boolean OR p.is_archived = false)
        ${cursorClause}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT $2
      `,
      values,
    );
    return cursorPage(result.rows, input.limit, mapProject);
  }

  async getProject(id: string, executor: QueryExecutor = this.database): Promise<ProjectDto> {
    const result = await executor.query<ProjectRow>(
      `${PROJECT_SELECT} WHERE p.id = $1`,
      [id],
    );
    if (result.rows[0] === undefined) throw notFound("项目");
    return mapProject(result.rows[0]);
  }

  /**
   * 改名 / 归档：并发时后写生效，不按版本拒绝（ADR-0004，人可自行改回）。
   * 名称与归档状态都没有实际变化时不写入、不自增版本、不写审计。
   */
  async updateProject(input: {
    actorId: string;
    projectId: string;
    name?: string;
    isArchived?: boolean;
  }): Promise<{ project: ProjectDto; changed: boolean }> {
    return this.database.transaction(async (client) => {
      const before = await this.getProject(input.projectId, client);
      const result = await client.query(
        `
          UPDATE projects
          SET name = COALESCE($1, name),
              is_archived = COALESCE($2, is_archived),
              updated_by = $3,
              updated_at = now(),
              version = version + 1
          WHERE id = $4
            AND (name, is_archived) IS DISTINCT FROM (
              COALESCE($1, name),
              COALESCE($2, is_archived)
            )
        `,
        [
          input.name ?? null,
          input.isArchived ?? null,
          input.actorId,
          input.projectId,
        ],
      );
      if ((result.rowCount ?? 0) === 0) return { project: before, changed: false };
      const after = await this.getProject(input.projectId, client);
      const action: AuditAction =
        before.isArchived !== after.isArchived
          ? after.isArchived
            ? "project.archived"
            : "project.restored"
          : "project.updated";
      await insertAuditLog(client, {
        actorId: input.actorId,
        projectId: input.projectId,
        requirementId: null,
        resourceType: "project",
        resourceId: input.projectId,
        action,
        before: projectAudit(before),
        after: projectAudit(after),
      });
      return { project: after, changed: true };
    });
  }

  async createRequirement(input: {
    actorId: string;
    projectId: string;
    title: string;
    summary: string;
    status: RequirementStatus;
    assigneeId: string | null;
  }): Promise<RequirementDto> {
    return this.database.transaction(async (client) => {
      // 取号即自增：UPDATE 持有项目行锁直到提交，同项目并发创建依次拿到连续编号；
      // 事务回滚（如项目已归档、负责人不存在）时计数一并回滚，不留空号。
      const allocation = await client.query<{ number: number; is_archived: boolean }>(
        `
          UPDATE projects
          SET next_requirement_number = next_requirement_number + 1
          WHERE id = $1
          RETURNING next_requirement_number - 1 AS number, is_archived
        `,
        [input.projectId],
      );
      const project = allocation.rows[0];
      if (project === undefined) throw notFound("项目");
      if (project.is_archived) {
        throw new ApplicationError(409, "PROJECT_ARCHIVED", "归档项目不能创建需求");
      }
      if (input.assigneeId !== null) await requireUser(client, input.assigneeId);
      const id = randomUUID();
      await client.query(
        `
          INSERT INTO requirements (
            id, project_id, number, title, summary, status, assignee_id, created_by, updated_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
        `,
        [
          id,
          input.projectId,
          project.number,
          input.title,
          input.summary,
          input.status,
          input.assigneeId,
          input.actorId,
        ],
      );
      const requirement = await this.getRequirement(id, client);
      await insertAuditLog(client, {
        actorId: input.actorId,
        projectId: requirement.projectId,
        requirementId: id,
        resourceType: "requirement",
        resourceId: id,
        action: "requirement.created",
        before: null,
        after: { ...requirementAudit(requirement), assignee: requirement.assignee },
      });
      return requirement;
    });
  }

  async listRequirements(input: {
    projectId: string;
    status?: RequirementStatus;
    search?: string;
    assignee?: RequirementAssigneeCondition;
    creatorId?: string;
    /** 谁在看：按他的已读位置算 unreadCommentCount。 */
    readerId: string;
    cursor?: string;
    limit: number;
  }): Promise<RequirementsCursorPage<RequirementDto>> {
    await this.getProject(input.projectId);
    const cursor = decodeCursor(input.cursor);
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };
    const conditions = [`r.project_id = ${parameter(input.projectId)}`];
    if (input.status !== undefined) {
      conditions.push(`r.status = ${parameter(input.status)}`);
    }
    if (input.search !== undefined) {
      const pattern = parameter(`%${escapeLike(input.search)}%`);
      const number = parseRequirementNumberQuery(input.search);
      conditions.push(
        `(r.title ILIKE ${pattern} ESCAPE '\\' OR r.summary ILIKE ${pattern} ESCAPE '\\'` +
          (number === null ? "" : ` OR r.number = ${parameter(number)}::integer`) +
          ")",
      );
    }
    if (input.assignee?.kind === "none") {
      conditions.push("r.assignee_id IS NULL");
    } else if (input.assignee?.kind === "user") {
      conditions.push(`r.assignee_id = ${parameter(input.assignee.userId)}::uuid`);
    }
    if (input.creatorId !== undefined) {
      conditions.push(`r.created_by = ${parameter(input.creatorId)}::uuid`);
    }
    // 新评论数只在「指派给我」的列表里算（我的工作用它）；看板各列、其他筛选不算，省两次子查询。
    const withUnread = input.assignee?.kind === "user" && input.assignee.userId === input.readerId;
    const reader = withUnread ? parameter(input.readerId) : "";
    const baselineDays = withUnread ? parameter(REQUIREMENT_UNREAD_BASELINE_DAYS) : "";
    const unreadColumn = withUnread
      ? `(
            SELECT count(*)::integer
            FROM requirement_comments unread
            WHERE unread.requirement_id = r.id
              AND unread.author_id <> ${reader}::uuid
              -- 确认版的发布说明在时间线里并进「确认版」条目、不在评论里，不算新评论（数字与「评论」筛选看到的一致）。
              AND unread.artifact_version_id IS NULL
              -- 按毫秒比：接口给出的评论时间与已读水位都是毫秒精度，数据库里是微秒。
              AND date_trunc('milliseconds', unread.created_at) > coalesce(
                (SELECT reads.last_read_at FROM requirement_reads reads
                  WHERE reads.user_id = ${reader}::uuid AND reads.requirement_id = r.id),
                now() - make_interval(days => ${baselineDays}::integer)
              )
          ) AS unread_comment_count,`
      : "";
    if (cursor !== null) {
      conditions.push(
        `(r.updated_at, r.id) < (${parameter(cursor.timestamp)}::timestamptz, ${parameter(cursor.id)}::uuid)`,
      );
    }
    const limit = parameter(input.limit + 1);
    const result = await this.database.query<RequirementRow & CursorRow>(
      `
        SELECT ${REQUIREMENT_COLUMNS},
          ${unreadColumn}
          ${cursorTimestampColumn("r.updated_at")}
        FROM requirements r
        ${REQUIREMENT_JOINS}
        WHERE ${conditions.join(" AND ")}
        ORDER BY r.updated_at DESC, r.id DESC
        LIMIT ${limit}
      `,
      values,
    );
    return cursorPage(result.rows, input.limit, mapRequirement);
  }

  /**
   * 记下「读到这儿了」：取 min(upTo, 数据库当前时间)，且只往后挪（两个标签页先后打开也不会把位置改早）。
   * 用数据库时钟而不是应用时钟：评论的 created_at 也是数据库时间，同源才不会漏算或多算。
   */
  async markRequirementRead(input: { userId: string; requirementId: string; upTo?: string }): Promise<void> {
    await this.getRequirement(input.requirementId);
    await this.database.query(
      `
        INSERT INTO requirement_reads (user_id, requirement_id, last_read_at)
        VALUES (
          $1,
          $2,
          -- 不晚于此刻；也不早于「从没看过」的基线，免得看到一条很早的评论后，基线内的评论反而变成未读。
          GREATEST(
            LEAST(coalesce($3::timestamptz, clock_timestamp()), clock_timestamp()),
            clock_timestamp() - make_interval(days => $4::integer)
          )
        )
        ON CONFLICT (user_id, requirement_id)
        DO UPDATE SET last_read_at = GREATEST(requirement_reads.last_read_at, EXCLUDED.last_read_at)
      `,
      [input.userId, input.requirementId, input.upTo ?? null, REQUIREMENT_UNREAD_BASELINE_DAYS],
    );
  }

  async listRequirementsByIds(ids: string[]): Promise<RequirementDto[]> {
    if (ids.length === 0) return [];
    const result = await this.database.query<RequirementRow>(
      `
        ${REQUIREMENT_SELECT}
        WHERE r.id = ANY($1::uuid[])
        ORDER BY array_position($1::uuid[], r.id)
      `,
      [ids],
    );
    return result.rows.map(mapRequirement);
  }

  async getProjectStats(input: {
    projectId: string;
    window: ProjectStatsWindow;
    timeZone: string;
  }): Promise<ProjectStatsResponse> {
    await this.getProject(input.projectId);
    const now = this.now();
    const windowDays = input.window === "7d" ? 7 : 30;
    const staleRhythmRows = REQUIREMENT_STATUSES.flatMap((status) => {
      const rhythm = STALE_RHYTHM[status];
      return rhythm === null ? [] : [{ status, notice: rhythm.notice, warning: rhythm.warning }];
    });
    const [statusCountsResult, staleRequirementsResult, transitionsResult] =
      await Promise.all([
        this.database.query<StatusCountRow>(
          `
            SELECT statuses.status, count(r.id)::integer AS count
            FROM unnest($2::varchar[]) AS statuses(status)
            LEFT JOIN requirements r
              ON r.project_id = $1 AND r.status = statuses.status
            GROUP BY statuses.status
            ORDER BY array_position($2::varchar[], statuses.status)
          `,
          [input.projectId, [...REQUIREMENT_STATUSES]],
        ),
        this.database.query<StaleRequirementRow>(
          `
            WITH rhythm AS (
              SELECT * FROM unnest($3::varchar[], $4::integer[], $5::integer[])
                AS rhythm(status, notice_days, warning_days)
            ),
            candidates AS (
              SELECT
                r.id,
                r.number,
                r.title,
                r.status,
                floor(extract(epoch FROM ($2::timestamptz - r.updated_at)) / 86400)::integer AS stale_days,
                rhythm.notice_days,
                rhythm.warning_days,
                r.updated_by,
                r.updated_at
              FROM requirements r
              JOIN rhythm ON rhythm.status = r.status
              WHERE r.project_id = $1
            )
            SELECT
              c.id,
              c.number,
              c.title,
              c.status,
              c.stale_days,
              json_build_object('id', updater.id, 'displayName', updater.display_name)
                AS updated_by_user,
              c.updated_at,
              count(*) OVER ()::integer AS total
            FROM candidates c
            JOIN users updater ON updater.id = c.updated_by
            WHERE c.stale_days >= c.notice_days
            ORDER BY (c.warning_days IS NOT NULL AND c.stale_days >= c.warning_days) DESC, c.updated_at ASC, c.id ASC
            LIMIT 10
          `,
          [
            input.projectId,
            now.toISOString(),
            staleRhythmRows.map((row) => row.status),
            staleRhythmRows.map((row) => row.notice),
            staleRhythmRows.map((row) => row.warning),
          ],
        ),
        this.database.query<DailyTransitionRow>(
          `
            WITH bounds AS (
              SELECT
                (($3::timestamptz AT TIME ZONE $4)::date - ($2::integer - 1)) AS first_day,
                ($3::timestamptz AT TIME ZONE $4)::date AS last_day
            ),
            days AS (
              SELECT generate_series(first_day, last_day, interval '1 day')::date AS day
              FROM bounds
            ),
            per_status AS (
              SELECT
                (audit.created_at AT TIME ZONE $4)::date AS day,
                coalesce(audit.after_json->>'status', 'unknown') AS status,
                count(*)::integer AS count
              FROM audit_logs audit
              CROSS JOIN bounds
              WHERE audit.project_id = $1
                -- 状态和标题一起改时审计记为 updated，前后状态不同的也算一次流转。
                AND (
                  audit.action = 'requirement.status_changed'
                  OR (
                    audit.action = 'requirement.updated'
                    AND audit.after_json->>'status' IS DISTINCT FROM audit.before_json->>'status'
                  )
                )
                AND audit.created_at >= (bounds.first_day::timestamp AT TIME ZONE $4)
                AND audit.created_at < ((bounds.last_day + 1)::timestamp AT TIME ZONE $4)
              GROUP BY 1, 2
            ),
            counts AS (
              SELECT day, sum(count)::integer AS count, json_object_agg(status, count) AS by_status
              FROM per_status
              GROUP BY day
            )
            SELECT
              to_char(days.day, 'YYYY-MM-DD') AS date,
              coalesce(counts.count, 0)::integer AS count,
              coalesce(counts.by_status, '{}'::json) AS by_status
            FROM days
            LEFT JOIN counts ON counts.day = days.day
            ORDER BY days.day ASC
          `,
          [input.projectId, windowDays, now.toISOString(), input.timeZone],
        ),
      ]);
    const statusCounts = Object.fromEntries(
      REQUIREMENT_STATUSES.map((status) => [status, 0]),
    ) as Record<RequirementStatus, number>;
    for (const row of statusCountsResult.rows) {
      statusCounts[row.status] = row.count;
    }
    return {
      statusCounts,
      staleRequirements: staleRequirementsResult.rows.map(mapStaleRequirement),
      staleTotal: staleRequirementsResult.rows[0]?.total ?? 0,
      transitions: transitionsResult.rows.map((row) => ({
        date: row.date,
        count: row.count,
        byStatus: knownStatusCounts(row.by_status),
      })),
    };
  }

  async getRequirement(
    id: string,
    executor: QueryExecutor = this.database,
  ): Promise<RequirementDto> {
    const result = await executor.query<RequirementRow>(
      `${REQUIREMENT_SELECT} WHERE r.id = $1`,
      [id],
    );
    if (result.rows[0] === undefined) throw notFound("需求");
    return mapRequirement(result.rows[0]);
  }

  async getRequirementDetail(id: string): Promise<RequirementDetailDto> {
    const result = await this.database.query<RequirementRow>(
      `${REQUIREMENT_DETAIL_SELECT} WHERE r.id = $1`,
      [id],
    );
    return mapRequirementDetail(result.rows[0]);
  }

  async getRequirementByNumber(
    projectId: string,
    number: number,
  ): Promise<RequirementDetailDto> {
    const result = await this.database.query<RequirementRow>(
      `${REQUIREMENT_DETAIL_SELECT} WHERE r.project_id = $1 AND r.number = $2`,
      [projectId, number],
    );
    return mapRequirementDetail(result.rows[0]);
  }

  async listUsers(): Promise<UserSummaryDto[]> {
    const result = await this.database.query<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users ORDER BY display_name ASC, id ASC",
    );
    return result.rows.map((row) => ({ id: row.id, displayName: row.display_name }));
  }

  async updateRequirement(input: {
    actorId: string;
    requirementId: string;
    title?: string;
    summary?: string;
    status?: RequirementStatus;
    /** undefined 表示不改负责人；null 表示清空。 */
    assigneeId?: string | null;
  }): Promise<{ requirement: RequirementDto; changed: boolean }> {
    return this.database.transaction(async (client) => {
      const before = await this.getRequirement(input.requirementId, client);
      let contentChanged = false;
      if (
        input.title !== undefined ||
        input.summary !== undefined ||
        input.status !== undefined
      ) {
        const result = await client.query<{ version: number }>(
          `
            UPDATE requirements
            SET title = COALESCE($1, title),
                summary = COALESCE($2, summary),
                status = COALESCE($3, status),
                updated_by = $4,
                updated_at = now(),
                version = version + 1
            WHERE id = $5
              AND (title, summary, status) IS DISTINCT FROM (
                COALESCE($1, title),
                COALESCE($2, summary),
                COALESCE($3, status)
              )
            RETURNING version
          `,
          [
            input.title ?? null,
            input.summary ?? null,
            input.status ?? null,
            input.actorId,
            input.requirementId,
          ],
        );
        contentChanged = (result.rowCount ?? 0) > 0;
      }
      const assigneeChange = input.assigneeId === undefined
        ? null
        : await this.changeAssignee(client, {
            actorId: input.actorId,
            requirementId: input.requirementId,
            assigneeId: input.assigneeId,
          });
      if (!contentChanged && assigneeChange === null) {
        return { requirement: before, changed: false };
      }
      const after = await this.getRequirement(input.requirementId, client);
      if (contentChanged) {
        const onlyStatusChanged =
          before.status !== after.status &&
          before.title === after.title &&
          before.summary === after.summary;
        await insertAuditLog(client, {
          actorId: input.actorId,
          projectId: after.projectId,
          requirementId: input.requirementId,
          resourceType: "requirement",
          resourceId: input.requirementId,
          action: onlyStatusChanged
            ? "requirement.status_changed"
            : "requirement.updated",
          before: requirementAudit(before),
          after: requirementAudit(after),
        });
      }
      if (assigneeChange !== null) {
        await insertAuditLog(client, {
          actorId: input.actorId,
          projectId: after.projectId,
          requirementId: input.requirementId,
          resourceType: "requirement",
          resourceId: input.requirementId,
          action: "requirement.assignee_changed",
          before: { assignee: assigneeChange.from },
          after: { assignee: assigneeChange.to },
        });
      }
      return { requirement: after, changed: true };
    });
  }

  /**
   * 负责人是元数据：刷新 updated_at / updated_by，但不递增正文版本，
   * 以免开工快照把"换了负责人"误报成需求内容变化。
   */
  private async changeAssignee(
    executor: QueryExecutor,
    input: { actorId: string; requirementId: string; assigneeId: string | null },
  ): Promise<{ from: UserSummaryDto | null; to: UserSummaryDto | null } | null> {
    const to = input.assigneeId === null
      ? null
      : await requireUser(executor, input.assigneeId);
    // 先锁行再读旧值，审计里的 from 与本次写入严格对应。
    // 用 FOR NO KEY UPDATE：与随后 UPDATE（不改键列）自动取得的行锁同级；FOR UPDATE 会
    // 挡住其他事务插入评论 / 附件等引用本需求的行时外键检查所需的 KEY SHARE。
    const current = await executor.query<{ assignee_id: string | null }>(
      "SELECT assignee_id FROM requirements WHERE id = $1 FOR NO KEY UPDATE",
      [input.requirementId],
    );
    const row = current.rows[0];
    if (row === undefined) throw notFound("需求");
    if (row.assignee_id === (to?.id ?? null)) return null;
    await executor.query(
      `
        UPDATE requirements
        SET assignee_id = $1,
            updated_by = $2,
            updated_at = now()
        WHERE id = $3
      `,
      [to?.id ?? null, input.actorId, input.requirementId],
    );
    const from = row.assignee_id === null
      ? null
      : await findUser(executor, row.assignee_id);
    return { from, to };
  }

  async createComment(input: {
    actorId: string;
    requirementId: string;
    body: string;
  }): Promise<CommentDto> {
    return this.database.transaction(async (client) => {
      const requirement = await client.query<{ id: string; project_id: string }>(
        "SELECT id, project_id FROM requirements WHERE id = $1",
        [input.requirementId],
      );
      if (requirement.rows[0] === undefined) throw notFound("需求");
      const id = randomUUID();
      await client.query(
        `
          INSERT INTO requirement_comments (id, requirement_id, body, author_id)
          VALUES ($1, $2, $3, $4)
        `,
        [id, input.requirementId, input.body, input.actorId],
      );
      const comment = await this.getComment(id, client);
      await insertAuditLog(client, {
        actorId: input.actorId,
        projectId: requirement.rows[0].project_id,
        requirementId: input.requirementId,
        resourceType: "comment",
        resourceId: id,
        action: "comment.created",
        before: null,
        after: {
          requirementId: comment.requirementId,
          body: comment.body,
        },
      });
      return comment;
    });
  }

  async listComments(input: {
    requirementId: string;
    cursor?: string;
    limit: number;
  }): Promise<RequirementsCursorPage<CommentDto>> {
    await this.getRequirement(input.requirementId);
    const cursor = decodeCursor(input.cursor);
    const values: unknown[] = [input.requirementId, input.limit + 1];
    const cursorClause = cursor === null
      ? ""
      : "AND (c.created_at, c.id) < ($3::timestamptz, $4::uuid)";
    if (cursor !== null) values.push(cursor.timestamp, cursor.id);
    const result = await this.database.query<CommentRow & CursorRow>(
      `
        SELECT
          c.id,
          c.requirement_id,
          c.artifact_version_id,
          c.body,
          c.system_kind,
          c.system_params,
          json_build_object('id', author.id, 'displayName', author.display_name) AS author_user,
          c.created_at,
          ${cursorTimestampColumn("c.created_at")}
        FROM requirement_comments c
        JOIN users author ON author.id = c.author_id
        WHERE c.requirement_id = $1
          ${cursorClause}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $2
      `,
      values,
    );
    return cursorPage(result.rows, input.limit, mapComment);
  }

  async listAudit(input: {
    resourceType?: AuditResourceType;
    resourceId?: string;
    projectId?: string;
    cursor?: string;
    limit: number;
  }): Promise<RequirementsCursorPage<AuditEntryDto>> {
    const cursor = decodeCursor(input.cursor);
    const values: unknown[] = [
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.projectId ?? null,
      input.limit + 1,
      // 过渡期：只返回契约 AUDIT_ACTIONS 内的动作，见 REQUIREMENT_ASSIGNEE_CHANGED_ACTION。
      [...AUDIT_ACTIONS],
    ];
    const cursorClause = cursor === null
      ? ""
      : "AND (a.created_at, a.id) < ($6::timestamptz, $7::uuid)";
    if (cursor !== null) values.push(cursor.timestamp, cursor.id);
    const result = await this.database.query<AuditRow & CursorRow>(
      `
        SELECT
          a.id,
          json_build_object('id', actor.id, 'displayName', actor.display_name) AS actor_user,
          a.resource_type,
          a.resource_id,
          a.action,
          a.before_json,
          a.after_json,
          a.created_at,
          ${cursorTimestampColumn("a.created_at")}
        FROM audit_logs a
        JOIN users actor ON actor.id = a.actor_id
        WHERE ($1::varchar IS NULL OR a.resource_type = $1)
          AND (
            $2::uuid IS NULL
            OR a.resource_id = $2
            OR a.before_json ->> 'requirementId' = $2::text
            OR a.after_json ->> 'requirementId' = $2::text
          )
          AND ($3::uuid IS NULL OR a.project_id = $3)
          AND a.action = ANY($5::varchar[])
          ${cursorClause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $4
      `,
      values,
    );
    return cursorPage(result.rows, input.limit, mapAudit);
  }

  /**
   * 需求活动时间线：按 audit_logs.requirement_id 走索引，合并需求本身、评论、附件、
   * 产物发布的审计，并关联出展示所需的评论正文、文件名与发布说明。
   */
  async listRequirementActivity(input: {
    requirementId: string;
    cursor?: string;
    limit: number;
  }): Promise<RequirementsCursorPage<RequirementActivityEntryDto>> {
    await this.getRequirement(input.requirementId);
    const cursor = decodeCursor(input.cursor);
    const values: unknown[] = [
      input.requirementId,
      [...REQUIREMENT_ACTIVITY_ACTIONS],
      input.limit + 1,
    ];
    const cursorClause = cursor === null
      ? ""
      : "AND (a.created_at, a.id) < ($4::timestamptz, $5::uuid)";
    if (cursor !== null) values.push(cursor.timestamp, cursor.id);
    const result = await this.database.query<ActivityRow & CursorRow>(
      `
        SELECT
          a.id,
          a.requirement_id,
          json_build_object('id', actor.id, 'displayName', actor.display_name) AS actor_user,
          a.resource_type,
          a.resource_id,
          a.action,
          a.before_json,
          a.after_json,
          a.created_at,
          ${cursorTimestampColumn("a.created_at")},
          activity_comment.body AS comment_body,
          activity_attachment.file_name AS attachment_file_name,
          artifact_version.version_number AS artifact_version_number,
          (
            SELECT count(*)::integer
            FROM requirement_artifact_version_files artifact_file
            WHERE artifact_file.version_id = artifact_version.id
          ) AS artifact_file_count,
          publish_comment.body AS artifact_note,
          publish_comment.system_kind AS artifact_note_system_kind
        FROM audit_logs a
        JOIN users actor ON actor.id = a.actor_id
        LEFT JOIN requirement_comments activity_comment
          ON a.resource_type = 'comment' AND activity_comment.id = a.resource_id
        LEFT JOIN attachments activity_attachment
          ON a.resource_type = 'attachment' AND activity_attachment.id = a.resource_id
        LEFT JOIN requirement_artifact_versions artifact_version
          ON a.resource_type = 'artifact_version' AND artifact_version.id = a.resource_id
        LEFT JOIN requirement_comments publish_comment
          ON publish_comment.artifact_version_id = artifact_version.id
        WHERE a.requirement_id = $1
          AND a.action = ANY($2::varchar[])
          -- 产物发布的自动评论并入 artifact_version.published，不单独成条。
          AND activity_comment.artifact_version_id IS NULL
          ${cursorClause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $3
      `,
      values,
    );
    return cursorPage(result.rows, input.limit, mapActivity);
  }

  private async getComment(id: string, executor: QueryExecutor): Promise<CommentDto> {
    const result = await executor.query<CommentRow>(
      `
        SELECT
          c.id,
          c.requirement_id,
          c.artifact_version_id,
          c.body,
          c.system_kind,
          c.system_params,
          json_build_object('id', author.id, 'displayName', author.display_name) AS author_user,
          c.created_at
        FROM requirement_comments c
        JOIN users author ON author.id = c.author_id
        WHERE c.id = $1
      `,
      [id],
    );
    if (result.rows[0] === undefined) throw notFound("评论");
    return mapComment(result.rows[0]);
  }

}

function mapProject(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    isArchived: row.is_archived,
    createdBy: row.created_by_user,
    updatedBy: row.updated_by_user,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

function mapRequirement(row: RequirementRow): RequirementDto {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    title: row.title,
    summary: row.summary,
    status: row.status,
    assignee: row.assignee_user,
    commentCount: row.comment_count,
    attachmentCount: row.attachment_count,
    createdBy: row.created_by_user,
    updatedBy: row.updated_by_user,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
    ...(row.unread_comment_count === undefined ? {} : { unreadCommentCount: row.unread_comment_count }),
  };
}

function mapRequirementDetail(row: RequirementRow | undefined): RequirementDetailDto {
  if (
    row === undefined ||
    row.project_name === undefined ||
    row.project_is_archived === undefined ||
    row.project_version === undefined
  ) {
    throw notFound("需求");
  }
  return {
    ...mapRequirement(row),
    project: {
      id: row.project_id,
      name: row.project_name,
      isArchived: row.project_is_archived,
      version: row.project_version,
    },
  };
}

function mapActivity(row: ActivityRow): RequirementActivityEntryDto {
  const before = row.before_json;
  const after = row.after_json;
  return {
    id: row.id,
    requirementId: row.requirement_id,
    actor: row.actor_user,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    createdAt: row.created_at.toISOString(),
    changes: activityChanges(row.action, before, after),
    comment: row.action === "comment.created"
      ? {
          id: row.resource_id,
          body: row.comment_body ?? stringField(after, "body") ?? "",
        }
      : null,
    attachment: row.resource_type === "attachment"
      ? {
          id: row.resource_id,
          fileName:
            row.attachment_file_name ??
            stringField(after, "fileName") ??
            stringField(before, "fileName") ??
            "",
        }
      : null,
    artifactVersion: row.action === "artifact_version.published"
      ? artifactVersionActivity(row, after)
      : null,
  };
}

function artifactVersionActivity(
  row: ActivityRow,
  after: Record<string, unknown> | null,
): NonNullable<RequirementActivityEntryDto["artifactVersion"]> {
  const versionNumber = row.artifact_version_number ?? numberField(after, "versionNumber") ?? 0;
  const fileCount = row.artifact_file_count ?? numberField(after, "fileCount") ?? 0;
  // 系统代写的评论（没写发布说明）按类型判断，不比较正文：正文会随语言变化（中英双语技术设计 §4.3）。
  const note = row.artifact_note_system_kind === null ? row.artifact_note : null;
  return {
    id: row.resource_id,
    versionNumber,
    fileCount,
    note,
  };
}

function activityChanges(
  action: RequirementActivityAction,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): RequirementActivityChangeDto[] {
  if (action === "requirement.assignee_changed") {
    return [{
      field: "assignee",
      from: userField(before, "assignee"),
      to: userField(after, "assignee"),
    }];
  }
  if (action !== "requirement.updated" && action !== "requirement.status_changed") {
    return [];
  }
  const changes: RequirementActivityChangeDto[] = [];
  for (const field of ["title", "summary"] as const) {
    const from = stringField(before, field);
    const to = stringField(after, field);
    if (from !== null && to !== null && from !== to) changes.push({ field, from, to });
  }
  const fromStatus = statusField(before);
  const toStatus = statusField(after);
  if (fromStatus !== null && toStatus !== null && fromStatus !== toStatus) {
    changes.push({ field: "status", from: fromStatus, to: toStatus });
  }
  return changes;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function statusField(value: Record<string, unknown> | null): RequirementStatus | null {
  const field = stringField(value, "status");
  return field !== null && (REQUIREMENT_STATUSES as readonly string[]).includes(field)
    ? field as RequirementStatus
    : null;
}

function userField(value: Record<string, unknown> | null, key: string): UserSummaryDto | null {
  const field = value?.[key];
  if (field === null || typeof field !== "object" || Array.isArray(field)) return null;
  const candidate = field as Record<string, unknown>;
  const id = candidate["id"];
  const displayName = candidate["displayName"];
  return typeof id === "string" && typeof displayName === "string"
    ? { id, displayName }
    : null;
}

async function findUser(
  executor: QueryExecutor,
  userId: string,
): Promise<UserSummaryDto | null> {
  const result = await executor.query<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM users WHERE id = $1",
    [userId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, displayName: row.display_name };
}

/** 负责人必须是已存在的用户；这是输入校验（400），不是并发守卫。 */
async function requireUser(
  executor: QueryExecutor,
  userId: string,
): Promise<UserSummaryDto> {
  const user = await findUser(executor, userId);
  if (user === null) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "负责人不存在", {
      field: "assigneeId",
    });
  }
  return user;
}

function mapStaleRequirement(row: StaleRequirementRow): StaleRequirementDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    staleDays: Math.max(0, row.stale_days),
    level: staleLevel(row.status, row.stale_days),
    lastUpdatedBy: row.updated_by_user,
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapComment(row: CommentRow): CommentDto {
  return {
    id: row.id,
    requirementId: row.requirement_id,
    artifactVersionId: row.artifact_version_id,
    body: row.body,
    author: row.author_user,
    createdAt: row.created_at.toISOString(),
    ...commentSystemFields(row),
  };
}

/** 认识的系统类型才带出类型 + 参数；不认识的（更新的云端写入的）只给正文，前端照常显示兜底文字。 */
function commentSystemFields(row: CommentRow): Pick<CommentDto, "systemKind" | "systemParams"> {
  if (row.system_kind !== "artifact_published") return {};
  const params = row.system_params as Record<string, unknown> | null;
  const versionNumber = params?.["versionNumber"];
  const fileCount = params?.["fileCount"];
  if (typeof versionNumber !== "number" || typeof fileCount !== "number") return {};
  return { systemKind: "artifact_published", systemParams: { versionNumber, fileCount } };
}

function mapAudit(row: AuditRow): AuditEntryDto {
  return {
    id: row.id,
    actor: row.actor_user,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    action: row.action,
    before: row.before_json,
    after: row.after_json,
    createdAt: row.created_at.toISOString(),
  };
}

function projectAudit(project: ProjectDto): Record<string, unknown> {
  return {
    name: project.name,
    isArchived: project.isArchived,
    version: project.version,
  };
}

function requirementAudit(requirement: RequirementDto): Record<string, unknown> {
  return {
    projectId: requirement.projectId,
    title: requirement.title,
    summary: requirement.summary,
    status: requirement.status,
    version: requirement.version,
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
