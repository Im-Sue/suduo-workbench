import { randomUUID } from "node:crypto";
import type { JsonValue, Locale } from "@suduo/client-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

/** 并行试做（迁移 025 `trial_groups` / `trial_entries`，多 Agent 协作 S10）。 */
export type TrialGroupStatus = "active" | "adopted" | "closed";
export type TrialEntryStatus = "preparing" | "setup_failed" | "started" | "failed" | "removed";
export type TrialAdoptMode = "merge" | "keep-branch";

export interface TrialGroupRecord {
  id: string;
  projectId: string;
  remoteRequirementId: string | null;
  requirementLabel: string | null;
  remoteProjectId: string | null;
  /** 需求编号（REQ-12）；没有编号为 null。 */
  label: string | null;
  locale: Locale;
  /** 项目目录在 git 仓库里的相对位置（仓库根为空串）。 */
  projectSubdir: string;
  task: string;
  baseCommit: string;
  baseBranch: string | null;
  setupCommand: string | null;
  status: TrialGroupStatus;
  adoptedEntryId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TrialEntryRecord {
  id: string;
  groupId: string;
  agentId: string;
  sessionId: string | null;
  path: string;
  branch: string;
  status: TrialEntryStatus;
  setupLog: string | null;
  error: string | null;
  /** 分支是这一版建的。 */
  branchCreated: boolean;
  /** worktree 建成了。 */
  worktreeCreated: boolean;
  branchRemoved: boolean;
  /** `git branch -d` 被拒时 git 的原话。 */
  branchError: string | null;
  adoptMode: TrialAdoptMode | null;
  adoptResult: JsonValue | null;
  createdAt: number;
  updatedAt: number;
}

interface GroupRow {
  id: string;
  project_id: string;
  remote_requirement_id: string | null;
  requirement_label: string | null;
  remote_project_id: string | null;
  label: string | null;
  locale: string;
  project_subdir: string;
  task: string;
  base_commit: string;
  base_branch: string | null;
  setup_command: string | null;
  status: TrialGroupStatus;
  adopted_entry_id: string | null;
  created_at: number;
  updated_at: number;
}

interface EntryRow {
  id: string;
  group_id: string;
  agent_id: string;
  session_id: string | null;
  path: string;
  branch: string;
  status: TrialEntryStatus;
  setup_log: string | null;
  error: string | null;
  branch_created: number;
  worktree_created: number;
  branch_error: string | null;
  branch_removed: number;
  adopt_mode: TrialAdoptMode | null;
  adopt_result_json: string | null;
  created_at: number;
  updated_at: number;
}

export class TrialRepository {
  constructor(private readonly database: DatabasePort) {}

  createGroup(input: Omit<TrialGroupRecord, "id" | "status" | "adoptedEntryId" | "createdAt" | "updatedAt"> & { id?: string; now?: number }): TrialGroupRecord {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO trial_groups (id, project_id, remote_requirement_id, requirement_label, remote_project_id, label, locale, project_subdir, task, base_commit, base_branch, setup_command, status, created_at, updated_at)",
          "VALUES (@id, @projectId, @remoteRequirementId, @requirementLabel, @remoteProjectId, @label, @locale, @projectSubdir, @task, @baseCommit, @baseBranch, @setupCommand, 'active', @now, @now)",
        ].join(" "),
      )
      .run({
        id,
        projectId: input.projectId,
        remoteRequirementId: input.remoteRequirementId,
        requirementLabel: input.requirementLabel,
        remoteProjectId: input.remoteProjectId,
        label: input.label,
        locale: input.locale,
        projectSubdir: input.projectSubdir,
        task: input.task,
        baseCommit: input.baseCommit,
        baseBranch: input.baseBranch,
        setupCommand: input.setupCommand,
        now,
      });
    return this.requireGroup(id);
  }

  getGroup(id: string): TrialGroupRecord | null {
    const row = this.database.prepare("SELECT * FROM trial_groups WHERE id = @id").get<GroupRow>({ id });
    return row ? mapGroup(row) : null;
  }

  listGroups(projectId: string): TrialGroupRecord[] {
    return this.database.prepare("SELECT * FROM trial_groups WHERE project_id = @projectId ORDER BY created_at DESC").all<GroupRow>({ projectId }).map(mapGroup);
  }

  /** 这个项目上次试做用的准备命令（按项目记住；记在本机库里，不放仓库，免得被仓库里的改动换掉）。 */
  lastSetupCommand(projectId: string): string | null {
    const row = this.database
      .prepare("SELECT setup_command FROM trial_groups WHERE project_id = @projectId ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get<{ setup_command: string | null }>({ projectId });
    return row?.setup_command ?? null;
  }

  /** 各版在用的分支名（发起时避开：还在准备的版本，分支可能还没建出来）。 */
  listBranchesInUse(projectId: string): string[] {
    return this.database
      .prepare(
        "SELECT e.branch FROM trial_entries e JOIN trial_groups g ON g.id = e.group_id WHERE g.project_id = @projectId AND (e.status = 'preparing' OR (e.branch_created = 1 AND e.branch_removed = 0))",
      )
      .all<{ branch: string }>({ projectId })
      .map((row) => row.branch);
  }

  updateGroup(id: string, patch: Partial<Pick<TrialGroupRecord, "status" | "adoptedEntryId">>, now = Date.now()): TrialGroupRecord {
    const next = { ...this.requireGroup(id), ...patch };
    this.database
      .prepare("UPDATE trial_groups SET status = @status, adopted_entry_id = @adoptedEntryId, updated_at = @now WHERE id = @id")
      .run({ id, status: next.status, adoptedEntryId: next.adoptedEntryId, now });
    return this.requireGroup(id);
  }

  createEntry(input: { groupId: string; agentId: string; path: string; branch: string; now?: number }): TrialEntryRecord {
    const id = randomUUID();
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        "INSERT INTO trial_entries (id, group_id, agent_id, path, branch, status, created_at, updated_at) VALUES (@id, @groupId, @agentId, @path, @branch, 'preparing', @now, @now)",
      )
      .run({ id, groupId: input.groupId, agentId: input.agentId, path: input.path, branch: input.branch, now });
    return this.requireEntry(id);
  }

  getEntry(id: string): TrialEntryRecord | null {
    const row = this.database.prepare("SELECT * FROM trial_entries WHERE id = @id").get<EntryRow>({ id });
    return row ? mapEntry(row) : null;
  }

  /** 试做会话对应的那一版（会话工作目录、工具规则用）。 */
  getEntryBySession(sessionId: string): TrialEntryRecord | null {
    const row = this.database.prepare("SELECT * FROM trial_entries WHERE session_id = @sessionId LIMIT 1").get<EntryRow>({ sessionId });
    return row ? mapEntry(row) : null;
  }

  listEntries(groupId: string): TrialEntryRecord[] {
    return this.database.prepare("SELECT * FROM trial_entries WHERE group_id = @groupId ORDER BY created_at ASC").all<EntryRow>({ groupId }).map(mapEntry);
  }

  /** 还在准备的（本机服务重启时收尾为失败）。 */
  listPreparing(): TrialEntryRecord[] {
    return this.database.prepare("SELECT * FROM trial_entries WHERE status = 'preparing' ORDER BY created_at ASC").all<EntryRow>().map(mapEntry);
  }

  updateEntry(
    id: string,
    patch: Partial<
      Pick<TrialEntryRecord, "sessionId" | "status" | "setupLog" | "error" | "branchCreated" | "worktreeCreated" | "branchRemoved" | "branchError" | "adoptMode" | "adoptResult">
    >,
    now = Date.now(),
  ): TrialEntryRecord {
    const next = { ...this.requireEntry(id), ...patch };
    this.database
      .prepare(
        [
          "UPDATE trial_entries SET session_id = @sessionId, status = @status, setup_log = @setupLog, error = @error, branch_created = @branchCreated,",
          "worktree_created = @worktreeCreated, branch_removed = @branchRemoved, branch_error = @branchError, adopt_mode = @adoptMode, adopt_result_json = @adoptResult,",
          "updated_at = @now WHERE id = @id",
        ].join(" "),
      )
      .run({
        id,
        sessionId: next.sessionId,
        status: next.status,
        setupLog: next.setupLog,
        error: next.error,
        branchCreated: next.branchCreated ? 1 : 0,
        worktreeCreated: next.worktreeCreated ? 1 : 0,
        branchRemoved: next.branchRemoved ? 1 : 0,
        branchError: next.branchError,
        adoptMode: next.adoptMode,
        adoptResult: next.adoptResult === null ? null : serializeJson(next.adoptResult),
        now,
      });
    return this.requireEntry(id);
  }

  private requireGroup(id: string): TrialGroupRecord {
    const record = this.getGroup(id);
    if (record === null) throw new Error("trial group was not persisted: " + id);
    return record;
  }

  private requireEntry(id: string): TrialEntryRecord {
    const record = this.getEntry(id);
    if (record === null) throw new Error("trial entry was not persisted: " + id);
    return record;
  }
}

function mapGroup(row: GroupRow): TrialGroupRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    remoteRequirementId: row.remote_requirement_id,
    requirementLabel: row.requirement_label,
    remoteProjectId: row.remote_project_id,
    label: row.label,
    locale: row.locale === "en" ? "en" : "zh-CN",
    projectSubdir: row.project_subdir,
    task: row.task,
    baseCommit: row.base_commit,
    baseBranch: row.base_branch,
    setupCommand: row.setup_command,
    status: row.status,
    adoptedEntryId: row.adopted_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntry(row: EntryRow): TrialEntryRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    path: row.path,
    branch: row.branch,
    status: row.status,
    setupLog: row.setup_log,
    error: row.error,
    branchCreated: row.branch_created === 1,
    worktreeCreated: row.worktree_created === 1,
    branchRemoved: row.branch_removed === 1,
    branchError: row.branch_error,
    adoptMode: row.adopt_mode,
    adoptResult: row.adopt_result_json === null ? null : parseJson(row.adopt_result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
