import { existsSync } from "node:fs";
import { realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Locale,
  SessionDto,
  StartTrialRequest,
  TrialAdoptResultDto,
  TrialCleanupPlanDto,
  TrialDto,
  TrialEntryDto,
  TrialEntryState,
  TrialPrecheckDto,
  TrialRepoStateDto,
  TrialTarget,
} from "@suduo/client-contracts";
import { messagesFor } from "../../i18n/messages/index.js";
import type { ProjectRecord } from "../../infrastructure/db/repositories/project-repository.js";
import type { TrialEntryRecord, TrialGroupRecord, TrialRepository } from "../../infrastructure/db/repositories/trial-repository.js";
import { ApiError, type ErrorText } from "../api-error.js";
import type { ProjectedRound } from "../context/session-projection.js";
import type { SchedulerSource } from "../scheduler/turn-scheduler.js";
import { oneLine } from "./delegation-service.js";
import type { AiActivityEvent } from "./ai-activity-reporter.js";
import type { ChangedFile, WorktreeManager } from "./worktree-manager.js";

const MIN_AGENTS = 2;
const MAX_AGENTS = 3;
/**
 * 测试类命令（比较视图里列出它们的退出码）：按测试运行器的写法认，不按命令里出现 test 字样认
 * （`rg --files -g 'a.test.js'` 不算）。
 */
const TEST_COMMAND =
  /(?:^|[\s;&|'"(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\b|:)|node\s+--test\b|(?:npx\s+|pnpm\s+exec\s+)?(?:vitest|jest|mocha|ava|pytest|phpunit|rspec|ctest|tox|nox)\b|go\s+test\b|cargo\s+test\b|python3?\s+-m\s+(?:pytest|unittest)\b|make\s+(?:test|check)\b|deno\s+test\b|dotnet\s+test\b|mvn\s+(?:-\S+\s+)*test\b|gradle\w*\s+test\b)/iu;

type AgentStart = Pick<StartTrialRequest["agents"][number], "approvalMode" | "model" | "reasoningEffort">;

/**
 * 并行试做（多 Agent 协作 S10，技术设计 2.12、需求 4.5）：同一任务交给两三家 Agent，各在 SuDuo 数据目录下的
 * git worktree 与分支里做一版（基于发起时原工作目录的 HEAD），并排比较后采用一版（合并到原分支或保留分支），
 * 其余确认后删除工作目录与分支（R11，界面先列出路径与分支）。git 操作都在本机，不推送。
 */
export interface TrialDependencies {
  trials: TrialRepository;
  worktrees: WorktreeManager;
  /** worktree 放在哪：`<SuDuo 数据目录>/worktrees`。 */
  worktreeRoot: string;
  /** 远程需求 / 项目对应的本机项目（需求的编号与标题）：只在发起与发起前用；之后按试做组记下的本机项目操作。 */
  resolveTarget(target: TrialTarget): Promise<{
    localProject: ProjectRecord;
    remoteProjectId: string;
    requirement: { id: string; number: number | null; title: string } | null;
  }>;
  /** 本机项目（采用、清理、准备都在发起时的那个本机项目里做，不随目录关联改变）。 */
  localProject(projectId: string): ProjectRecord | null;
  /** 开这一版的试做会话：同一需求 / 项目，在 worktree 里干活，relation = trial，带试做角色说明、不挂委派与评审工具。 */
  createSession(input: {
    target: TrialTarget;
    agentId: string;
    start: AgentStart;
    locale: Locale;
    workspacePath: string;
    title: string;
    role: string;
  }): Promise<SessionDto>;
  messages: {
    send(
      sessionId: string,
      input: { content: Array<{ type: "text"; text: string }> },
      idempotencyKey: string,
      options: { locale?: Locale; source?: SchedulerSource; label?: string },
    ): Promise<unknown>;
  };
  rounds(sessionId: string): ProjectedRound[];
  /** 会话在本机队列里排着 / 有回合在跑 / 空着。 */
  sessionActivity(sessionId: string): "queued" | "running" | "idle";
  /** 会话里等用户确认的操作数（比较视图提示去哪一版确认）。 */
  pendingApprovals(sessionId: string): number;
  /** 会话第一个回合开始到最后一个回合结束（还没开始为 null）。 */
  turnSpan(sessionId: string): { startedAt: number; endedAt: number | null } | null;
  /** 在这个目录里干活的会话（试做会话，以及从它开的评审、接着做）：工作目录删了一并归档。 */
  sessionsInWorkspace(path: string): string[];
  /** 工作目录删了的会话归档（再发消息也没有目录可用）。 */
  archiveSession(sessionId: string): Promise<void>;
  agentProblem(agentId: string): ErrorText | null;
  agentName(agentId: string): string;
  /** 协作记录上报（S11，P2-D1）：需求上的试做开始、采用。 */
  activity?: (event: AiActivityEvent) => void;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

/** 导出给测试。 */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

export class TrialService {
  /** 同一本机项目的发起排队分配分支名（并发发起不撞名）。 */
  private readonly allocating = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: TrialDependencies) {}

  /**
   * 本机服务启动时：还在准备的版本（建目录、跑准备命令、开会话途中被打断）记为失败。工作目录已经建出来的记下，
   * 清理时照常删它和它的分支。
   */
  recoverAfterRestart(): void {
    for (const entry of this.deps.trials.listPreparing()) {
      const group = this.deps.trials.getGroup(entry.groupId);
      const locale = group?.locale ?? "zh-CN";
      this.deps.trials.updateEntry(
        entry.id,
        // git 先建分支再建目录，路径每组唯一：目录在就说明分支与目录都是这一版建的。
        { status: "failed", error: messagesFor(locale).trial.restartInterrupted, ...(existsSync(entry.path) ? { branchCreated: true, worktreeCreated: true } : {}) },
        this.now(),
      );
      if (group !== null) this.report(group, entry, "failed");
    }
  }

  /** 发起前 / 采用前看一眼：是不是 git 仓库、当前分支、有没有未提交的改动、这个项目上次用的准备命令。 */
  async precheck(target: TrialTarget): Promise<TrialPrecheckDto> {
    const { localProject } = await this.deps.resolveTarget(target);
    const state = await this.deps.worktrees.inspect(localProject.rootPath);
    return {
      isGitRepo: state !== null,
      dirty: state?.dirty ?? false,
      head: state?.head ?? null,
      branch: state?.branch ?? null,
      setupCommand: this.deps.trials.lastSetupCommand(localProject.id),
      localProjectId: localProject.id,
    };
  }

  /** 发起：建试做组与各版的记录，立即返回；建工作目录、跑准备命令、开会话在后台进行（比较视图轮询看进度）。 */
  async start(input: StartTrialRequest, locale: Locale): Promise<TrialDto> {
    const t = messagesFor(locale).trial;
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (task === "") throw new ApiError(400, "VALIDATION_ERROR", (m) => m.trial.taskMissing);
    const agents = Array.isArray(input.agents) ? input.agents : [];
    if (agents.length < MIN_AGENTS || agents.length > MAX_AGENTS) throw new ApiError(400, "VALIDATION_ERROR", (m) => m.trial.agentCount(MIN_AGENTS, MAX_AGENTS));
    for (const agent of agents) {
      if (typeof agent?.agentId !== "string" || agent.agentId.trim() === "") throw new ApiError(400, "VALIDATION_ERROR", (m) => m.trial.agentIdMissing);
      const problem = this.deps.agentProblem(agent.agentId);
      if (problem !== null) throw new ApiError(400, "AGENT_NOT_READY", problem, { agentId: agent.agentId });
    }
    const resolved = await this.deps.resolveTarget(input.target);
    const project = resolved.localProject;
    const repo = await this.deps.worktrees.inspect(project.rootPath);
    if (repo === null) throw new ApiError(400, "VALIDATION_ERROR", (m) => m.trial.notGitRepo);
    // 准备命令记在本机库里（按项目取上次的）：不放仓库，免得别的会话改了仓库里的文件就换掉要跑的命令。
    const setupCommand =
      typeof input.setupCommand === "string" ? (input.setupCommand.trim() === "" ? null : input.setupCommand.trim()) : this.deps.trials.lastSetupCommand(project.id);
    const label = resolved.requirement === null || resolved.requirement.number === null ? null : `REQ-${String(resolved.requirement.number)}`;
    const requirementLabel = resolved.requirement === null ? null : [label, resolved.requirement.title].filter((part) => part !== null && part !== "").join(" ");
    const projectSubdir = await subdirOf(repo.gitRoot, project.rootPath);
    const { group, entries } = await this.serial(project.id, async () => {
      const group = this.deps.trials.createGroup({
        projectId: project.id,
        remoteRequirementId: resolved.requirement?.id ?? null,
        requirementLabel,
        remoteProjectId: resolved.remoteProjectId,
        label,
        locale,
        projectSubdir,
        task,
        baseCommit: repo.head,
        baseBranch: repo.branch,
        setupCommand,
        now: this.now(),
      });
      // 分支名避开：git 里已有的、别的试做还在准备（分支还没建出来）的、这一组里已经分出去的。
      const taken = new Set(this.deps.trials.listBranchesInUse(project.id));
      const entries: TrialEntryRecord[] = [];
      const used = new Map<string, number>();
      for (const agent of agents) {
        const count = (used.get(agent.agentId) ?? 0) + 1;
        used.set(agent.agentId, count);
        const slug = count === 1 ? agent.agentId : `${agent.agentId}-${String(count)}`;
        const branch = await this.deps.worktrees.freeBranch(project.rootPath, `suduo/${label ?? `trial-${group.id.slice(0, 8)}`}-${slug}`, taken);
        taken.add(branch);
        const path = resolve(this.deps.worktreeRoot, project.id, group.id, slug);
        entries.push(this.deps.trials.createEntry({ groupId: group.id, agentId: agent.agentId, path, branch, now: this.now() }));
      }
      return { group, entries };
    });
    for (const entry of entries) {
      this.report(group, entry, "started");
    }
    // 各版独立准备：一版失败不挡别的。
    const names = agents.map((agent) => this.deps.agentName(agent.agentId));
    for (const [index, entry] of entries.entries()) {
      const agent = agents[index]!;
      const start: AgentStart = {
        ...(agent.approvalMode === undefined ? {} : { approvalMode: agent.approvalMode }),
        ...(agent.model === undefined ? {} : { model: agent.model }),
        ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }),
      };
      const others = names.filter((_name, other) => other !== index);
      void this.prepare(group, entry, {
        target: input.target,
        start,
        role: t.role(others),
        title: t.title(this.deps.agentName(agent.agentId), oneLine(task, 40)),
      });
    }
    return this.get(group.id);
  }

  /** 试做组与各版的比较信息（最终回答、改动文件与增删、测试命令与退出码、耗时、清理会做什么）。 */
  async get(id: string): Promise<TrialDto> {
    const group = this.requireGroup(id);
    const root = this.deps.localProject(group.projectId)?.rootPath ?? null;
    const entries = await Promise.all(this.deps.trials.listEntries(id).map((entry) => this.entryDto(group, entry, root)));
    const adopted = entries.find((entry) => entry.id === group.adoptedEntryId) ?? null;
    return {
      id: group.id,
      projectId: group.projectId,
      remoteProjectId: group.remoteProjectId,
      remoteRequirementId: group.remoteRequirementId,
      requirementLabel: group.requirementLabel,
      task: group.task,
      baseCommit: group.baseCommit,
      baseBranch: group.baseBranch,
      setupCommand: group.setupCommand,
      status: group.status,
      adoptedEntryId: group.adoptedEntryId,
      adoptMode: adopted?.adoptMode ?? null,
      adoptResult: adopted?.adoptResult ?? null,
      entries,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  /** 试做所在的原工作目录现在的状态（采用对话框：合并到哪个分支、有没有未提交的改动）；按组记下的本机项目查，不经云端。 */
  async repoState(id: string): Promise<TrialRepoStateDto> {
    const state = await this.deps.worktrees.inspect(this.requireRoot(this.requireGroup(id)));
    return { isGitRepo: state !== null, branch: state?.branch ?? null, dirty: state?.dirty ?? false };
  }

  /** 试做会话属于哪个试做（会话页的「试做比较」入口）。 */
  bySession(sessionId: string): string | null {
    return this.deps.trials.getEntryBySession(sessionId)?.groupId ?? null;
  }

  /**
   * 采用一版：先由 SuDuo 在这一版的 worktree 提交（不依赖 Agent 自己提交），再合并到原工作目录当前分支
   * （`git merge --no-ff`；有冲突时停在冲突状态，由人处理）或只保留分支（稍后提 PR）。采用方式与结果记在这一版上。
   */
  async adopt(id: string, entryId: string, mode: "merge" | "keep-branch", locale: Locale): Promise<TrialDto> {
    const t = messagesFor(locale).trial;
    const group = this.requireGroup(id);
    const entry = this.requireEntry(group, entryId);
    if (!entry.worktreeCreated || entry.status === "removed") throw new ApiError(400, "VALIDATION_ERROR", (m) => m.trial.noWorktree);
    const root = this.requireRoot(group);
    const agent = this.deps.agentName(entry.agentId);
    try {
      await this.deps.worktrees.commit(entry.path, t.commitMessage(group.label, agent, group.task));
    } catch (error) {
      // git 提交失败（不是一致性拒绝）：如实告知。
      throw new ApiError(500, "RUNTIME_REQUEST_FAILED", (m) => m.trial.adoptCommitFailed(errorMessage(error)));
    }
    let result: TrialAdoptResultDto;
    if (mode === "keep-branch") {
      result = { kind: "kept", branch: entry.branch };
    } else {
      const merged = await this.deps.worktrees.merge(root, entry.branch, t.mergeMessage(group.label, agent, entry.branch));
      result = merged.ok
        ? { kind: "merged", commit: merged.commit }
        : merged.conflicts.length > 0
          ? { kind: "conflict", files: merged.conflicts, message: merged.message }
          : { kind: "refused", message: merged.message };
    }
    this.deps.trials.updateEntry(entry.id, { adoptMode: mode, adoptResult: result as never }, this.now());
    // 冲突、git 拒绝不算采用成了（横幅照样说明结果）。
    const done = result.kind === "merged" || result.kind === "kept";
    this.deps.trials.updateGroup(id, { status: group.status === "closed" ? "closed" : done ? "adopted" : group.status, adoptedEntryId: entry.id }, this.now());
    if (done) {
      this.report(group, entry, "adopted");
    }
    return this.get(id);
  }

  /**
   * 清理这几版（界面先照各版的清理计划列出路径与分支请用户确认，R11）：删工作目录；分支按计划删——
   * 提交都已在当前分支里的用 `-d`；有没合并的提交的只在用户确认过（`forceBranches`）时用 `-D`；采用为保留分支的不删；
   * 不是这一版建的不碰（同名分支可能是别人的）。`-d` 被 git 拒绝时留着分支、记下 git 的原话，下次按没合并请用户确认。
   * 目录还在被用的版本不动。删了工作目录的会话（含从它开的评审、接着做）归档。一版删不掉不挡别的。
   */
  async cleanup(id: string, entryIds: readonly string[], locale: Locale, forceBranches: readonly string[] = []): Promise<TrialDto> {
    const t = messagesFor(locale).trial;
    const group = this.requireGroup(id);
    const root = this.requireRoot(group);
    const confirmedForce = new Set(forceBranches);
    for (const entryId of entryIds) {
      const entry = this.requireEntry(group, entryId);
      // 目录还在被用的不动（红线 1：会删掉 Agent 正在写的文件）。
      if (this.busy(group, entry)) {
        this.deps.trials.updateEntry(entry.id, { error: t.cleanupBusy }, this.now());
        continue;
      }
      const plan = await this.cleanupPlan(root, entry);
      if (plan === null) continue;
      if (plan.worktree) {
        try {
          await this.deps.worktrees.removeWorktree(root, entry.path);
        } catch (error) {
          this.deps.trials.updateEntry(entry.id, { error: t.cleanupFailed(errorMessage(error)) }, this.now());
          continue;
        }
      }
      this.deps.trials.updateEntry(entry.id, { status: "removed", error: null }, this.now());
      // 采用成了的版本（合并了或保留了分支）记录停在「已采用」；其余的记为「已清理」。
      const adopted = (entry.adoptResult as TrialAdoptResultDto | null)?.kind;
      if (adopted !== "merged" && adopted !== "kept") this.report(group, entry, "discarded");
      // 工作目录删了，在里面干活的会话没有目录可用了：归档（只删分支的那次不再重复）。
      if (plan.worktree) await this.archiveSessions(group, entry);
      if (plan.branch === "delete-unmerged" && !confirmedForce.has(entry.id)) {
        // 确认时没写明「没合并的提交会丢」（之后分支状态变了）：不强删，请用户再确认。
        this.deps.trials.updateEntry(entry.id, { error: t.branchNeedsConfirm(entry.branch) }, this.now());
      } else if (plan.branch === "delete-merged" || plan.branch === "delete-unmerged") {
        try {
          await this.deps.worktrees.deleteBranch(root, entry.branch, plan.branch === "delete-unmerged");
          this.deps.trials.updateEntry(entry.id, { branchRemoved: true, branchError: null }, this.now());
        } catch (error) {
          if ((await this.deps.worktrees.isMerged(root, entry.branch).catch(() => false)) === null) {
            // 已经不在了（比如另一个页面同时清理过）。
            this.deps.trials.updateEntry(entry.id, { branchRemoved: true, branchError: null }, this.now());
          } else {
            const said = errorMessage(error);
            this.deps.trials.updateEntry(entry.id, { branchError: said, error: t.branchNotRemoved(entry.branch, said) }, this.now());
          }
        }
      }
    }
    const remaining = await Promise.all(this.deps.trials.listEntries(id).map((entry) => this.cleanupPlan(root, entry)));
    if (remaining.every((plan) => plan === null)) {
      this.deps.trials.updateGroup(id, { status: "closed" }, this.now());
      // 空了的 `<worktrees>/<本机项目>/<试做组>` 与 `<worktrees>/<本机项目>` 一并删掉（不空的留着）。
      const groupDir = resolve(this.deps.worktreeRoot, group.projectId, group.id);
      await rmdir(groupDir).catch(() => undefined);
      await rmdir(dirname(groupDir)).catch(() => undefined);
    }
    return this.get(id);
  }

  /** 建工作目录 → 跑准备命令 → 开会话 → 发任务（经本机调度，来源「试做」）。任何一步出错都记在这一版上，不会卡在「准备中」。 */
  private async prepare(group: TrialGroupRecord, entry: TrialEntryRecord, input: { target: TrialTarget; start: AgentStart; role: string; title: string }): Promise<void> {
    const t = messagesFor(group.locale).trial;
    try {
      const root = this.deps.localProject(group.projectId)?.rootPath;
      if (root === undefined) {
        this.fail(group, entry, "failed", t.projectMissing);
        return;
      }
      // 分支与工作目录分两步建、分开记：检出失败（磁盘满、LFS 出错）时分支已在，清理照样删它；同名分支已存在时
      // 第一步就失败，不会把别人的分支记成这一版的。
      try {
        await this.deps.worktrees.createBranch(root, entry.branch, group.baseCommit);
        this.deps.trials.updateEntry(entry.id, { branchCreated: true }, this.now());
        await this.deps.worktrees.addWorktree(root, entry.path, entry.branch);
      } catch (error) {
        this.fail(group, entry, "failed", t.worktreeFailed(errorMessage(error)));
        return;
      }
      this.deps.trials.updateEntry(entry.id, { worktreeCreated: true }, this.now());
      // 项目是仓库里的子目录时，这一版也在 worktree 的同一子目录里干活。
      const workDir = join(entry.path, group.projectSubdir);
      if (group.setupCommand !== null) {
        const setup = await this.deps.worktrees.setup(workDir, group.setupCommand);
        this.deps.trials.updateEntry(entry.id, { setupLog: setup.log === "" ? null : setup.log }, this.now());
        if (!setup.ok) {
          this.fail(group, entry, "setup_failed", t.setupFailed);
          return;
        }
      }
      let session: SessionDto;
      try {
        session = await this.deps.createSession({
          target: input.target,
          agentId: entry.agentId,
          start: input.start,
          locale: group.locale,
          workspacePath: workDir,
          title: input.title,
          role: input.role,
        });
      } catch (error) {
        this.fail(group, entry, "failed", t.sessionFailed(errorMessage(error)));
        return;
      }
      this.deps.trials.updateEntry(entry.id, { sessionId: session.id, status: "started" }, this.now());
      await this.deps.messages
        .send(session.id, { content: [{ type: "text", text: group.task }] }, `trial:${entry.id}:start`, { locale: group.locale, source: "trial", label: oneLine(group.task, 80) })
        .catch((error: unknown) => {
          // 会话开好了、任务没发出：记为失败并说明怎么补发（用户在这一版的会话里再发一次，状态随回合走）。
          this.fail(group, entry, "failed", t.sendFailed(errorMessage(error)));
        });
    } catch (error) {
      this.log({ event: "suduo.trial.prepare_failed", entryId: entry.id, message: String(error) });
      if (this.deps.trials.getEntry(entry.id)?.status === "preparing") {
        this.fail(group, entry, "failed", t.prepareFailed(errorMessage(error)));
      }
    }
  }

  /** 这一版失败：记在这一版上，并报一条协作记录。 */
  private fail(group: TrialGroupRecord, entry: TrialEntryRecord, status: "failed" | "setup_failed", error: string): void {
    this.deps.trials.updateEntry(entry.id, { status, error }, this.now());
    this.report(group, entry, "failed");
  }

  /** 协作记录（S11，P2-D1）：有会话了就按会话的开关（会话开出来之前的「开始」没有会话可关）。 */
  private report(group: TrialGroupRecord, entry: TrialEntryRecord, status: string): void {
    const sessionId = this.deps.trials.getEntry(entry.id)?.sessionId ?? entry.sessionId;
    this.deps.activity?.({ sessionId, requirementId: group.remoteRequirementId, localRef: entry.id, kind: "trial", status, agentId: entry.agentId, branch: entry.branch });
  }

  private async entryDto(group: TrialGroupRecord, entry: TrialEntryRecord, root: string | null): Promise<TrialEntryDto> {
    const rounds = entry.sessionId === null ? [] : this.deps.rounds(entry.sessionId);
    const lastAnswer = [...rounds].reverse().find((round) => round.answer !== null)?.answer ?? null;
    let files: ChangedFile[] = [];
    if (entry.worktreeCreated && entry.status !== "removed") {
      files = await this.deps.worktrees.changes(entry.path, group.baseCommit).catch(() => []);
    }
    const span = entry.sessionId === null ? null : this.deps.turnSpan(entry.sessionId);
    return {
      id: entry.id,
      agentId: entry.agentId,
      agentName: this.deps.agentName(entry.agentId),
      sessionId: entry.sessionId,
      path: entry.path,
      branch: entry.branch,
      state: this.stateOf(entry, rounds),
      setupLog: entry.setupLog,
      error: entry.error,
      finalMessage: lastAnswer,
      changedFiles: files,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      tests: rounds.flatMap((round) => round.commands.filter((command) => isTestCommand(command.command)).map((command) => ({ command: command.command, exitCode: command.exitCode }))),
      durationMs: span === null ? null : (entry.sessionId !== null && this.deps.sessionActivity(entry.sessionId) !== "idle" ? this.now() : (span.endedAt ?? this.now())) - span.startedAt,
      branchRemoved: entry.branchRemoved,
      pendingApprovals: entry.sessionId === null || entry.status === "removed" ? 0 : this.deps.pendingApprovals(entry.sessionId),
      busy: this.busy(group, entry),
      adoptMode: entry.adoptMode,
      adoptResult: entry.adoptResult as TrialAdoptResultDto | null,
      cleanup: root === null ? null : await this.cleanupPlan(root, entry),
    };
  }

  /**
   * 清理这一版会做什么：只删 SuDuo 自己建出来的东西。分支合没合并按 git 现在的状态看（`merge-base --is-ancestor`），
   * 不按采用时记的结果（冲突解决后提交了也算合并）；上次 `-d` 被拒的按没合并，带上 git 的原话。没有可清理的为 null。
   */
  private async cleanupPlan(root: string, entry: TrialEntryRecord): Promise<TrialCleanupPlanDto | null> {
    const worktree = entry.worktreeCreated && entry.status !== "removed";
    let branch: TrialCleanupPlanDto["branch"] = "none";
    let gitSaid: string | null = null;
    if (entry.branchCreated && !entry.branchRemoved) {
      const merged = await this.deps.worktrees.isMerged(root, entry.branch).catch(() => false);
      if (merged === null) branch = "none";
      else if (entry.adoptMode === "keep-branch") branch = "keep";
      else if (entry.branchError !== null) {
        branch = "delete-unmerged";
        gitSaid = entry.branchError;
      } else branch = merged ? "delete-merged" : "delete-unmerged";
    }
    if (worktree) return { worktree, branch, gitSaid };
    if (branch === "delete-merged" || branch === "delete-unmerged") return { worktree: false, branch, gitSaid };
    // 没有工作目录、也没有分支要删：没清理过的只从列表里清掉，清理过的就没有可做的了。
    return entry.status === "removed" ? null : { worktree: false, branch: "none", gitSaid: null };
  }

  /** 这一版的目录还在被用：还在准备，或目录里有会话（这一版的会话，以及从它开的评审、接着做）在排队 / 运行。 */
  private busy(group: TrialGroupRecord, entry: TrialEntryRecord): boolean {
    if (entry.status === "preparing") return true;
    if (entry.status === "removed") return false;
    return this.sessionsUsing(group, entry).some((sessionId) => this.deps.sessionActivity(sessionId) !== "idle");
  }

  private async archiveSessions(group: TrialGroupRecord, entry: TrialEntryRecord): Promise<void> {
    for (const sessionId of this.sessionsUsing(group, entry)) await this.deps.archiveSession(sessionId).catch(() => undefined);
  }

  /** 在这一版目录里干活的会话：这一版的试做会话，以及从它开的评审、接着做。 */
  private sessionsUsing(group: TrialGroupRecord, entry: TrialEntryRecord): string[] {
    const ids = new Set(this.deps.sessionsInWorkspace(join(entry.path, group.projectSubdir)));
    if (entry.sessionId !== null) ids.add(entry.sessionId);
    return [...ids];
  }

  private stateOf(entry: TrialEntryRecord, rounds: readonly ProjectedRound[]): TrialEntryState {
    if (entry.status === "preparing" || entry.status === "setup_failed" || entry.status === "removed") return entry.status;
    if (entry.sessionId === null) return "failed";
    const activity = this.deps.sessionActivity(entry.sessionId);
    if (activity !== "idle") return activity;
    const last = rounds.at(-1);
    // 还没有回合：任务没发出去的是失败（会话开好了，用户补发后按回合走），否则在等调度。
    if (last === undefined) return entry.status === "failed" ? "failed" : "queued";
    return last.status === "completed" ? "completed" : last.status === "failed" ? "turn_failed" : last.status === "interrupted" ? "interrupted" : "running";
  }

  private requireGroup(id: string): TrialGroupRecord {
    const group = this.deps.trials.getGroup(id);
    if (group === null) throw new ApiError(404, "NOT_FOUND", (t) => t.trial.notFound);
    return group;
  }

  private requireEntry(group: TrialGroupRecord, entryId: string): TrialEntryRecord {
    const entry = this.deps.trials.getEntry(entryId);
    if (entry === null || entry.groupId !== group.id) throw new ApiError(404, "NOT_FOUND", (t) => t.trial.entryNotFound);
    return entry;
  }

  private requireRoot(group: TrialGroupRecord): string {
    const project = this.deps.localProject(group.projectId);
    if (project === null) throw new ApiError(404, "NOT_FOUND", (t) => t.trial.projectMissing);
    return project.rootPath;
  }

  /** 同一本机项目的分支分配一个接一个来（排队，不拒绝）。 */
  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.allocating.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.allocating.set(key, next);
    try {
      return await next;
    } finally {
      if (this.allocating.get(key) === next) this.allocating.delete(key);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.error(JSON.stringify(value))))(line);
  }
}

/** 项目目录在仓库里的相对位置（仓库根为空串）；按真实路径算（macOS 的 /var 与 /private/var）。 */
async function subdirOf(gitRoot: string, projectRoot: string): Promise<string> {
  const [repo, project] = await Promise.all([realpath(gitRoot).catch(() => gitRoot), realpath(projectRoot).catch(() => projectRoot)]);
  const path = relative(repo, project);
  return path === "" || path.startsWith("..") || isAbsolute(path) ? "" : path;
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const stderr = (error as { stderr?: unknown }).stderr;
    // 只留 git 的说明，去掉 `hint:` 提示行（比如「要删就 git branch -D」——这一步由确认对话框给出）。
    const lines = typeof stderr === "string" ? stderr.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("hint:")) : [];
    if (lines.length > 0) return lines.slice(-3).join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}
