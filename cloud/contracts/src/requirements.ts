import type { UserSummaryDto } from "./auth.js";
import type {
  RequirementsCursorPage,
  RequirementsCursorQuery,
} from "./pagination.js";
import type { ProjectDto } from "./projects.js";
import type { AttachmentDto } from "./collaboration.js";
import type { RequirementPriority, RequirementSort } from "./priority.js";
import type { RequirementStatus } from "./status.js";

export interface RequirementDto {
  id: string;
  projectId: string;
  /** 项目内从 1 递增的编号，创建后不变；展示用 `formatRequirementNumber`。 */
  number: number;
  title: string;
  /** Markdown 描述，允许为空字符串。 */
  summary: string;
  status: RequirementStatus;
  /** 负责人；未指派时为 null。 */
  assignee: UserSummaryDto | null;
  /** 优先级；无优先级时为 null。旧版需求服务不返回（客户端按「无」处理）。 */
  priority?: RequirementPriority | null;
  /** 评论数（含产物发布时自动生成的说明评论）。 */
  commentCount: number;
  /** 未删除的附件数。 */
  attachmentCount: number;
  createdBy: UserSummaryDto;
  updatedBy: UserSummaryDto;
  createdAt: string;
  updatedAt: string;
  /** 正文版本：只随标题 / 描述 / 状态的实际变化递增；改负责人、优先级不递增。 */
  version: number;
  /**
   * 只在列表接口里给出：别人发的、在我上次打开这条需求之后的评论数。
   * 从没打开过时只算最近 REQUIREMENT_UNREAD_BASELINE_DAYS 天的，避免老需求一上来全是「新评论」。
   * 旧版需求服务不返回。
   */
  unreadCommentCount?: number;
}

/** 从没打开过的需求，「新评论」只往回算这么多天。 */
export const REQUIREMENT_UNREAD_BASELINE_DAYS = 7;

/**
 * PUT /v2/requirements/:id/read 的请求体。
 * upTo：界面上实际显示出来的最新一条评论的时间（水位）——只把「看到的」记为已读；
 * 省略时按服务端当前时间。服务端取 min(upTo, 现在)，且已读位置只往后挪。
 */
export interface MarkRequirementReadRequest {
  upTo?: string;
}

export interface RequirementDetailDto extends RequirementDto {
  project: Pick<ProjectDto, "id" | "name" | "isArchived" | "version">;
}

export interface CreateRequirementRequest {
  title: string;
  /** 缺省为空字符串。 */
  summary?: string;
  status?: RequirementStatus;
  /** 负责人用户 id；缺省或 null 表示不指派。 */
  assigneeId?: string | null;
  /** 缺省或 null 表示无优先级。 */
  priority?: RequirementPriority | null;
}

export interface UpdateRequirementRequest {
  title?: string;
  summary?: string;
  status?: RequirementStatus;
  /** 负责人用户 id；null 表示清空负责人。 */
  assigneeId?: string | null;
  /** null 表示清空优先级。 */
  priority?: RequirementPriority | null;
}

/** 负责人筛选的保留值：当前登录用户。 */
export const REQUIREMENT_ASSIGNEE_FILTER_ME = "me";
/** 负责人筛选的保留值：未指派。 */
export const REQUIREMENT_ASSIGNEE_FILTER_NONE = "none";

/** 用户 id、`"me"`（当前登录用户）或 `"none"`（未指派）。 */
export type RequirementAssigneeFilter =
  | typeof REQUIREMENT_ASSIGNEE_FILTER_ME
  | typeof REQUIREMENT_ASSIGNEE_FILTER_NONE
  | (string & {});

export interface ListRequirementsQuery extends RequirementsCursorQuery {
  status?: RequirementStatus;
  /** 匹配标题 / 描述；形如 `128`、`REQ-128` 时同时按编号匹配。 */
  search?: string;
  assignee?: RequirementAssigneeFilter;
  /** 创建人：用户 id 或 `"me"`。 */
  creator?: typeof REQUIREMENT_ASSIGNEE_FILTER_ME | (string & {});
  /** 优先级筛选，逗号分隔多选：`urgent,high,none`（`none` = 无优先级）。 */
  priority?: string;
  /** 排序方式，缺省 `updated`。换排序方式时游标不能沿用。 */
  sort?: RequirementSort;
}

export type ListRequirementsResponse =
  RequirementsCursorPage<RequirementDto>;

export interface ListRequirementsByIdsQuery {
  ids: string;
}

export interface ListRequirementsByIdsResponse {
  items: RequirementDto[];
}

export interface RequirementSnapshotDto {
  requirement: RequirementDetailDto;
  attachments: AttachmentDto[];
  capturedAt: string;
}

/** 需求编号的展示前缀：编号 128 展示为 `REQ-128`。 */
export const REQUIREMENT_NUMBER_PREFIX = "REQ-";

/** 编号上限与数据库 integer 对齐，并给解析留出余量。 */
export const REQUIREMENT_NUMBER_MAX = 999_999_999;

export function formatRequirementNumber(number: number): string {
  return `${REQUIREMENT_NUMBER_PREFIX}${String(number)}`;
}

/**
 * 把搜索词解析为需求编号：`128`、`REQ-128`、`req-128`、`REQ 128`、`#128`
 * 都得到 128；不是编号形态时返回 null。
 */
export function parseRequirementNumberQuery(value: string): number | null {
  const match = /^(?:req[-\s]?|#)?(\d{1,9})$/iu.exec(value.trim());
  if (match === null) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= REQUIREMENT_NUMBER_MAX ? number : null;
}
