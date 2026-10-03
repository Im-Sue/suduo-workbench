import { randomUUID } from "node:crypto";
import type { DatabasePort } from "../database-port.js";

export type ProjectState = "active" | "removed";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  rootPathKey: string;
  state: ProjectState;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  removedAt: number | null;
  version: number;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  rootPath: string;
  rootPathKey: string;
  now?: number;
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  root_path_key: string;
  state: ProjectState;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  removed_at: number | null;
  version: number;
}

export class ProjectRepository {
  constructor(private readonly database: DatabasePort) {}

  create(input: CreateProjectInput): ProjectRecord {
    const now = input.now ?? Date.now();
    const id = input.id ?? randomUUID();
    this.database
      .prepare(
        [
          "INSERT INTO projects",
          "(id, name, root_path, root_path_key, state, created_at, updated_at, version)",
          "VALUES (@id, @name, @rootPath, @rootPathKey, 'active', @now, @now, 1)",
        ].join(" "),
      )
      .run({
        id,
        name: input.name,
        rootPath: input.rootPath,
        rootPathKey: input.rootPathKey,
        now,
      });
    return requireRecord(this.getById(id), "project", id);
  }

  getById(id: string): ProjectRecord | null {
    const row = this.database
      .prepare("SELECT * FROM projects WHERE id = @id")
      .get<ProjectRow>({ id });
    return row ? mapProject(row) : null;
  }

  getByRootPathKey(rootPathKey: string): ProjectRecord | null {
    const row = this.database
      .prepare("SELECT * FROM projects WHERE root_path_key = @rootPathKey")
      .get<ProjectRow>({ rootPathKey });
    return row ? mapProject(row) : null;
  }

  list(state: ProjectState | "all" = "active"): ProjectRecord[] {
    const rows =
      state === "all"
        ? this.database
            .prepare(
              "SELECT * FROM projects ORDER BY last_opened_at DESC, updated_at DESC",
            )
            .all<ProjectRow>()
        : this.database
            .prepare(
              "SELECT * FROM projects WHERE state = @state ORDER BY last_opened_at DESC, updated_at DESC",
            )
            .all<ProjectRow>({ state });
    return rows.map(mapProject);
  }

  update(
    id: string,
    expectedVersion: number,
    input: { name?: string; state?: "active" },
    now = Date.now(),
  ): boolean {
    const current = this.getById(id);
    if (!current) {
      return false;
    }
    const name = input.name ?? current.name;
    const state = input.state ?? current.state;
    const result = this.database
      .prepare(
        [
          "UPDATE projects SET",
          "name = @name, state = @state, removed_at = NULL,",
          "updated_at = @now, version = version + 1",
          "WHERE id = @id AND version = @expectedVersion",
        ].join(" "),
      )
      .run({ id, expectedVersion, name, state, now });
    return result.changes === 1;
  }

  touchOpened(id: string, now = Date.now()): void {
    this.database
      .prepare(
        "UPDATE projects SET last_opened_at = @now WHERE id = @id",
      )
      .run({ id, now });
  }

  markRemoved(id: string, expectedVersion: number, now = Date.now()): boolean {
    const result = this.database
      .prepare(
        [
          "UPDATE projects",
          "SET state = 'removed', removed_at = @now, updated_at = @now, version = version + 1",
          "WHERE id = @id AND version = @expectedVersion AND state = 'active'",
        ].join(" "),
      )
      .run({ id, expectedVersion, now });
    return result.changes === 1;
  }
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    rootPathKey: row.root_path_key,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    removedAt: row.removed_at,
    version: row.version,
  };
}

function requireRecord<T>(record: T | null, kind: string, id: string): T {
  if (!record) {
    throw new Error(kind + " was not persisted: " + id);
  }
  return record;
}
