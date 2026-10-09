import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDto, TrialDto } from "@suduo/client-contracts";
import type { ProjectedRound } from "../src/application/context/session-projection.js";
import { isTestCommand, TrialService } from "../src/application/collab/trial-service.js";
import { WorktreeManager } from "../src/application/collab/worktree-manager.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { TrialRepository } from "../src/infrastructure/db/repositories/trial-repository.js";

/** 并行试做（多 Agent 协作 S10，需求 4.5）：真实 git 仓库里建各版、准备、开会话、比较、采用、确认后清理。 */

const paths: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function round(patch: Partial<ProjectedRound> = {}): ProjectedRound {
  return { index: 1, seq: 1, startedAt: 1, userText: "", attachmentCount: 0, status: "completed", error: null, answer: null, commands: [], tools: [], files: [], webSearches: [], ...patch } as ProjectedRound;
}

function setup(options: { gitRepo?: boolean; subdir?: string; worktrees?: WorktreeManager } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "suduo-trial-repo-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "suduo-trial-worktrees-"));
  paths.push(repoRoot, worktreeRoot);
  // 项目可以是仓库里的子目录（monorepo 的一个包）。
  const root = options.subdir === undefined ? repoRoot : join(repoRoot, options.subdir);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (options.gitRepo !== false) {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Tester");
    git("config", "user.email", "tester@example.com");
    writeFileSync(join(root, "app.js"), "module.exports = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  }
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  closers.push(() => database.close());
  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const project = projects.create({ name: "p", rootPath: root, rootPathKey: root });
  const created: Array<{ agentId: string; workspacePath: string; title: string; role: string }> = [];
  const sent: Array<{ sessionId: string; text: string; source?: string }> = [];
  const rounds = new Map<string, ProjectedRound[]>();
  const activity = new Map<string, "queued" | "running" | "idle">();
  const archived: string[] = [];
  const flags = { projectGone: false, failSend: false };
  const trials = new TrialRepository(database);
  const service = new TrialService({
    trials,
    worktrees: options.worktrees ?? new WorktreeManager({ shell: "/bin/sh" }),
    worktreeRoot,
    localProject: (projectId) => (flags.projectGone ? null : projects.getById(projectId)),
    resolveTarget: async (target) => ({
      localProject: project,
      remoteProjectId: "proj-1",
      requirement: "remoteRequirementId" in target ? { id: target.remoteRequirementId, number: 7, title: "订单导出" } : null,
    }),
    createSession: async ({ agentId, workspacePath, title, role }) => {
      created.push({ agentId, workspacePath, title, role });
      const session = sessions.create({ projectId: project.id, title, state: "active", agentId, graph: { parentSessionId: null, rootSessionId: null, relation: "trial" }, workspacePath });
      return { id: session.id } as SessionDto;
    },
    messages: {
      send: async (sessionId, input, _key, sendOptions) => {
        if (flags.failSend) throw new Error("scheduler down");
        sent.push({ sessionId, text: input.content[0]!.text, ...(sendOptions.source === undefined ? {} : { source: sendOptions.source }) });
        return {};
      },
    },
    rounds: (sessionId) => rounds.get(sessionId) ?? [],
    sessionActivity: (sessionId) => activity.get(sessionId) ?? "idle",
    turnSpan: () => ({ startedAt: 1_000, endedAt: 61_000 }),
    pendingApprovals: () => 0,
    sessionsInWorkspace: (path) => sessions.listActiveIdsByWorkspacePath(path),
    archiveSession: async (sessionId) => {
      archived.push(sessionId);
    },
    agentProblem: (agentId) => (agentId === "cursor" ? (t) => t.delegation.reply.agentDisabled("Cursor") : null),
    agentName: (agentId) => ({ codex: "Codex", "claude-code": "Claude Code" })[agentId] ?? agentId,
    log: () => undefined,
  });
  const settle = async (id: string, predicate: (trial: TrialDto) => boolean) => {
    await vi.waitFor(async () => expect(predicate(await service.get(id))).toBe(true), { timeout: 15_000, interval: 50 });
    return service.get(id);
  };
  return { root, repoRoot, git, worktreeRoot, project, sessions, trials, service, created, sent, rounds, activity, archived, flags, settle };
}

describe("并行试做", () => {
  it("发起：每版一个 worktree 与分支 suduo/REQ-7-<agent>，跑准备命令，开试做会话（在 worktree 里）并发任务（来源试做）；准备命令按项目记住", async () => {
    const context = setup();
    const precheck = await context.service.precheck({ remoteRequirementId: "req-7" });
    expect(precheck).toMatchObject({ isGitRepo: true, dirty: false, branch: "main", setupCommand: null });
    const started = await context.service.start(
      { target: { remoteRequirementId: "req-7" }, agents: [{ agentId: "codex" }, { agentId: "claude-code", approvalMode: "auto" }], task: "给导出加分页", setupCommand: "echo installed > .setup-done" },
      "zh-CN",
    );
    expect(started.entries.map((entry) => entry.branch)).toEqual(["suduo/REQ-7-codex", "suduo/REQ-7-claude-code"]);
    const ready = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
    for (const entry of ready.entries) {
      expect(existsSync(join(entry.path, "app.js"))).toBe(true);
      expect(readFileSync(join(entry.path, ".setup-done"), "utf8")).toBe("installed\n");
    }
    // 各版并行准备，先后不定：按 Agent 对上。
    const byAgent = (items: Array<[string, string]>) => [...items].sort((left, right) => left[0].localeCompare(right[0]));
    expect(byAgent(context.created.map((item) => [item.agentId, item.workspacePath]))).toEqual(byAgent(ready.entries.map((entry) => [entry.agentId, entry.path])));
    expect(context.created.find((item) => item.agentId === "codex")!.role).toContain("同一个任务也交给了 Claude Code");
    expect(context.sent.map((item) => [item.text, item.source])).toEqual([
      ["给导出加分页", "trial"],
      ["给导出加分页", "trial"],
    ]);
    expect((await context.service.precheck({ remoteRequirementId: "req-7" })).setupCommand).toBe("echo installed > .setup-done");
    // 准备命令记在本机库里，不写进仓库（别的会话改仓库里的文件换不掉它）。
    expect(existsSync(join(context.root, ".suduo", "trial.json"))).toBe(false);
  });

  it("项目是仓库里的子目录：试做会话与准备命令在 worktree 的同一子目录里", async () => {
    const context = setup({ subdir: "packages/web" });
    const started = await context.service.start(
      { target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "x", setupCommand: "pwd > .where" },
      "zh-CN",
    );
    const ready = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
    for (const entry of ready.entries) {
      const workDir = join(entry.path, "packages", "web");
      expect(existsSync(join(workDir, "app.js"))).toBe(true);
      expect(readFileSync(join(workDir, ".where"), "utf8").trim()).toMatch(/packages\/web$/u);
      expect(context.created.find((item) => item.agentId === entry.agentId)!.workspacePath).toBe(workDir);
    }
  });

  it("分支名避开已有的分支；同时发起两次也不撞名", async () => {
    const context = setup();
    context.git("branch", "suduo/REQ-7-codex");
    const target = { remoteRequirementId: "req-7" };
    const agents = [{ agentId: "codex" }, { agentId: "claude-code" }];
    const [one, two] = await Promise.all([context.service.start({ target, agents, task: "a" }, "zh-CN"), context.service.start({ target, agents, task: "b" }, "zh-CN")]);
    const branches = [...one.entries, ...two.entries].map((entry) => entry.branch);
    expect(new Set(branches).size).toBe(4);
    expect(branches).not.toContain("suduo/REQ-7-codex");
    await context.settle(one.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
    await context.settle(two.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
  });

  it("准备途中出错不会卡在准备中：本机项目找不到记为失败；任务没发出去说明怎么补发", async () => {
    const gone = setup();
    gone.flags.projectGone = true;
    const failed = await gone.service.start({ target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "x" }, "zh-CN");
    const settled = await gone.settle(failed.id, (trial) => trial.entries.every((entry) => entry.state === "failed"));
    expect(settled.entries[0]!.error).toContain("找不到发起试做的本机项目");
    const context = setup();
    context.flags.failSend = true;
    const started = await context.service.start({ target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "x" }, "en");
    const done = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.error !== null));
    expect(done.entries[0]).toMatchObject({ state: "failed" });
    expect(done.entries[0]!.error).toContain("Open this version's session to send it again");
    // 用户在会话里补发后，状态随回合走。
    context.rounds.set(done.entries[0]!.sessionId!, [round({ answer: "done" })]);
    expect((await context.service.get(started.id)).entries[0]!.state).toBe("completed");
  });

  it("不是 git 仓库、Agent 数不对、任务为空、Agent 不能用都报错；准备命令失败的那一版标准备失败，别的照常", async () => {
    const plain = setup({ gitRepo: false });
    await expect(plain.service.start({ target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "x" }, "zh-CN")).rejects.toMatchObject({ statusCode: 400 });
    const context = setup();
    await expect(context.service.start({ target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }], task: "x" }, "zh-CN")).rejects.toMatchObject({ statusCode: 400 });
    await expect(context.service.start({ target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: " " }, "zh-CN")).rejects.toMatchObject({ statusCode: 400 });
    await expect(context.service.start({ target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "cursor" }], task: "x" }, "zh-CN")).rejects.toMatchObject({ statusCode: 400 });
    const started = await context.service.start(
      { target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "codex" }], task: "x", setupCommand: "test -f never-there && echo ok || (echo missing >&2; exit 1)" },
      "zh-CN",
    );
    // 同一家试两版：分支与目录加后缀；项目会话的分支用试做组编号。
    expect(started.entries[1]!.branch).toMatch(/^suduo\/trial-[0-9a-f]{8}-codex-2$/u);
    const done = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.state === "setup_failed"));
    expect(done.entries[0]).toMatchObject({ state: "setup_failed", setupLog: "missing", sessionId: null });
  });

  it("比较：最终回答、相对基点的改动（含新文件）、测试命令与退出码、耗时；状态按会话的排队 / 运行 / 结果", async () => {
    const context = setup();
    const started = await context.service.start({ target: { remoteProjectId: "p" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "加分页" }, "zh-CN");
    const ready = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
    const [first, second] = ready.entries;
    writeFileSync(join(first!.path, "app.js"), "module.exports = 2;\nexports.page = true;\n");
    writeFileSync(join(first!.path, "page.test.js"), "test\n");
    writeFileSync(join(first!.path, "说明.md"), "中文\n");
    context.rounds.set(first!.sessionId!, [round({ answer: "加好了分页", commands: [{ command: "pnpm test", exitCode: 0, output: "" }, { command: "ls", exitCode: 0, output: "" }] })]);
    context.activity.set(second!.sessionId!, "running");
    const compared = await context.service.get(started.id);
    expect(compared.entries[0]).toMatchObject({
      state: "completed",
      finalMessage: "加好了分页",
      additions: 4,
      deletions: 1,
      tests: [{ command: "pnpm test", exitCode: 0 }],
      durationMs: 60_000,
    });
    expect(compared.entries[0]!.changedFiles.map((file) => [file.path, file.kind]).sort()).toEqual([
      ["app.js", "update"],
      ["page.test.js", "add"],
      ["说明.md", "add"],
    ]);
    expect(compared.entries[1]!.state).toBe("running");
    // 看改动不改这一版自己的索引（Agent 的 git stash / 暂存不受影响）：新文件仍是未跟踪。
    const status = execFileSync("git", ["-c", "core.quotePath=false", "status", "--porcelain"], { cwd: first!.path, encoding: "utf8" });
    expect(status).toContain("?? page.test.js");
    expect(status).toContain("?? 说明.md");
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: first!.path, encoding: "utf8" }).trim()).toBe("");
  });

  it("采用：在这一版的分支上提交后合并回原分支；冲突时停在冲突状态并列出文件；保留分支只记下分支", async () => {
    const context = setup();
    const started = await context.service.start({ target: { remoteRequirementId: "req-7" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "改常量" }, "zh-CN");
    const ready = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
    const [first, second] = ready.entries;
    writeFileSync(join(first!.path, "app.js"), "module.exports = 'codex';\n");
    writeFileSync(join(second!.path, "app.js"), "module.exports = 'claude';\n");
    expect(await context.service.repoState(started.id)).toEqual({ isGitRepo: true, branch: "main", dirty: false });
    const merged = await context.service.adopt(started.id, first!.id, "merge", "zh-CN");
    expect(merged).toMatchObject({ status: "adopted", adoptedEntryId: first!.id, adoptMode: "merge", adoptResult: { kind: "merged" } });
    expect(readFileSync(join(context.root, "app.js"), "utf8")).toBe("module.exports = 'codex';\n");
    expect(context.git("log", "-1", "--format=%s").trim()).toContain("合并 SuDuo 试做（REQ-7 · Codex）");
    const conflict = await context.service.adopt(started.id, second!.id, "merge", "zh-CN");
    expect(conflict.adoptResult).toMatchObject({ kind: "conflict", files: ["app.js"] });
    context.git("merge", "--abort");
    const kept = await context.service.adopt(started.id, second!.id, "keep-branch", "zh-CN");
    expect(kept.adoptResult).toEqual({ kind: "kept", branch: "suduo/REQ-7-claude-code" });
    // 各版自己记着采用方式与结果：后采用的不覆盖先采用的。
    expect(kept.entries.map((entry) => [entry.adoptMode, entry.adoptResult?.kind])).toEqual([
      ["merge", "merged"],
      ["keep-branch", "kept"],
    ]);
  });

  it("确认后清理：先保留 A 的分支、再合并 B，A 的分支照样留着、B 的分支按已合并删；在这一版目录里的会话一并归档；全删了试做结束", async () => {
    const context = setup();
    const started = await context.service.start(
      { target: { remoteRequirementId: "req-7" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }, { agentId: "opencode" }], task: "改常量" },
      "zh-CN",
    );
    const ready = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
    const [first, second, third] = ready.entries;
    writeFileSync(join(first!.path, "app.js"), "module.exports = 'kept';\n");
    writeFileSync(join(second!.path, "merged.js"), "merged\n");
    writeFileSync(join(third!.path, "extra.js"), "unmerged\n");
    // 第三版的 Agent 自己提交了：分支上有没合并的提交。
    execFileSync("git", ["add", "extra.js"], { cwd: third!.path });
    execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "agent commit"], { cwd: third!.path });
    // 从第二版开的评审会话也在它的目录里。
    const reviewer = context.sessions.create({ projectId: context.project.id, title: "r", state: "active", agentId: "codex", workspacePath: second!.path });
    await context.service.adopt(started.id, first!.id, "keep-branch", "zh-CN");
    const adopted = await context.service.adopt(started.id, second!.id, "merge", "zh-CN");
    // 清理计划（确认对话框照它列）：保留分支 / 已合并 -d / 没合并 -D。
    expect(adopted.entries.map((entry) => entry.cleanup)).toEqual([
      { worktree: true, branch: "keep", gitSaid: null },
      { worktree: true, branch: "delete-merged", gitSaid: null },
      { worktree: true, branch: "delete-unmerged", gitSaid: null },
    ]);
    // 还在跑的那一版不动；从第二版开的评审还在跑时，第二版也先不动（比较页据 busy 不让勾）。
    context.activity.set(third!.sessionId!, "running");
    context.activity.set(reviewer.id, "running");
    expect((await context.service.get(started.id)).entries.map((entry) => entry.busy)).toEqual([false, true, true]);
    const blocked = await context.service.cleanup(started.id, [second!.id], "zh-CN");
    expect(blocked.entries[1]!.state).not.toBe("removed");
    expect(blocked.entries[1]!.error).toContain("还在被用");
    expect(existsSync(second!.path)).toBe(true);
    context.activity.set(reviewer.id, "idle");
    const partial = await context.service.cleanup(started.id, [first!.id, second!.id, third!.id], "zh-CN", [third!.id]);
    expect(partial.status).toBe("adopted");
    expect(partial.entries.map((entry) => [entry.state, entry.branchRemoved])).toEqual([
      ["removed", false],
      ["removed", true],
      ["running", false],
    ]);
    expect(partial.entries[2]!.error).toContain("还在被用");
    expect(existsSync(third!.path)).toBe(true);
    context.activity.set(third!.sessionId!, "idle");
    // 有没合并的提交：确认里没写明会丢（没在 forceBranches 里）就不强删，工作目录照删。
    const unconfirmed = await context.service.cleanup(started.id, [third!.id], "zh-CN");
    expect(unconfirmed.entries[2]).toMatchObject({ state: "removed", branchRemoved: false, cleanup: { worktree: false, branch: "delete-unmerged", gitSaid: null } });
    expect(unconfirmed.entries[2]!.error).toContain("没有确认强制删除");
    const cleaned = await context.service.cleanup(started.id, [third!.id], "zh-CN", [third!.id]);
    expect(cleaned.status).toBe("closed");
    expect(cleaned.entries.map((entry) => entry.cleanup)).toEqual([null, null, null]);
    expect([first, second, third].some((entry) => existsSync(entry!.path))).toBe(false);
    expect(context.git("branch", "--list", "suduo/*").trim()).toBe("suduo/REQ-7-codex");
    expect(context.archived.sort()).toEqual([first!.sessionId, second!.sessionId, reviewer.id, third!.sessionId].sort());
    // 空了的试做组目录一并删掉。
    expect(existsSync(join(context.worktreeRoot, context.project.id))).toBe(false);
  });

  it("分支名被别人抢先建了：这一版没建成，清理不碰那个分支；分支建了、检出失败：清理照样删这一版的分支", async () => {
    class Flaky extends WorktreeManager {
      raced = new Set<string>();
      failCheckout = new Set<string>();
      override async createBranch(root: string, branch: string, base: string) {
        // 分配名字之后、建分支之前，别人建了同名分支。
        if (this.raced.has(branch)) execFileSync("git", ["branch", branch, base], { cwd: root });
        return super.createBranch(root, branch, base);
      }
      override async addWorktree(root: string, path: string, branch: string) {
        if (this.failCheckout.has(branch)) throw new Error("checkout failed");
        return super.addWorktree(root, path, branch);
      }
    }
    const worktrees = new Flaky({ shell: "/bin/sh" });
    worktrees.raced.add("suduo/REQ-7-codex");
    worktrees.failCheckout.add("suduo/REQ-7-claude-code");
    const context = setup({ worktrees });
    const started = await context.service.start({ target: { remoteRequirementId: "req-7" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "x" }, "zh-CN");
    const ready = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.state === "failed"));
    expect(ready.entries.map((entry) => entry.cleanup)).toEqual([
      { worktree: false, branch: "none", gitSaid: null },
      { worktree: false, branch: "delete-merged", gitSaid: null },
    ]);
    const cleaned = await context.service.cleanup(started.id, ready.entries.map((entry) => entry.id), "zh-CN");
    expect(cleaned.status).toBe("closed");
    expect(context.git("branch", "--list", "suduo/*").trim()).toBe("suduo/REQ-7-codex");
  });

  it("git 拒绝 -d（分支设了 upstream、还没合进去）：工作目录照删，分支留着并记下 git 的原话；再清理时按没合并、确认过才 -D", async () => {
    const context = setup();
    const started = await context.service.start({ target: { remoteRequirementId: "req-7" }, agents: [{ agentId: "codex" }, { agentId: "claude-code" }], task: "x" }, "zh-CN");
    const ready = await context.settle(started.id, (trial) => trial.entries.every((entry) => entry.sessionId !== null));
    const [codex, claude] = ready.entries;
    writeFileSync(join(codex!.path, "app.js"), "module.exports = 'codex';\n");
    await context.service.adopt(started.id, codex!.id, "merge", "zh-CN");
    // 比如 Agent 执行过 push -u：分支的 upstream 停在基点，git branch -d 按 upstream 判断「没合并」。
    context.git("branch", "upstream-base", started.baseCommit);
    context.git("config", `branch.${codex!.branch}.remote`, ".");
    context.git("config", `branch.${codex!.branch}.merge`, "refs/heads/upstream-base");
    const first = await context.service.cleanup(started.id, [codex!.id, claude!.id], "zh-CN");
    expect(first.entries[0]).toMatchObject({ state: "removed", branchRemoved: false });
    expect(first.entries[0]!.error).toContain(`分支 ${codex!.branch} 没删，git 说：`);
    expect(first.entries[0]!.cleanup).toMatchObject({ worktree: false, branch: "delete-unmerged" });
    expect(first.entries[0]!.cleanup!.gitSaid).toMatch(/not fully merged/u);
    expect(first.entries[0]!.cleanup!.gitSaid).not.toContain("hint:");
    expect(first.entries[1]).toMatchObject({ state: "removed", branchRemoved: true });
    expect(first.status).not.toBe("closed");
    // 没确认强删：不动分支。
    const again = await context.service.cleanup(started.id, [codex!.id], "zh-CN");
    expect(again.entries[0]!.branchRemoved).toBe(false);
    const forced = await context.service.cleanup(started.id, [codex!.id], "zh-CN", [codex!.id]);
    expect(forced.entries[0]).toMatchObject({ branchRemoved: true, cleanup: null });
    expect(forced.status).toBe("closed");
    expect(context.git("branch", "--list", "suduo/*").trim()).toBe("");
  });

  it("重启时还在准备的版本按发起时的语言记为失败；工作目录已建出来的记下", async () => {
    const context = setup();
    const group = context.trials.createGroup({
      projectId: context.project.id,
      remoteRequirementId: null,
      requirementLabel: null,
      remoteProjectId: "p",
      label: null,
      locale: "en",
      projectSubdir: "",
      task: "x",
      baseCommit: "abc",
      baseBranch: "main",
      setupCommand: null,
    });
    const missing = context.trials.createEntry({ groupId: group.id, agentId: "codex", path: join(context.worktreeRoot, "nope"), branch: "suduo/x" });
    const made = context.trials.createEntry({ groupId: group.id, agentId: "codex", path: context.worktreeRoot, branch: "suduo/y" });
    context.service.recoverAfterRestart();
    expect(context.trials.getEntry(missing.id)).toMatchObject({ status: "failed", error: "The local service restarted before it was ready", worktreeCreated: false });
    expect(context.trials.getEntry(made.id)).toMatchObject({ status: "failed", branchCreated: true, worktreeCreated: true });
  });

  it("测试命令按运行器的写法认，命令里出现 test 字样的文件名不算", () => {
    for (const command of ["pnpm test", "npm run test:unit", "/bin/zsh -lc 'node --test s10-sum.test.js'", "npx vitest run", "go test ./...", "cargo test", "python -m pytest -q", "make check"]) {
      expect(isTestCommand(command)).toBe(true);
    }
    for (const command of ["/bin/zsh -lc \"rg --files -g 's10-sum.test.js'\"", "cat a.test.js", "ls tests", "git status"]) {
      expect(isTestCommand(command)).toBe(false);
    }
  });
});

