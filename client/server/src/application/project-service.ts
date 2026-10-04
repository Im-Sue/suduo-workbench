import { basename, normalize } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type {
  CreateProjectRequest,
  ListProjectsQuery,
  ProjectDto,
  UpdateProjectRequest,
} from "@suduo/client-contracts";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../infrastructure/db/repositories/session-repository.js";
import { ApiError } from "./api-error.js";
import { projectDto } from "./dto.js";
import { paginate } from "./pagination.js";

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
  ) {}

  async create(input: CreateProjectRequest): Promise<ProjectDto> {
    if (typeof input.rootPath !== "string" || input.rootPath.includes("\0")) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.project.rootPathInvalid);
    }
    let resolved: string;
    try {
      resolved = await realpath(input.rootPath);
      if (!(await stat(resolved)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch (error) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        (t) => t.workspace.project.rootPathNotReadable,
        undefined,
        { cause: error },
      );
    }
    const rootPathKey = pathKey(resolved);
    const existing = this.projects.getByRootPathKey(rootPathKey);
    if (existing?.state === "active") {
      return projectDto(existing);
    }
    if (existing) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        (t) => t.workspace.project.removed,
        { projectId: existing.id },
      );
    }
    if (input.name !== undefined && typeof input.name !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.project.nameNotString);
    }
    const name = normalizeName(input.name ?? basename(resolved));
    return projectDto(
      this.projects.create({
        name,
        rootPath: resolved,
        rootPathKey,
      }),
    );
  }

  list(query: ListProjectsQuery) {
    const state = query.state ?? "active";
    return paginate(
      this.projects.list(state).map(projectDto),
      query.cursor,
      query.limit,
    );
  }

  get(id: string): ProjectDto {
    const project = this.requireProject(id);
    this.projects.touchOpened(id);
    return projectDto(project);
  }

  update(
    id: string,
    expectedVersion: number,
    input: UpdateProjectRequest,
  ): ProjectDto {
    const current = this.requireProject(id);
    if (input.name !== undefined && typeof input.name !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.project.nameNotString);
    }
    if (input.state !== undefined && input.state !== "active") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.project.stateActiveOnly);
    }
    if (input.name === undefined && input.state === undefined) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.project.patchEmpty);
    }
    if (
      !this.projects.update(id, expectedVersion, {
        ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
        ...(input.state === undefined ? {} : { state: input.state }),
      })
    ) {
      throw versionConflict(current.version);
    }
    return projectDto(this.requireProject(id));
  }

  remove(id: string): void {
    const project = this.requireProject(id);
    if (project.state === "removed") {
      return;
    }
    if (this.sessions.hasActiveByProject(id)) {
      throw new ApiError(
        409,
        "PROJECT_HAS_ACTIVE_SESSIONS",
        (t) => t.workspace.project.hasActiveSessions,
      );
    }
    if (!this.projects.markRemoved(id, project.version)) {
      throw versionConflict(project.version);
    }
  }

  requireProject(id: string) {
    const project = this.projects.getById(id);
    if (!project) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.workspace.project.notFound);
    }
    return project;
  }
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 200) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.project.nameLength);
  }
  return name;
}

function pathKey(path: string): string {
  const key = normalize(path);
  return process.platform === "win32" ? key.toLocaleLowerCase("en-US") : key;
}

function versionConflict(actualVersion: number): ApiError {
  return new ApiError(409, "VERSION_CONFLICT", (t) => t.workspace.project.versionConflict, {
    actualVersion,
  });
}
