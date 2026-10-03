/**
 * 本机服务（`/api/v2`）在远程 DTO 之外补充的本机字段与本机专属接口。
 * 这些类型只出现在浏览器 ↔ 本机服务之间，远程需求服务不返回它们。
 */
import type {
  RequirementDetailDto,
  RequirementDto,
  RequirementsCursorPage,
} from "@suduo/cloud-contracts";

/** 本机服务为每条需求补充的本机统计。 */
export interface RequirementLocalFields {
  /** 本机 SQLite 中关联到该需求、且未删除的会话数（含已归档）。 */
  localSessionCount: number;
}

/** `/api/v2` 需求列表、创建、更新返回的条目。 */
export type RequirementListItemDto = RequirementDto & RequirementLocalFields;

/** `/api/v2/requirements/:id` 返回的详情。 */
export type RequirementDetailItemDto = RequirementDetailDto & RequirementLocalFields;

export type ListRequirementItemsResponse =
  RequirementsCursorPage<RequirementListItemDto>;

export const LOCAL_PATH_ERROR_CODES = [
  /** 不是绝对路径或含 NUL。HTTP 400。 */
  "LOCAL_PATH_INVALID",
  /** 路径不存在。HTTP 404。 */
  "LOCAL_PATH_NOT_FOUND",
  /** 路径存在但不是目录。HTTP 400。 */
  "LOCAL_PATH_NOT_DIRECTORY",
  /** 没有读取权限。HTTP 403。 */
  "LOCAL_PATH_PERMISSION_DENIED",
] as const;

export type LocalPathErrorCode = (typeof LOCAL_PATH_ERROR_CODES)[number];

/** 目录浏览单次最多返回的子目录数。 */
export const LOCAL_DIRECTORY_ENTRY_LIMIT = 500;

export interface LocalDirectoryListQuery {
  /** 绝对路径；缺省为用户主目录。 */
  path?: string;
  /** `"1"` 时包含以 `.` 开头的隐藏目录；`"0"` 或缺省时不含。 */
  hidden?: "1" | "0";
}

export interface LocalDirectoryEntryDto {
  name: string;
  /** 父目录 realpath 与名称拼接的绝对路径（符号链接不展开）。 */
  path: string;
  /** 目录下存在 `.git`（目录或 gitdir 文件）。 */
  isGitRepo: boolean;
  readable: boolean;
  writable: boolean;
  /**
   * 为 false 时本机服务没有探测该目录：macOS 列用户主目录时，第一层受隐私保护的目录
   * （Desktop、Documents、Downloads、Library、Movies、Music、Pictures）一探测就会弹系统
   * 授权框。此时 isGitRepo 固定 false、readable / writable 固定 true，不代表实际情况，
   * 前端按普通目录显示。已探测时省略该字段。
   */
  probed?: false;
}

/** `GET /api/v2/local/dirs`。 */
export interface LocalDirectoryListingDto {
  /** 请求路径的 realpath。 */
  path: string;
  /** 上一级目录；已是根目录时为 null。 */
  parent: string | null;
  home: string;
  /** 只含目录，按名称排序，最多 `LOCAL_DIRECTORY_ENTRY_LIMIT` 条。 */
  entries: LocalDirectoryEntryDto[];
  /** 子目录数超过上限、被截断时为 true。 */
  truncated: boolean;
  /** 已关联到需求项目的本机目录，最近使用在前。 */
  recent: string[];
}

export interface LocalPathInspectQuery {
  path: string;
}

/** `GET /api/v2/local/dirs/inspect`：输入路径时的即时校验，不存在不算错误。 */
export interface LocalPathInspectionDto {
  /** 存在时为 realpath，否则为规范化后的输入路径。 */
  path: string;
  exists: boolean;
  isDirectory: boolean;
  readable: boolean;
  writable: boolean;
  /** 该目录本身是 Git 仓库根（存在 `.git`）。 */
  isGitRepo: boolean;
  /** 当前分支名；非仓库或处于分离 HEAD 时为 null。 */
  branch: string | null;
}
