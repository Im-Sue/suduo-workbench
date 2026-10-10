import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/application/collab/worktree-manager.js";

/** 并行试做的工作目录（多 Agent 协作 S10）：真实 git 仓库里建 worktree、看改动、提交、合并、冲突、删除。 */

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "suduo-worktree-"));
  paths.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Tester");
  git("config", "user.email", "tester@example.com");
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "gone.txt"), "bye\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const worktrees = mkdtempSync(join(tmpdir(), "suduo-worktrees-"));
  paths.push(worktrees);
  return { root, git, worktrees };
}

describe("WorktreeManager", () => {
  it("看仓库状态：不是仓库为 null；当前提交、分支、有没有未提交改动", async () => {
    const manager = new WorktreeManager();
    const plain = mkdtempSync(join(tmpdir(), "suduo-not-repo-"));
    paths.push(plain);
    expect(await manager.inspect(plain)).toBeNull();
    const { root, git } = repo();
    const state = await manager.inspect(root);
    expect(state).toMatchObject({ branch: "main", dirty: false, head: git("rev-parse", "HEAD").trim() });
    writeFileSync(join(root, "a.txt"), "changed\n");
    expect((await manager.inspect(root))?.dirty).toBe(true);
  });

  it("建 worktree 与分支（名字被占用就加后缀）；改动含新文件、删除与修改；提交后合并回原分支", async () => {
    const manager = new WorktreeManager();
    const { root, git, worktrees } = repo();
    const base = git("rev-parse", "HEAD").trim();
    const branch = await manager.freeBranch(root, "suduo/REQ-1-codex");
    expect(branch).toBe("suduo/REQ-1-codex");
    const path = join(worktrees, "codex");
    await manager.add(root, { path, branch, base });
    expect(await manager.freeBranch(root, "suduo/REQ-1-codex")).toBe("suduo/REQ-1-codex-2");
    expect(await manager.freeBranch(root, "suduo/REQ-1-codex", new Set(["suduo/REQ-1-codex-2"]))).toBe("suduo/REQ-1-codex-3");
    writeFileSync(join(path, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(path, "new.txt"), "x\ny\n");
    rmSync(join(path, "gone.txt"));
    const changes = await manager.changes(path, base);
    expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "a.txt", kind: "update", additions: 2, deletions: 1 },
      { path: "gone.txt", kind: "delete", additions: 0, deletions: 1 },
      { path: "new.txt", kind: "add", additions: 2, deletions: 0 },
    ]);
    const commit = await manager.commit(path, "SuDuo 试做：REQ-1 · Codex");
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await manager.commit(path, "again")).toBeNull();
    const merged = await manager.merge(root, branch, "合并试做");
    expect(merged.ok).toBe(true);
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("x\ny\n");
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    // 已合并：删工作目录，分支用 -d 删。
    expect(await manager.isMerged(root, branch)).toBe(true);
    await manager.removeWorktree(root, path);
    expect(existsSync(path)).toBe(false);
    await manager.deleteBranch(root, branch, false);
    expect(git("branch", "--list", branch).trim()).toBe("");
    expect(await manager.isMerged(root, branch)).toBeNull();
  });

  it("合并有冲突：停在冲突状态、返回冲突文件；保留分支时只删工作目录；没合并的用 -D 删", async () => {
    const manager = new WorktreeManager();
    const { root, git, worktrees } = repo();
    const base = git("rev-parse", "HEAD").trim();
    const path = join(worktrees, "claude");
    await manager.add(root, { path, branch: "suduo/t-claude", base });
    writeFileSync(join(path, "a.txt"), "theirs\n");
    await manager.commit(path, "trial");
    writeFileSync(join(root, "a.txt"), "ours\n");
    git("commit", "-q", "-am", "main moved");
    const result = await manager.merge(root, "suduo/t-claude", "合并");
    expect(result).toMatchObject({ ok: false, conflicts: ["a.txt"] });
    git("merge", "--abort");
    await manager.removeWorktree(root, path);
    expect(existsSync(path)).toBe(false);
    expect(git("branch", "--list", "suduo/t-claude").trim()).toContain("suduo/t-claude");

    const other = join(worktrees, "opencode");
    await manager.add(root, { path: other, branch: "suduo/t-opencode", base });
    writeFileSync(join(other, "b.txt"), "unmerged\n");
    await manager.commit(other, "trial");
    expect(await manager.isMerged(root, "suduo/t-opencode")).toBe(false);
    await manager.removeWorktree(root, other);
    // 没合并的：-d 被 git 拒绝，-D 才删。
    await expect(manager.deleteBranch(root, "suduo/t-opencode", false)).rejects.toThrow();
    await manager.deleteBranch(root, "suduo/t-opencode", true);
    expect(git("branch", "--list", "suduo/t-opencode").trim()).toBe("");
  });

  it("准备命令：成功、失败都带输出", async () => {
    const manager = new WorktreeManager({ shell: "/bin/sh" });
    const { root } = repo();
    expect(await manager.setup(root, "echo ready")).toEqual({ ok: true, log: "ready" });
    const failed = await manager.setup(root, "echo broken >&2; exit 3");
    expect(failed).toEqual({ ok: false, log: "broken" });
  });

  it("准备命令超时：先 SIGTERM，不理会就 SIGKILL，连同它起的子进程；不等后台进程占着的输出管道", async () => {
    const manager = new WorktreeManager({ shell: "/bin/sh", setupTimeoutMs: 200, setupKillGraceMs: 300 });
    const { root } = repo();
    const started = Date.now();
    const stubborn = await manager.setup(root, "trap '' TERM; echo begin; sleep 30");
    expect(stubborn.ok).toBe(false);
    expect(stubborn.log).toContain("begin");
    expect(stubborn.log).toContain("[timeout after");
    // 后台进程占着输出、shell 自己先正常退出：超时后照样结束并算失败。
    const background = await manager.setup(root, "echo begin; sleep 30 &");
    expect(background.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("看改动不动 worktree 自己的索引：暂存的照旧、新文件仍未跟踪，Agent 的 git stash 正常", async () => {
    const manager = new WorktreeManager();
    const { root, git, worktrees } = repo();
    const base = git("rev-parse", "HEAD").trim();
    const path = join(worktrees, "codex");
    await manager.add(root, { path, branch: "suduo/t-codex", base });
    const inTree = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
    writeFileSync(join(path, "a.txt"), "staged\n");
    inTree("add", "a.txt");
    writeFileSync(join(path, "新文件.txt"), "x\n");
    const before = inTree("-c", "core.quotePath=false", "status", "--porcelain");
    const changes = await manager.changes(path, base);
    expect(changes.map((file) => file.path).sort()).toEqual(["a.txt", "新文件.txt"]);
    expect(inTree("-c", "core.quotePath=false", "status", "--porcelain")).toBe(before);
    expect(before).toContain("?? 新文件.txt");
    inTree("stash", "--include-untracked");
    expect(inTree("status", "--porcelain").trim()).toBe("");
  });
});
