import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 仓库里没配用户名 / 邮箱时 SuDuo 提交用的身份（与检查点一致）。 */
const FALLBACK_IDENTITY = ["-c", "user.name=SuDuo", "-c", "user.email=suduo@localhost"];
/** 准备命令最多跑多久、留多少输出。 */
const SETUP_TIMEOUT_MS = 15 * 60_000;
/** 超时后先 SIGTERM，过这么久还没结束就 SIGKILL。 */
const SETUP_KILL_GRACE_MS = 5_000;
const SETUP_LOG_LIMIT = 20_000;

export interface RepoState {
  /** 仓库根（`git rev-parse --show-toplevel`）。 */
  gitRoot: string;
  head: string;
  /** 当前分支；分离头指针为 null。 */
  branch: string | null;
  /** 有没有未提交的改动（试做版本基于最近一次提交，不含它们）。 */
  dirty: boolean;
}

export interface ChangedFile {
  path: string;
  kind: "add" | "delete" | "update";
  /** 二进制文件为 null。 */
  additions: number | null;
  deletions: number | null;
}

export type MergeResult = { ok: true; commit: string } | { ok: false; conflicts: string[]; message: string };

/**
 * 并行试做的工作目录（多 Agent 协作 S10，技术设计 2.12）：在 SuDuo 数据目录下为每一版建 git worktree 与分支，
 * 跑准备命令，看改动，采用时提交、合并或保留分支，确认后删除（R11）。所有 git 操作都在本机，不推送。
 */
export class WorktreeManager {
  constructor(
    private readonly options: {
      /** 跑 git：测试可以替换；默认调用本机 git。env 是额外的环境变量。 */
      git?: (cwd: string, args: readonly string[], env?: Record<string, string>) => Promise<string>;
      /** 跑准备命令的 shell（默认 $SHELL 或 /bin/sh，Windows 为 cmd.exe）。 */
      shell?: string;
      /** 准备命令超时与超时后强制结束前的宽限（默认 15 分钟、5 秒；测试用）。 */
      setupTimeoutMs?: number;
      setupKillGraceMs?: number;
    } = {},
  ) {}

  /** 目录是不是 git 仓库、当前提交与分支、有没有未提交的改动；不是仓库（或没装 git）返回 null。 */
  async inspect(root: string): Promise<RepoState | null> {
    let gitRoot: string;
    try {
      gitRoot = (await this.git(root, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
      return null;
    }
    const head = (await this.git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
    if (head === "") return null;
    const branch = (await this.git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || null;
    const status = await this.git(root, ["status", "--porcelain"]).catch(() => "");
    return { gitRoot, head, branch, dirty: status.trim() !== "" };
  }

  /**
   * 找一个还没被占用的分支名：`<prefix>`、`<prefix>-2`、`<prefix>-3`……；`taken` 是已经分给别的版本、
   * 还没建出来的名字。真建的时候 `worktree add -b` 遇到同名分支会失败，不会动别人的分支。
   */
  async freeBranch(root: string, prefix: string, taken: ReadonlySet<string> = new Set()): Promise<string> {
    for (let index = 1; index < 100; index += 1) {
      const name = index === 1 ? prefix : `${prefix}-${String(index)}`;
      if (taken.has(name)) continue;
      const exists = await this.git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).then(
        () => true,
        () => false,
      );
      if (!exists) return name;
    }
    return `${prefix}-${String(Date.now())}`;
  }

  /** 建分支：`git branch --no-track <branch> <base>`（同名分支已存在会失败，不动它）。 */
  async createBranch(root: string, branch: string, base: string): Promise<void> {
    await this.git(root, ["branch", "--no-track", branch, base]);
  }

  /** 在已建好的分支上建工作目录：`git worktree add <path> <branch>`。 */
  async addWorktree(root: string, path: string, branch: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await this.git(root, ["worktree", "add", path, branch]);
  }

  /** 建分支与工作目录（两步，分支建成与工作目录建成分开记，见 createBranch / addWorktree）。 */
  async add(root: string, input: { path: string; branch: string; base: string }): Promise<void> {
    await this.createBranch(root, input.branch, input.base);
    await this.addWorktree(root, input.path, input.branch);
  }

  /**
   * 在工作目录里跑准备命令（如 pnpm install）；超时或非零退出算失败，返回输出末尾。超时连同它起的子进程一起结束
   * （POSIX 上自成进程组，Windows 用 taskkill /T）。
   */
  setup(path: string, command: string): Promise<{ ok: boolean; log: string }> {
    const timeoutMs = this.options.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
    return new Promise((resolve) => {
      const windows = process.platform === "win32";
      const shell = this.options.shell ?? (windows ? "cmd.exe" : process.env["SHELL"] || "/bin/sh");
      const child = spawn(shell, windows ? ["/d", "/s", "/c", command] : ["-lc", command], { cwd: path, env: process.env, windowsHide: true, detached: !windows });
      let log = "";
      let settled = false;
      let timedOut = false;
      let hard: NodeJS.Timeout | undefined;
      const finish = (result: { ok: boolean; log: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 进程自己结束了就不再补 SIGKILL（进程组号可能被复用）。
        if (hard !== undefined) clearTimeout(hard);
        resolve(timedOut ? { ...result, ok: false } : result);
      };
      const append = (chunk: Buffer) => {
        log = (log + chunk.toString("utf8")).slice(-SETUP_LOG_LIMIT);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      // 超时：先请它结束（SIGTERM），宽限后强制结束（SIGKILL），不等输出管道关闭（后台子进程可能一直占着它）。
      const timer = setTimeout(() => {
        timedOut = true;
        append(Buffer.from(`\n[timeout after ${formatDuration(timeoutMs)}]\n`));
        killTree(child.pid, windows, "SIGTERM", () => child.kill());
        hard = setTimeout(() => {
          killTree(child.pid, windows, "SIGKILL", () => child.kill("SIGKILL"));
          finish({ ok: false, log: log.trim() });
        }, this.options.setupKillGraceMs ?? SETUP_KILL_GRACE_MS);
        hard.unref();
      }, timeoutMs);
      timer.unref();
      child.on("error", (error) => finish({ ok: false, log: (log + "\n" + error.message).trim() }));
      child.on("close", (code) => finish({ ok: code === 0, log: log.trim() }));
    });
  }

  /**
   * 这一版相对基点改了什么（含未提交、未跟踪的文件，不依赖 Agent 自己提交）：在索引的临时副本里把新文件标成
   * 「打算添加」，再比较工作区与基点。不碰这一版自己的索引（Agent 正在用它暂存、stash）。路径用 `-z` 原样取（中文文件名不转义）。
   */
  async changes(path: string, base: string): Promise<ChangedFile[]> {
    if (!existsSync(path)) return [];
    const index = resolve(path, (await this.git(path, ["rev-parse", "--git-path", "index"])).trim());
    const scratch = await mkdtemp(join(tmpdir(), "suduo-trial-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      // 还没有索引（刚建、没暂存过）就从空的开始：git 按基点与工作区补齐。
      await copyFile(index, env.GIT_INDEX_FILE).catch(() => undefined);
      await this.git(path, ["add", "--all", "--intent-to-add"], env).catch(() => "");
      const numstat = await this.git(path, ["diff", "-z", "--numstat", "--no-renames", base], env);
      const status = await this.git(path, ["diff", "-z", "--name-status", "--no-renames", base], env);
      const kinds = new Map<string, ChangedFile["kind"]>();
      const statusParts = status.split("\0");
      for (let index = 0; index + 1 < statusParts.length; index += 2) {
        const code = statusParts[index]!;
        const file = statusParts[index + 1]!;
        if (code === "") break;
        kinds.set(file, code.startsWith("A") ? "add" : code.startsWith("D") ? "delete" : "update");
      }
      const files: ChangedFile[] = [];
      for (const record of numstat.split("\0")) {
        const [added, deleted, ...rest] = record.split("\t");
        if (added === undefined || deleted === undefined || rest.length === 0) continue;
        const file = rest.join("\t");
        files.push({
          path: file,
          kind: kinds.get(file) ?? "update",
          additions: added === "-" ? null : Number(added),
          deletions: deleted === "-" ? null : Number(deleted),
        });
      }
      return files;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** 在工作目录里提交这一版的全部改动（采用前）；没有改动返回 null。 */
  async commit(path: string, message: string): Promise<string | null> {
    await this.git(path, ["add", "--all"]);
    const changed = await this.git(path, ["diff", "--cached", "--quiet"]).then(
      () => false,
      () => true,
    );
    if (!changed) return null;
    try {
      await this.git(path, ["commit", "--no-verify", "-m", message]);
    } catch {
      // 仓库没配身份：用 SuDuo 的身份提交。
      await this.git(path, [...FALLBACK_IDENTITY, "commit", "--no-verify", "-m", message]);
    }
    return (await this.git(path, ["rev-parse", "HEAD"])).trim();
  }

  /**
   * 合并到原工作目录当前分支：`git merge --no-ff`。有冲突时停在冲突状态（由人处理），返回冲突文件；
   * git 自己拒绝（比如原目录有会被覆盖的未提交改动）时返回它的说明。
   */
  async merge(root: string, branch: string, message: string): Promise<MergeResult> {
    const args = ["merge", "--no-ff", "-m", message, branch];
    try {
      await this.git(root, args).catch(async (error: unknown) => {
        if (/user\.(name|email)|identity|Please tell me who you are/iu.test(errorText(error))) {
          return this.git(root, [...FALLBACK_IDENTITY, ...args]);
        }
        throw error;
      });
      return { ok: true, commit: (await this.git(root, ["rev-parse", "HEAD"])).trim() };
    } catch (error) {
      const conflicts = (await this.git(root, ["diff", "-z", "--name-only", "--diff-filter=U"]).catch(() => ""))
        .split("\0")
        .filter((line) => line !== "");
      return { ok: false, conflicts, message: errorText(error).trim() };
    }
  }

  /** 删工作目录（`git worktree remove --force`，须用户确认，R11）；目录已经不在也清掉 git 的记录。 */
  async removeWorktree(root: string, path: string): Promise<void> {
    if (existsSync(path)) await this.git(root, ["worktree", "remove", "--force", path]);
    await this.git(root, ["worktree", "prune"]).catch(() => "");
  }

  /** 分支合没合并进原工作目录当前的 HEAD（`merge-base --is-ancestor`，与 `git branch -d` 的判断一致）；分支已经不在为 null。 */
  async isMerged(root: string, branch: string): Promise<boolean | null> {
    const ref = `refs/heads/${branch}`;
    const exists = await this.git(root, ["rev-parse", "--verify", "--quiet", ref]).then(
      () => true,
      () => false,
    );
    if (!exists) return null;
    return this.git(root, ["merge-base", "--is-ancestor", ref, "HEAD"]).then(
      () => true,
      () => false,
    );
  }

  /** 删分支：force = `git branch -D`（没合并的提交会丢，须用户确认，R11）；否则 `-d`（git 认为没合并就不删，返回它的说明）。 */
  async deleteBranch(root: string, branch: string, force: boolean): Promise<void> {
    await this.git(root, ["branch", force ? "-D" : "-d", branch]);
  }

  private git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
    if (this.options.git) return this.options.git(cwd, args, env);
    return execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    }).then((result) => result.stdout);
  }
}

/** 结束准备命令连同它起的子进程（POSIX 上给整个进程组发信号；Windows 用 taskkill /T /F）。 */
function killTree(pid: number | undefined, windows: boolean, signal: "SIGTERM" | "SIGKILL", fallback: () => void): void {
  if (pid === undefined) {
    fallback();
    return;
  }
  try {
    if (windows) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", fallback);
    else process.kill(-pid, signal);
  } catch {
    fallback();
  }
}

function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${String(Math.round(ms / 60_000))} minutes` : `${String(Math.round(ms / 1000))} seconds`;
}

function errorText(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const record = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const parts = [record.stderr, record.stdout].filter((part): part is string => typeof part === "string" && part.trim() !== "");
    if (parts.length > 0) return parts.join("\n");
    if (typeof record.message === "string") return record.message;
  }
  return String(error);
}
