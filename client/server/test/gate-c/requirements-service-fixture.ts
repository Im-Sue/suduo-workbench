import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  REQUIREMENT_ASSIGNEE_FILTER_ME,
  REQUIREMENT_ASSIGNEE_FILTER_NONE,
  REQUIREMENT_STATUSES,
  parseRequirementNumberQuery,
  type ArtifactVersionDetailDto,
  type ArtifactVersionDto,
  type AttachmentDto,
  type AttachmentMutationResponse,
  type AuditEntryDto,
  type AuthSessionDto,
  type CommentDto,
  type CurrentUserDto,
  type ListArtifactVersionsResponse,
  type ListAttachmentsResponse,
  type ListAuditResponse,
  type ListCommentsResponse,
  type ListProjectsResponse,
  type ListRequirementActivityResponse,
  type ListRequirementsByIdsResponse,
  type ListRequirementsResponse,
  type ListUsersResponse,
  type ProjectDto,
  type ProjectStatsResponse,
  type RequirementActivityChangeDto,
  type RequirementActivityEntryDto,
  type RequirementDetailDto,
  type RequirementDto,
  type RequirementStatus,
  type RequirementsEventDto,
  type RequirementsEventType,
  type UserSummaryDto,
} from "@suduo/cloud-contracts";

/**
 * 远程 requirements-v2 契约要求资源 id 为 UUID。可读含义留在键名和标题中，
 * 不能用测试专用短字符串绕过真实 BFF 的 safeSegment / schema 校验。
 */
export const GATE_C_FIXTURE_IDS = {
  project: "10000000-0000-4000-8000-000000000001",
  reqDraft1: "10000000-0000-4000-8000-000000000002",
  reqDraft2: "10000000-0000-4000-8000-000000000003",
  reqRefinement1: "10000000-0000-4000-8000-000000000004",
  reqPatchFailure: "10000000-0000-4000-8000-000000000005",
  reqHold1: "10000000-0000-4000-8000-000000000006",
  attachment1: "10000000-0000-4000-8000-000000000007",
  attachment2: "10000000-0000-4000-8000-000000000008",
  commentOrdinary: "10000000-0000-4000-8000-000000000009",
  artifactVersion1: "10000000-0000-4000-8000-000000000010",
  artifactFile1: "10000000-0000-4000-8000-000000000011",
  commentArtifact1: "10000000-0000-4000-8000-000000000012",
  auditStatusChange: "10000000-0000-4000-8000-000000000013",
  /** 登录用户（负责人筛选「我负责的」）。 */
  userMe: "10000000-0000-4000-8000-000000000014",
  /** 另一位成员：负责人筛选与「别人刚改了它」的主语。 */
  userTeammate: "10000000-0000-4000-8000-000000000015",
} as const;

/** 需求编号：与远程服务一致，项目内按创建顺序从 1 编号。 */
export const GATE_C_FIXTURE_NUMBERS = {
  reqDraft1: 1,
  reqDraft2: 2,
  reqRefinement1: 3,
  reqPatchFailure: 4,
  reqHold1: 5,
} as const;

/** 为重复事件或未来多版本保留有效 UUID 形状。 */
function fixtureUuid(sequence: number): string {
  return `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

const me: UserSummaryDto = { id: GATE_C_FIXTURE_IDS.userMe, displayName: "Gate C 用户" };
const teammate: UserSummaryDto = { id: GATE_C_FIXTURE_IDS.userTeammate, displayName: "Gate C 同事" };
const users: readonly UserSummaryDto[] = [me, teammate];

const currentUser: CurrentUserDto = {
  ...me,
  loginName: "gate-c-user",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const project: ProjectDto = {
  id: GATE_C_FIXTURE_IDS.project,
  name: "Gate C 远程项目",
  isArchived: false,
  createdBy: me,
  updatedBy: me,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

const CREATED_AT = "2026-08-17T00:00:00.000Z";
const MATERIALS_AT = "2026-08-23T00:00:00.000Z";
/** 夹具里唯一一条评论（普通评论）的时间：详情页显示出它后，已读位置应记到这里。 */
export const GATE_C_FIXTURE_COMMENT_AT = MATERIALS_AT;

export interface RequirementsServiceFixture {
  origin: string;
  projectId: string;
  /** 仅让工作台/概览依赖的远程读模型返回 503，验证 BFF 分块降级。 */
  setRemoteFailure(enabled: boolean): void;
  /** 模拟会话创建后的远程内容变更，用于端到端验证材料漂移。 */
  changeRequirement(id: string, patch: Partial<Pick<FixtureRequirement, "title" | "status">>): void;
  /** 恢复为夹具启动时记录，避免一个步骤污染后续步骤的版本基线。 */
  restoreRequirement(id: string): void;
  /** 当前账号在这条需求上记下的已读位置（详情页显示出评论后经 BFF 写入）；没记过为 undefined。 */
  readMarkOf(requirementId: string): string | undefined;
  close(): Promise<void>;
}

/**
 * 看板夹具数据。
 *
 * 刻意把三条需求放在 draft、其余状态各一条：旧实现「单游标拉一页再前端
 * filter」在这种分布下会让部分列**假空**，看板改为七列各自请求后才不会。
 * `reqPatchFailure` 专用于失败分支——PATCH 一律 503，且同一时刻同事已把它
 * 移到第三列 in_testing（见 PATCH 分支）。
 */
interface FixtureRequirement {
  id: string;
  number: number;
  title: string;
  summary: string;
  status: RequirementStatus;
  assignee: UserSummaryDto | null;
  version: number;
  updatedBy: UserSummaryDto;
  updatedAt: string;
}

interface FixtureArtifactVersion extends ArtifactVersionDetailDto {
  note: string | null;
}

/** PATCH 失败需求的真实状态在「第三列」——既不是原列也不是拖拽目标列。 */
const PATCH_FAILURE_ACTUAL_STATUS: RequirementStatus = "in_testing";

function initialRequirements(): Map<string, FixtureRequirement> {
  const seed = (
    id: string,
    number: number,
    title: string,
    status: RequirementStatus,
    assignee: UserSummaryDto | null,
  ): [string, FixtureRequirement] => [
    id,
    {
      id,
      number,
      title,
      summary: "",
      status,
      assignee,
      version: 1,
      updatedBy: me,
      updatedAt: CREATED_AT,
    },
  ];
  return new Map([
    seed(GATE_C_FIXTURE_IDS.reqDraft1, GATE_C_FIXTURE_NUMBERS.reqDraft1, "看板草稿一", "draft", me),
    seed(GATE_C_FIXTURE_IDS.reqDraft2, GATE_C_FIXTURE_NUMBERS.reqDraft2, "看板草稿二", "draft", null),
    seed(
      GATE_C_FIXTURE_IDS.reqRefinement1,
      GATE_C_FIXTURE_NUMBERS.reqRefinement1,
      "正在梳理的需求",
      "in_refinement",
      teammate,
    ),
    seed(
      GATE_C_FIXTURE_IDS.reqPatchFailure,
      GATE_C_FIXTURE_NUMBERS.reqPatchFailure,
      "PATCH 真实失败需求",
      "draft",
      null,
    ),
    seed(GATE_C_FIXTURE_IDS.reqHold1, GATE_C_FIXTURE_NUMBERS.reqHold1, "暂缓中的需求", "on_hold", null),
  ]);
}

export async function startRequirementsServiceFixture(): Promise<RequirementsServiceFixture> {
  const eventClients = new Set<ServerResponse>();
  const requirements = initialRequirements();
  const initial = new Map([...requirements.entries()].map(([id, item]) => [id, { ...item }]));
  const targetRequirementId = GATE_C_FIXTURE_IDS.reqDraft1;
  const attachments = new Map<string, AttachmentDto>([
    [
      GATE_C_FIXTURE_IDS.attachment1,
      {
        id: GATE_C_FIXTURE_IDS.attachment1,
        requirementId: targetRequirementId,
        fileName: "发布材料.txt",
        contentType: "text/plain",
        sizeBytes: 18,
        sha256: "a".repeat(64),
        uploadedBy: me,
        createdAt: MATERIALS_AT,
      },
    ],
    [
      GATE_C_FIXTURE_IDS.attachment2,
      {
        id: GATE_C_FIXTURE_IDS.attachment2,
        requirementId: targetRequirementId,
        fileName: "待删除材料.txt",
        contentType: "text/plain",
        sizeBytes: 16,
        sha256: "b".repeat(64),
        uploadedBy: me,
        createdAt: MATERIALS_AT,
      },
    ],
  ]);
  const artifactVersions: FixtureArtifactVersion[] = [];
  const comments: CommentDto[] = [
    {
      id: GATE_C_FIXTURE_IDS.commentOrdinary,
      requirementId: targetRequirementId,
      artifactVersionId: null,
      body: "这是一条普通评论，应继续按普通评论显示。",
      author: me,
      createdAt: MATERIALS_AT,
    },
  ];

  // ---------- 活动时间线（与远程服务一致：只收录 REQUIREMENT_ACTIVITY_ACTIONS） ----------
  const activity: RequirementActivityEntryDto[] = [];
  let activitySequence = 0;
  const record = (
    entry: Omit<
      RequirementActivityEntryDto,
      "id" | "changes" | "comment" | "attachment" | "artifactVersion"
    > &
      Partial<
        Pick<
          RequirementActivityEntryDto,
          "changes" | "comment" | "attachment" | "artifactVersion"
        >
      >,
  ): void => {
    activity.push({
      id: fixtureUuid(500 + ++activitySequence),
      changes: [],
      comment: null,
      attachment: null,
      artifactVersion: null,
      ...entry,
    });
  };
  for (const requirement of requirements.values()) {
    record({
      requirementId: requirement.id,
      actor: me,
      action: "requirement.created",
      resourceType: "requirement",
      resourceId: requirement.id,
      createdAt: CREATED_AT,
    });
  }
  for (const attachment of attachments.values()) {
    record({
      requirementId: attachment.requirementId,
      actor: attachment.uploadedBy,
      action: "attachment.created",
      resourceType: "attachment",
      resourceId: attachment.id,
      attachment: { id: attachment.id, fileName: attachment.fileName },
      createdAt: attachment.createdAt,
    });
  }
  for (const comment of comments) {
    record({
      requirementId: comment.requirementId,
      actor: comment.author,
      action: "comment.created",
      resourceType: "comment",
      resourceId: comment.id,
      comment: { id: comment.id, body: comment.body },
      createdAt: comment.createdAt,
    });
  }

  let eventSequence = 0;
  let remoteFailure = false;
  const readMarks = new Map<string, string>();

  const listAttachments = (requirementId: string): AttachmentDto[] =>
    [...attachments.values()].filter((attachment) => attachment.requirementId === requirementId);
  const toDto = (item: FixtureRequirement): RequirementDto => ({
    id: item.id,
    projectId: project.id,
    number: item.number,
    title: item.title,
    summary: item.summary,
    status: item.status,
    assignee: item.assignee,
    commentCount: comments.filter((comment) => comment.requirementId === item.id).length,
    attachmentCount: listAttachments(item.id).length,
    createdBy: me,
    updatedBy: item.updatedBy,
    createdAt: CREATED_AT,
    updatedAt: item.updatedAt,
    version: item.version,
  });
  const toDetail = (item: FixtureRequirement): RequirementDetailDto => ({
    ...toDto(item),
    project: {
      id: project.id,
      name: project.name,
      isArchived: project.isArchived,
      version: project.version,
    },
  });
  const artifactSummary = (version: FixtureArtifactVersion): ArtifactVersionDto => ({
    id: version.id,
    requirementId: version.requirementId,
    versionNumber: version.versionNumber,
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt,
    fileCount: version.fileCount,
  });
  const artifactDetail = (version: FixtureArtifactVersion): ArtifactVersionDetailDto => ({
    ...artifactSummary(version),
    files: version.files,
  });
  const emit = (type: RequirementsEventType, requirementId: string, requirementVersion: number) => {
    const event: RequirementsEventDto = {
      id: fixtureUuid(100 + ++eventSequence),
      type,
      projectId: project.id,
      requirementId,
      requirementVersion,
      occurredAt: new Date().toISOString(),
    };
    for (const client of eventClients) client.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // 与远程服务同形的健康检查：设置页「需求服务 · 测试连接」与诊断页用它判断连通。
    if (request.method === "GET" && url.pathname === "/v2/health") {
      return json(response, 200, {
        service: "suduo-requirements-service",
        status: "ok",
        database: { status: "ok", schemaVersion: 0 },
        uptimeMs: 1,
      });
    }
    if (request.method === "POST" && url.pathname === "/v2/auth/login") {
      return json<AuthSessionDto>(response, 200, {
        accessToken: "gate-c-fixture-token",
        tokenType: "Bearer",
        expiresAt: "2030-01-01T00:00:00.000Z",
        user: currentUser,
      });
    }
    if (request.method === "GET" && url.pathname === "/v2/auth/me") {
      return json<CurrentUserDto>(response, 200, currentUser);
    }
    if (request.method === "GET" && url.pathname === "/v2/users") {
      return json<ListUsersResponse>(response, 200, {
        items: users.toSorted(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
        ),
      });
    }
    if (request.method === "GET" && url.pathname === "/v2/projects") {
      return json<ListProjectsResponse>(response, 200, { items: [project], nextCursor: null });
    }
    if (request.method === "GET" && url.pathname === `/v2/projects/${project.id}`) {
      return json<ProjectDto>(response, 200, project);
    }
    if (
      request.method === "GET" &&
      url.pathname === `/v2/projects/${project.id}/requirements`
    ) {
      return listRequirements(url, response);
    }
    const byNumberMatch = /^\/v2\/projects\/([^/]+)\/requirements\/by-number\/(\d+)$/u.exec(
      url.pathname,
    );
    if (request.method === "GET" && byNumberMatch?.[1] && byNumberMatch[2]) {
      const number = Number(byNumberMatch[2]);
      const found = decodeURIComponent(byNumberMatch[1]) === project.id
        ? [...requirements.values()].find((item) => item.number === number)
        : undefined;
      return found
        ? json<RequirementDetailDto>(response, 200, toDetail(found))
        : notFound(response);
    }
    if (request.method === "GET" && url.pathname === `/v2/projects/${project.id}/stats`) {
      if (remoteFailure) return remoteUnavailable(response);
      const statusCounts = Object.fromEntries(
        REQUIREMENT_STATUSES.map((status) => [status, 0]),
      ) as Record<RequirementStatus, number>;
      for (const requirement of requirements.values()) {
        statusCounts[requirement.status] += 1;
      }
      const stale = requirements.get(GATE_C_FIXTURE_IDS.reqDraft1);
      return json<ProjectStatsResponse>(response, 200, {
        statusCounts,
        staleTotal: stale === undefined ? 0 : 1,
        staleRequirements: stale === undefined ? [] : [{
          id: stale.id,
          number: stale.number,
          title: stale.title,
          status: stale.status,
          staleDays: 16,
          level: "notice",
          lastUpdatedBy: me,
          updatedAt: CREATED_AT,
        }],
        transitions: [
          { date: "2026-08-23", count: 1, byStatus: { in_development: 1 } },
          { date: "2026-08-24", count: 2, byStatus: { in_testing: 1, completed: 1 } },
        ],
      });
    }
    if (request.method === "GET" && url.pathname === "/v2/requirements") {
      if (remoteFailure) return remoteUnavailable(response);
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      return json<ListRequirementsByIdsResponse>(response, 200, {
        items: ids
          .map((id) => requirements.get(id))
          .filter((item): item is FixtureRequirement => item !== undefined)
          .map(toDto),
      });
    }
    const activityMatch = /^\/v2\/requirements\/([^/]+)\/activity$/u.exec(url.pathname);
    if (request.method === "GET" && activityMatch?.[1]) {
      const requirementId = decodeURIComponent(activityMatch[1]);
      if (!requirements.has(requirementId)) return notFound(response);
      // 最新在前；夹具条目少，一页返回。
      return json<ListRequirementActivityResponse>(response, 200, {
        items: activity
          .filter((entry) => entry.requirementId === requirementId)
          .toSorted(
            (left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
          ),
        nextCursor: null,
      });
    }
    const attachmentsMatch = /^\/v2\/requirements\/([^/]+)\/attachments$/u.exec(url.pathname);
    if (request.method === "GET" && attachmentsMatch?.[1]) {
      const requirementId = decodeURIComponent(attachmentsMatch[1]);
      const found = requirements.get(requirementId);
      if (!found) return notFound(response);
      return json<ListAttachmentsResponse>(response, 200, {
        items: listAttachments(requirementId),
        requirementVersion: found.version,
      });
    }
    const versionsMatch = /^\/v2\/requirements\/([^/]+)\/artifact-versions$/u.exec(
      url.pathname,
    );
    if (request.method === "GET" && versionsMatch?.[1]) {
      const requirementId = decodeURIComponent(versionsMatch[1]);
      return json<ListArtifactVersionsResponse>(response, 200, {
        items: artifactVersions
          .filter((artifactVersion) => artifactVersion.requirementId === requirementId)
          .toSorted((left, right) => right.versionNumber - left.versionNumber)
          .map(artifactSummary),
      });
    }
    if (request.method === "POST" && versionsMatch?.[1]) {
      const requirementId = decodeURIComponent(versionsMatch[1]);
      const requirement = requirements.get(requirementId);
      if (!requirement) return notFound(response);
      const body = await requestJson(request) as {
        operationKey?: unknown;
        attachmentIds?: unknown;
        note?: unknown;
      };
      if (
        typeof body.operationKey !== "string" ||
        !Array.isArray(body.attachmentIds) ||
        body.attachmentIds.length === 0
      ) {
        return validationError(response);
      }
      const selectedAttachments = body.attachmentIds.map((attachmentId) =>
        typeof attachmentId === "string" ? attachments.get(attachmentId) : undefined,
      );
      if (
        selectedAttachments.some(
          (attachment) => attachment === undefined || attachment.requirementId !== requirementId,
        )
      ) {
        return validationError(response);
      }
      const versionNumber = artifactVersions.length + 1;
      const versionId = versionNumber === 1
        ? GATE_C_FIXTURE_IDS.artifactVersion1
        : fixtureUuid(200 + versionNumber);
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
      const publishedAt = new Date().toISOString();
      const artifactVersion: FixtureArtifactVersion = {
        id: versionId,
        requirementId,
        versionNumber,
        publishedBy: me,
        publishedAt,
        fileCount: selectedAttachments.length,
        note,
        files: selectedAttachments.map((attachment, index) => ({
          id: versionNumber === 1 && index === 0
            ? GATE_C_FIXTURE_IDS.artifactFile1
            : fixtureUuid(300 + versionNumber * 10 + index),
          artifactVersionId: versionId,
          attachmentId: attachment!.id,
          fileName: attachment!.fileName,
          sizeBytes: attachment!.sizeBytes,
          sha256: attachment!.sha256,
        })),
      };
      artifactVersions.push(artifactVersion);
      // 远程服务会为发布生成一条说明评论（计入 commentCount），但活动里并入发布条目，不单独成条。
      comments.unshift({
        id: versionNumber === 1
          ? GATE_C_FIXTURE_IDS.commentArtifact1
          : fixtureUuid(400 + versionNumber),
        requirementId,
        artifactVersionId: versionId,
        body: note ?? `发布了第 ${String(versionNumber)} 版确认版。`,
        author: me,
        createdAt: publishedAt,
      });
      record({
        requirementId,
        actor: me,
        action: "artifact_version.published",
        resourceType: "artifact_version",
        resourceId: versionId,
        artifactVersion: {
          id: versionId,
          versionNumber,
          fileCount: artifactVersion.fileCount,
          note,
        },
        createdAt: publishedAt,
      });
      json<ArtifactVersionDetailDto>(response, 201, artifactDetail(artifactVersion));
      emit("artifact.published", requirementId, requirement.version);
      return;
    }
    const commentsMatch = /^\/v2\/requirements\/([^/]+)\/comments$/u.exec(url.pathname);
    if (request.method === "GET" && commentsMatch?.[1]) {
      const requirementId = decodeURIComponent(commentsMatch[1]);
      return json<ListCommentsResponse>(response, 200, {
        items: comments.filter((comment) => comment.requirementId === requirementId),
        nextCursor: null,
      });
    }
    const readMatch = /^\/v2\/requirements\/([^/]+)\/read$/u.exec(url.pathname);
    if (request.method === "PUT" && readMatch?.[1]) {
      const requirementId = decodeURIComponent(readMatch[1]);
      if (!requirements.has(requirementId)) return notFound(response);
      const body = await requestJson(request);
      const upTo = typeof body === "object" && body !== null ? (body as { upTo?: unknown }).upTo : undefined;
      if (upTo !== undefined && (typeof upTo !== "string" || Number.isNaN(Date.parse(upTo)))) return validationError(response);
      // 与需求服务一致：不晚于此刻、只往前走。
      const now = Date.now();
      const next = Math.min(upTo === undefined ? now : Date.parse(upTo), now);
      const previous = readMarks.get(requirementId);
      if (previous === undefined || Date.parse(previous) < next) readMarks.set(requirementId, new Date(next).toISOString());
      response.writeHead(204);
      response.end();
      return;
    }
    const artifactMatch = /^\/v2\/artifact-versions\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && artifactMatch?.[1]) {
      const artifactVersion = artifactVersions.find(
        (item) => item.id === decodeURIComponent(artifactMatch[1] ?? ""),
      );
      return artifactVersion
        ? json<ArtifactVersionDetailDto>(response, 200, artifactDetail(artifactVersion))
        : notFound(response);
    }
    const attachmentDeleteMatch = /^\/v2\/attachments\/([^/]+)\/content$/u.exec(
      url.pathname,
    );
    if (request.method === "DELETE" && attachmentDeleteMatch?.[1]) {
      const attachment = attachments.get(decodeURIComponent(attachmentDeleteMatch[1]));
      const requirement = attachment ? requirements.get(attachment.requirementId) : undefined;
      if (!attachment || !requirement) return notFound(response);
      attachments.delete(attachment.id);
      record({
        requirementId: requirement.id,
        actor: me,
        action: "attachment.deleted",
        resourceType: "attachment",
        resourceId: attachment.id,
        attachment: { id: attachment.id, fileName: attachment.fileName },
        createdAt: new Date().toISOString(),
      });
      return json<AttachmentMutationResponse>(response, 200, {
        attachment,
        requirementVersion: requirement.version,
      });
    }
    if (request.method === "GET" && url.pathname === "/v2/audit") {
      if (remoteFailure) return remoteUnavailable(response);
      const belongsToProject = url.searchParams.get("projectId") === project.id;
      const entry: AuditEntryDto = {
        id: GATE_C_FIXTURE_IDS.auditStatusChange,
        actor: me,
        resourceType: "requirement",
        resourceId: GATE_C_FIXTURE_IDS.reqDraft1,
        action: "requirement.status_changed",
        before: { status: "draft" },
        after: { status: "in_development" },
        createdAt: "2026-08-24T10:00:00.000Z",
      };
      return json<ListAuditResponse>(response, 200, {
        items: belongsToProject ? [entry] : [],
        nextCursor: null,
      });
    }
    const requirementMatch = /^\/v2\/requirements\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && requirementMatch?.[1]) {
      const found = requirements.get(decodeURIComponent(requirementMatch[1]));
      return found ? json<RequirementDetailDto>(response, 200, toDetail(found)) : notFound(response);
    }
    if (request.method === "PATCH" && requirementMatch?.[1]) {
      const found = requirements.get(decodeURIComponent(requirementMatch[1]));
      if (!found) return notFound(response);
      if (found.id === GATE_C_FIXTURE_IDS.reqPatchFailure) {
        // 写入真实失败（依赖不可用），而同一时刻同事已把它移到第三列：
        // 前端回滚后重新拉取，应按真实状态落位，而不是回弹原列或停在拖拽目标列。
        // 刻意不广播 SSE——要验证的是前端失败后自己的回查，不是实时事件。
        if (found.status !== PATCH_FAILURE_ACTUAL_STATUS) {
          applyChange(found, teammate, { status: PATCH_FAILURE_ACTUAL_STATUS });
          found.version = 9;
        }
        return json(response, 503, {
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "fixture PATCH dependency unavailable" },
        });
      }
      const body = await requestJson(request) as {
        title?: unknown;
        summary?: unknown;
        status?: unknown;
        assigneeId?: unknown;
      };
      const patch: { title?: string; summary?: string; status?: RequirementStatus; assignee?: UserSummaryDto | null } = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || body.title.trim() === "") return validationError(response);
        patch.title = body.title;
      }
      if (body.summary !== undefined) {
        if (typeof body.summary !== "string") return validationError(response);
        patch.summary = body.summary;
      }
      if (body.status !== undefined) {
        if (!isRequirementStatus(body.status)) return validationError(response);
        patch.status = body.status;
      }
      if (body.assigneeId !== undefined) {
        const assignee = body.assigneeId === null
          ? null
          : users.find((candidate) => candidate.id === body.assigneeId);
        if (assignee === undefined) return validationError(response);
        patch.assignee = assignee;
      }
      if (Object.keys(patch).length === 0) return validationError(response);
      // 刻意不广播 requirement.changed：带外修改要能让另一个窗口保持旧数据。
      applyChange(found, me, patch);
      return json<RequirementDto>(response, 200, toDto(found));
    }
    if (request.method === "GET" && url.pathname === "/v2/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write("retry: 10000\n\n");
      eventClients.add(response);
      request.once("close", () => eventClients.delete(response));
      return;
    }
    notFound(response);
  });

  /** 列表：状态、搜索（标题 / 描述，形如编号时同时按编号）、负责人，按更新时间倒序。 */
  function listRequirements(url: URL, response: ServerResponse): void {
    const status = url.searchParams.get("status");
    if (status !== null && !isRequirementStatus(status)) return validationError(response);
    const search = url.searchParams.get("search");
    if (search !== null && search.trim() === "") return validationError(response);
    const assignee = url.searchParams.get("assignee");
    let assigneeId: string | null | undefined;
    if (assignee === REQUIREMENT_ASSIGNEE_FILTER_ME) assigneeId = me.id;
    else if (assignee === REQUIREMENT_ASSIGNEE_FILTER_NONE) assigneeId = null;
    else if (assignee !== null) {
      if (!UUID.test(assignee)) return validationError(response);
      assigneeId = assignee;
    }
    const needle = search?.trim().toLowerCase();
    const number = search === null ? null : parseRequirementNumberQuery(search);
    const matched = [...requirements.values()]
      .filter((item) => status === null || item.status === status)
      .filter(
        (item) =>
          needle === undefined ||
          item.title.toLowerCase().includes(needle) ||
          item.summary.toLowerCase().includes(needle) ||
          item.number === number,
      )
      .filter((item) => assigneeId === undefined || (item.assignee?.id ?? null) === assigneeId)
      .toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      );
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const page = matched.slice(offset, offset + limit);
    json<ListRequirementsResponse>(response, 200, {
      items: page.map(toDto),
      nextCursor: offset + limit < matched.length ? String(offset + limit) : null,
    });
  }

  /** 与远程服务一致：正文版本只随标题 / 描述 / 状态的实际变化递增，改负责人不递增；每项变化记一条活动。 */
  function applyChange(
    requirement: FixtureRequirement,
    actor: UserSummaryDto,
    patch: { title?: string; summary?: string; status?: RequirementStatus; assignee?: UserSummaryDto | null },
  ): void {
    const at = new Date().toISOString();
    const edits: RequirementActivityChangeDto[] = [];
    if (patch.title !== undefined && patch.title !== requirement.title) {
      edits.push({ field: "title", from: requirement.title, to: patch.title });
      requirement.title = patch.title;
    }
    if (patch.summary !== undefined && patch.summary !== requirement.summary) {
      edits.push({ field: "summary", from: requirement.summary, to: patch.summary });
      requirement.summary = patch.summary;
    }
    const base = {
      requirementId: requirement.id,
      actor,
      resourceType: "requirement" as const,
      resourceId: requirement.id,
      createdAt: at,
    };
    if (edits.length > 0) record({ ...base, action: "requirement.updated", changes: edits });
    let bodyChanged = edits.length > 0;
    if (patch.status !== undefined && patch.status !== requirement.status) {
      record({
        ...base,
        action: "requirement.status_changed",
        changes: [{ field: "status", from: requirement.status, to: patch.status }],
      });
      requirement.status = patch.status;
      bodyChanged = true;
    }
    if (patch.assignee !== undefined && (patch.assignee?.id ?? null) !== (requirement.assignee?.id ?? null)) {
      record({
        ...base,
        action: "requirement.assignee_changed",
        changes: [{ field: "assignee", from: requirement.assignee, to: patch.assignee }],
      });
      requirement.assignee = patch.assignee;
    }
    if (bodyChanged) requirement.version += 1;
    requirement.updatedBy = actor;
    requirement.updatedAt = at;
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server, eventClients);
    throw new Error("requirements fixture did not receive a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    projectId: project.id,
    setRemoteFailure(enabled) {
      remoteFailure = enabled;
    },
    changeRequirement(id, patch) {
      const current = requirements.get(id);
      if (!current) throw new Error(`fixture requirement not found: ${id}`);
      requirements.set(id, {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      });
    },
    restoreRequirement(id) {
      const snapshot = initial.get(id);
      if (!snapshot) throw new Error(`fixture initial requirement not found: ${id}`);
      requirements.set(id, { ...snapshot });
    },
    readMarkOf: (requirementId) => readMarks.get(requirementId),
    close: () => closeServer(server, eventClients),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRequirementStatus(value: unknown): value is RequirementStatus {
  return typeof value === "string" && (REQUIREMENT_STATUSES as readonly string[]).includes(value);
}

function remoteUnavailable(response: ServerResponse): void {
  json(response, 503, {
    error: { code: "REMOTE_UNAVAILABLE", message: "Gate C 远程读模型已按测试开关断开" },
  });
}

function notFound(response: ServerResponse): void {
  json(response, 404, { error: { code: "NOT_FOUND", message: "Gate C 夹具中不存在该资源" } });
}

function validationError(response: ServerResponse): void {
  json(response, 400, { error: { code: "VALIDATION_ERROR", message: "Gate C 夹具参数不合法" } });
}

/** 类型参数让每个成功响应都按契约 DTO 编译期校验。 */
function json<T>(response: ServerResponse, status: number, body: T): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body === "" ? {} : JSON.parse(body) as unknown;
}

async function closeServer(server: Server, eventClients: Set<ServerResponse>): Promise<void> {
  for (const response of eventClients) response.end();
  eventClients.clear();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
