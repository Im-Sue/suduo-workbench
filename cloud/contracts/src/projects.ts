import type { UserSummaryDto } from "./auth.js";
import type {
  RequirementsCursorPage,
  RequirementsCursorQuery,
} from "./pagination.js";

export interface ProjectDto {
  id: string;
  name: string;
  isArchived: boolean;
  createdBy: UserSummaryDto;
  updatedBy: UserSummaryDto;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CreateProjectRequest {
  name: string;
}

/** 至少提供一个字段；并发时后写生效，不做版本校验（ADR-0004）。 */
export interface UpdateProjectRequest {
  name?: string;
  isArchived?: boolean;
}

export interface ListProjectsQuery extends RequirementsCursorQuery {
  includeArchived?: boolean;
}

export type ListProjectsResponse = RequirementsCursorPage<ProjectDto>;
