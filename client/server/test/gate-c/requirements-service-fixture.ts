import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  REQUIREMENT_ASSIGNEE_FILTER_ME,
  REQUIREMENT_ASSIGNEE_FILTER_NONE,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_PRIORITY_FILTER_NONE,
  REQUIREMENT_STATUSES,
  CLOUD_FEATURES,
  parseRequirementNumberQuery,
  parseRequirementPriorityFilter,
  requirementPriorityRank,
  type ArtifactVersionDetailDto,
  type ArtifactVersionDto,
  type AttachmentDto,
  type AttachmentMutationResponse,
  type AuditEntryDto,
  type AuthSessionDto,
  type CommentDto,
  type CurrentUserDto,
  type ListArtifactVersionsResponse,
  type ListAgentShareRequestsResponse,
  type ListAgentSharesResponse,
  type ListAgentsResponse,
  type ListAttachmentsResponse,
  type ListAuditResponse,
  type ListCommentsResponse,
  type ListProjectsResponse,
  type ListRequirementActivityResponse,
  type ListRequirementsByIdsResponse,
  type ListRequirementsResponse,
  type ListRoomMembersResponse,
  type ListRoomMessagesResponse,
  type ListRoomsResponse,
  type ListUsersResponse,
  type ProjectDto,
  type ProjectStatsResponse,
  type RequirementActivityChangeDto,
  type RequirementActivityEntryDto,
  type RequirementDetailDto,
  type RequirementDto,
  type RequirementPriority,
  type RequirementStatus,
  type RequirementsEventDto,
  type RequirementsEventType,
  type RoomDto,
  type RoomMentionDto,
  type RoomMessageDto,
  type RoomViewerStateDto,
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
  /** 项目默认讨论房间（英文冒烟在这里发消息）。 */
  projectRoom: "10000000-0000-4000-8000-000000000016",
  /** 房间里预置的一条同事消息。 */
  roomWelcomeMessage: "10000000-0000-4000-8000-000000000017",
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
/** 预置的历史确认版的发布时间（确认版停用前）。 */
const HISTORY_PUBLISHED_AT = "2026-08-24T00:00:00.000Z";
/** 夹具里唯一一条评论（普通评论）的时间：详情页显示出它后，已读位置应记到这里。 */
export const GATE_C_FIXTURE_COMMENT_AT = MATERIALS_AT;

const PUBLISH_MATERIAL_NAME = "发布材料.txt";
const DELETABLE_MATERIAL_NAME = "待删除材料.txt";
const ORDINARY_COMMENT_BODY = "这是一条普通评论，应继续按普通评论显示。";
const ROOM_WELCOME_BODY = "欢迎来到项目讨论：这条消息是 Gate C 夹具预置的。";
const ROOM_WELCOME_AT = "2026-08-23T08:00:00.000Z";
/** 房间消息里 @ 所有人的兜底文字（与远程服务一致，英文）。 */
const MENTION_ALL_LABEL = "everyone";

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
  /** 项目讨论房间里所有消息的正文（按序号）：验证界面发出的消息经 BFF 到了远程。 */
  roomMessageBodies(): string[];
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
  priority: RequirementPriority | null;
  version: number;
  updatedBy: UserSummaryDto;
  updatedAt: string;
}

interface RequirementPatch {
  title?: string;
  summary?: string;
  status?: RequirementStatus;
  assignee?: UserSummaryDto | null;
  priority?: RequirementPriority | null;
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
      priority: null,
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

/**
 * 夹具里的人写内容与演示数据：项目名、人名、需求标题、材料名、评论、讨论消息。
 * 只有系统生成的文字随界面语言变，这些原样显示（中英双语需求的用户原则）；
 * 英文冒烟检查「英文界面里有没有漏翻的中文」时，把它们当成允许出现的中文。
 */
export const GATE_C_FIXTURE_HUMAN_TEXTS: readonly string[] = [
  project.name,
  ...users.map((user) => user.displayName),
  ...[...initialRequirements().values()].map((requirement) => requirement.title),
  PUBLISH_MATERIAL_NAME,
  DELETABLE_MATERIAL_NAME,
  ORDINARY_COMMENT_BODY,
  ROOM_WELCOME_BODY,
];

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
        fileName: PUBLISH_MATERIAL_NAME,
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
        fileName: DELETABLE_MATERIAL_NAME,
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
      body: ORDINARY_COMMENT_BODY,
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

  // 确认版停用前发布过的一版（只读历史）：版本、发布说明评论（并入发布条目，不单独成条）与活动。
  {
    const publishMaterial = attachments.get(GATE_C_FIXTURE_IDS.attachment1)!;
    const historyNote = "历史发布说明";
    artifactVersions.push({
      id: GATE_C_FIXTURE_IDS.artifactVersion1,
      requirementId: targetRequirementId,
      versionNumber: 1,
      publishedBy: me,
      publishedAt: HISTORY_PUBLISHED_AT,
      fileCount: 1,
      note: historyNote,
      files: [
        {
          id: GATE_C_FIXTURE_IDS.artifactFile1,
          artifactVersionId: GATE_C_FIXTURE_IDS.artifactVersion1,
          attachmentId: publishMaterial.id,
          fileName: publishMaterial.fileName,
          sizeBytes: publishMaterial.sizeBytes,
          sha256: publishMaterial.sha256,
        },
      ],
    });
    comments.push({
      id: GATE_C_FIXTURE_IDS.commentArtifact1,
      requirementId: targetRequirementId,
      artifactVersionId: GATE_C_FIXTURE_IDS.artifactVersion1,
      body: historyNote,
      author: me,
      createdAt: HISTORY_PUBLISHED_AT,
    });
    record({
      requirementId: targetRequirementId,
      actor: me,
      action: "artifact_version.published",
      resourceType: "artifact_version",
      resourceId: GATE_C_FIXTURE_IDS.artifactVersion1,
      artifactVersion: { id: GATE_C_FIXTURE_IDS.artifactVersion1, versionNumber: 1, fileCount: 1, note: historyNote },
      createdAt: HISTORY_PUBLISHED_AT,
    });
  }

  let eventSequence = 0;
  let remoteFailure = false;
  const readMarks = new Map<string, string>();

  // ---------- 讨论房间：只有项目默认房间，够看消息流、发消息（英文冒烟） ----------
  const roomId = GATE_C_FIXTURE_IDS.projectRoom;
  const roomMessages: RoomMessageDto[] = [
    {
      id: GATE_C_FIXTURE_IDS.roomWelcomeMessage,
      roomId,
      seq: 1,
      clientId: null,
      authorKind: "user",
      author: teammate,
      agent: null,
      body: ROOM_WELCOME_BODY,
      mentions: [],
      threadRootId: null,
      files: [],
      thread: null,
      runs: [],
      createdAt: ROOM_WELCOME_AT,
    },
  ];
  // 预置消息已读：侧栏「讨论」不带未读数，中文全量的页面与改动前一致。
  let roomLastReadSeq = 1;
  const roomLastSeq = (): number => roomMessages.reduce((max, message) => Math.max(max, message.seq), 0);
  const roomViewer = (): RoomViewerStateDto => ({
    joined: true,
    lastReadSeq: roomLastReadSeq,
    unreadCount: roomMessages.filter(
      (message) => message.seq > roomLastReadSeq && message.author?.id !== me.id,
    ).length,
    mentionCount: 0,
  });
  const projectRoom = (): RoomDto => {
    const last = roomMessages.at(-1);
    return {
      id: roomId,
      projectId: project.id,
      kind: "project_default",
      name: project.name,
      requirement: null,
      lastSeq: roomLastSeq(),
      archivedAt: null,
      createdBy: null,
      createdAt: CREATED_AT,
      memberCount: users.length,
      viewer: roomViewer(),
      lastMessage:
        last === undefined
          ? null
          : {
              seq: last.seq,
              authorName: last.author?.displayName ?? "",
              preview: last.body,
              createdAt: last.createdAt,
              authorKind: last.authorKind,
              agent: null,
              text: last.body,
              firstFile: null,
              fileCount: 0,
            },
    };
  };

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
    priority: item.priority,
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
        features: [...CLOUD_FEATURES],
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
    const commentsMatch = /^\/v2\/requirements\/([^/]+)\/comments$/u.exec(url.pathname);
    if (request.method === "GET" && commentsMatch?.[1]) {
      const requirementId = decodeURIComponent(commentsMatch[1]);
      return json<ListCommentsResponse>(response, 200, {
        items: comments.filter((comment) => comment.requirementId === requirementId),
        nextCursor: null,
      });
    }
    if (request.method === "POST" && commentsMatch?.[1]) {
      // 与远程服务一致：发评论写一条活动并广播 comment.created（跨窗口实时验证用它）。
      const requirementId = decodeURIComponent(commentsMatch[1]);
      const requirement = requirements.get(requirementId);
      if (!requirement) return notFound(response);
      const body = await requestJson(request) as { body?: unknown };
      if (typeof body.body !== "string" || body.body.trim() === "") return validationError(response);
      const createdAt = new Date().toISOString();
      const comment: CommentDto = {
        id: fixtureUuid(600 + comments.length),
        requirementId,
        artifactVersionId: null,
        body: body.body.trim(),
        author: me,
        createdAt,
      };
      comments.unshift(comment);
      record({
        requirementId,
        actor: me,
        action: "comment.created",
        resourceType: "comment",
        resourceId: comment.id,
        comment: { id: comment.id, body: comment.body },
        createdAt,
      });
      json<CommentDto>(response, 201, comment);
      emit("comment.created", requirementId, requirement.version);
      return;
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
        priority?: unknown;
      };
      const patch: RequirementPatch = {};
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
      if (body.priority !== undefined) {
        if (body.priority !== null && !(REQUIREMENT_PRIORITIES as readonly unknown[]).includes(body.priority)) {
          return validationError(response);
        }
        patch.priority = body.priority as RequirementPriority | null;
      }
      if (Object.keys(patch).length === 0) return validationError(response);
      // 刻意不广播 requirement.changed：带外修改要能让另一个窗口保持旧数据。
      applyChange(found, me, patch);
      return json<RequirementDto>(response, 200, toDto(found));
    }
    if (request.method === "GET" && url.pathname === `/v2/projects/${project.id}/rooms`) {
      return json<ListRoomsResponse>(response, 200, { items: [projectRoom()] });
    }
    const requirementRoomsMatch = /^\/v2\/requirements\/([^/]+)\/rooms$/u.exec(url.pathname);
    if (request.method === "GET" && requirementRoomsMatch?.[1]) {
      // 需求下没有讨论（建需求讨论不在 gate-c 范围内）。
      if (!requirements.has(decodeURIComponent(requirementRoomsMatch[1]))) return notFound(response);
      return json<ListRoomsResponse>(response, 200, { items: [] });
    }
    const roomMatch = /^\/v2\/rooms\/([^/]+)(\/[a-z/-]+)?$/u.exec(url.pathname);
    if (roomMatch?.[1]) {
      if (decodeURIComponent(roomMatch[1]) !== roomId) return notFound(response);
      return handleRoom(request, response, url, roomMatch[2] ?? "");
    }
    if (request.method === "GET" && url.pathname === "/v2/agents") {
      // 没有登记的 Agent：本机服务的登记 / 心跳仍落到 404，与改动前一致。
      return json<ListAgentsResponse>(response, 200, { items: [] });
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

  /** 项目默认房间的子资源：详情、成员、已读、消息（列表 / 发送 / 搜索）、共享（空）。 */
  async function handleRoom(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    resource: string,
  ): Promise<void> {
    const route = `${request.method ?? "GET"} ${resource}`;
    if (route === "GET ") return json<RoomDto>(response, 200, projectRoom());
    if (route === "GET /members" || route === "POST /members") {
      // 项目默认房间所有人都在（加入是空操作）。
      return json<ListRoomMembersResponse>(response, 200, {
        items: users.map((user) => ({ user, joinedAt: null, online: user.id === me.id })),
      });
    }
    if (route === "POST /read") {
      const body = await requestJson(request) as { upToSeq?: unknown };
      if (typeof body.upToSeq !== "number" || !Number.isSafeInteger(body.upToSeq) || body.upToSeq < 0) {
        return validationError(response);
      }
      // 与远程服务一致：只会前进，回退按位置不变处理。
      roomLastReadSeq = Math.max(roomLastReadSeq, Math.min(body.upToSeq, roomLastSeq()));
      return json<RoomViewerStateDto>(response, 200, roomViewer());
    }
    if (route === "GET /messages") return listRoomMessages(url, response);
    if (route === "POST /messages") return sendRoomMessage(request, response);
    if (route === "GET /messages/search") {
      const query = url.searchParams.get("q")?.trim().toLowerCase();
      const limit = queryInteger(url, "limit");
      const before = queryInteger(url, "before");
      if (!query || limit === null || before === null) return validationError(response);
      const matched = roomMessages.filter((message) => message.body.toLowerCase().includes(query));
      return json<ListRoomMessagesResponse>(
        response,
        200,
        roomMessagePage(matched, { before, limit: Math.min(limit ?? 20, 50) }),
      );
    }
    if (route === "GET /shares") return json<ListAgentSharesResponse>(response, 200, { items: [] });
    if (route === "GET /share-requests") {
      return json<ListAgentShareRequestsResponse>(response, 200, { items: [] });
    }
    notFound(response);
  }

  /** 主消息流只列顶层消息；带 threadRootId 时列话题（根 + 回复）。按序号正序。 */
  function listRoomMessages(url: URL, response: ServerResponse): void {
    const after = queryInteger(url, "after");
    const before = queryInteger(url, "before");
    const limit = queryInteger(url, "limit");
    if (after === null || before === null || limit === null) return validationError(response);
    const rootId = url.searchParams.get("threadRootId");
    const scope = roomMessages.filter((message) =>
      rootId === null ? message.threadRootId === null : message.id === rootId || message.threadRootId === rootId,
    );
    json<ListRoomMessagesResponse>(
      response,
      200,
      roomMessagePage(scope, { after, before, limit: Math.min(Math.max(limit ?? 50, 1), 200) }),
    );
  }

  function roomMessagePage(
    scope: readonly RoomMessageDto[],
    range: { after?: number | undefined; before?: number | undefined; limit: number },
  ): ListRoomMessagesResponse {
    const sorted = scope.toSorted((left, right) => left.seq - right.seq);
    if (range.after !== undefined) {
      const after = range.after;
      const newer = sorted.filter((message) => message.seq > after);
      return {
        items: newer.slice(0, range.limit),
        hasMoreBefore: sorted.some((message) => message.seq <= after),
        hasMoreAfter: newer.length > range.limit,
        lastSeq: roomLastSeq(),
      };
    }
    const before = range.before;
    const older = before === undefined ? sorted : sorted.filter((message) => message.seq < before);
    return {
      items: older.slice(-range.limit),
      hasMoreBefore: older.length > range.limit,
      hasMoreAfter: false,
      lastSeq: roomLastSeq(),
    };
  }

  async function sendRoomMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await requestJson(request) as {
      clientId?: unknown;
      body?: unknown;
      mentions?: unknown;
      threadRootId?: unknown;
      fileIds?: unknown;
    };
    if (typeof body.clientId !== "string" || body.clientId === "" || typeof body.body !== "string" || body.body.trim() === "") {
      return validationError(response);
    }
    // 夹具不存房间文件：带文件的消息不在 gate-c 范围内。
    if (body.fileIds !== undefined && (!Array.isArray(body.fileIds) || body.fileIds.length > 0)) {
      return validationError(response);
    }
    const threadRootId = body.threadRootId ?? null;
    const root = threadRootId === null
      ? null
      : roomMessages.find((message) => message.id === threadRootId && message.threadRootId === null);
    if (root === undefined) return validationError(response);
    // 网络重试带同一个 clientId：返回已有那条（ADR-0004 合并，不拒绝）。
    const existing = roomMessages.find((message) => message.clientId === body.clientId);
    if (existing !== undefined) return json<RoomMessageDto>(response, 200, existing);
    const mentions = roomMentions(body.mentions);
    if (mentions === null) return validationError(response);
    const message: RoomMessageDto = {
      id: fixtureUuid(700 + roomMessages.length),
      roomId,
      seq: roomLastSeq() + 1,
      clientId: body.clientId,
      authorKind: "user",
      author: me,
      agent: null,
      body: body.body,
      mentions,
      threadRootId: root === null ? null : root.id,
      files: [],
      thread: null,
      runs: [],
      createdAt: new Date().toISOString(),
    };
    roomMessages.push(message);
    if (root !== null) {
      root.thread = {
        replyCount: (root.thread?.replyCount ?? 0) + 1,
        lastReplyAt: message.createdAt,
        lastRepliers: [me],
      };
    }
    // 自己发的消息不算未读。
    roomLastReadSeq = message.seq;
    json<RoomMessageDto>(response, 201, message);
  }

  /** @ 人与 @ 所有人；夹具没有 Agent，@ Agent 按参数不合法处理。 */
  function roomMentions(raw: unknown): RoomMentionDto[] | null {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return null;
    const mentions: RoomMentionDto[] = [];
    for (const item of raw as unknown[]) {
      const mention = item as { kind?: unknown; id?: unknown };
      if (mention.kind === "all") {
        mentions.push({ kind: "all", id: null, label: MENTION_ALL_LABEL });
        continue;
      }
      const user = mention.kind === "user" ? users.find((candidate) => candidate.id === mention.id) : undefined;
      if (user === undefined) return null;
      mentions.push({ kind: "user", id: user.id, label: user.displayName });
    }
    return mentions;
  }

  /** 列表：状态、搜索（标题 / 描述，形如编号时同时按编号）、负责人、优先级；按更新时间倒序，`sort=priority` 时先按优先级。 */
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
    const priorityParam = url.searchParams.get("priority");
    const priorities = priorityParam === null ? null : parseRequirementPriorityFilter(priorityParam);
    if (priorityParam !== null && priorities === null) return validationError(response);
    const sort = url.searchParams.get("sort");
    if (sort !== null && sort !== "updated" && sort !== "priority") return validationError(response);
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
      .filter(
        (item) =>
          priorities === null ||
          priorities.includes(item.priority ?? REQUIREMENT_PRIORITY_FILTER_NONE),
      )
      .toSorted(
        (left, right) =>
          (sort === "priority" ? requirementPriorityRank(right.priority) - requirementPriorityRank(left.priority) : 0) ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.id.localeCompare(left.id),
      );
    const offset = Number(url.searchParams.get("cursor") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const page = matched.slice(offset, offset + limit);
    json<ListRequirementsResponse>(response, 200, {
      items: page.map(toDto),
      nextCursor: offset + limit < matched.length ? String(offset + limit) : null,
    });
  }

  /** 与远程服务一致：正文版本只随标题 / 描述 / 状态的实际变化递增，改负责人、优先级不递增；每项变化记一条活动。 */
  function applyChange(
    requirement: FixtureRequirement,
    actor: UserSummaryDto,
    patch: RequirementPatch,
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
    if (patch.priority !== undefined && patch.priority !== requirement.priority) {
      record({
        ...base,
        action: "requirement.priority_changed",
        changes: [{ field: "priority", from: requirement.priority, to: patch.priority }],
      });
      requirement.priority = patch.priority;
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
    roomMessageBodies: () => roomMessages.toSorted((left, right) => left.seq - right.seq).map((message) => message.body),
    close: () => closeServer(server, eventClients),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** 非负整数查询参数：没带为 undefined，写错为 null。 */
function queryInteger(url: URL, name: string): number | undefined | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === raw ? value : null;
}

function isRequirementStatus(value: unknown): value is RequirementStatus {
  return typeof value === "string" && (REQUIREMENT_STATUSES as readonly string[]).includes(value);
}

// 报错正文与远程服务一致用英文（中英双语 S5 起云端报错是英文）：英文冒烟里原样透出的报错不该带中文。
function remoteUnavailable(response: ServerResponse): void {
  json(response, 503, {
    error: { code: "REMOTE_UNAVAILABLE", message: "Gate C fixture: the remote read model is switched off by the test" },
  });
}

function notFound(response: ServerResponse): void {
  json(response, 404, { error: { code: "NOT_FOUND", message: "Gate C fixture: resource not found" } });
}

function validationError(response: ServerResponse): void {
  json(response, 400, { error: { code: "VALIDATION_ERROR", message: "Gate C fixture: invalid parameters" } });
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
