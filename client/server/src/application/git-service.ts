import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { GitCheckpointDto, GitStatusDto } from "@suduo/client-contracts";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import { ensureSuDuoDir } from "../infrastructure/workspace/suduo-dir.js";
import { ApiError } from "./api-error.js";

const execFileAsync = promisify(execFile);

const AUTO_SUBJECT = "SuDuo 自动存档：回合开始前";
const MANUAL_PREFIX = "SuDuo 检查点：";
const FALLBACK_IDENTITY = [
  "-c",
  "user.name=SuDuo",
  "-c",
  "user.email=suduo@localhost",
];
const GITIGNORE_SEED = [
  "node_modules/",
  ".suduo/",
  "dist/",
  ".build/",
  ".cache/",
  "*.log",
  "",
].join("\n");

interface GitProjectSettings {
  managed: boolean;
  autoCheckpoint: boolean;
}

/**
 * 项目版本管理（git）v1：状态 / 一键初始化 / 检查点 / 还原。
 * 智能默认：SuDuo 初始化的仓库自动存档默认开；用户已有仓库默认关（防污染提交历史）。
 * 机器无 git 时所有操作降级为 available=false，由前端隐藏功能。
 */
export class GitService {
  private gitAvailable: boolean | null = null;
  private readonly lastErrors = new Map<string, string>();

  constructor(
    private readonly projects: ProjectRepository,
    /** 一键初始化时「回合前自动存档」的默认值（接运行时设置）。 */
    private readonly autoCheckpointDefault: () => boolean = () => true,
  ) {}

  async status(projectId: string): Promise<GitStatusDto> {
    const project = this.requireProject(projectId);
    const root = project.rootPath;
    const settings = await this.readSettings(root);
    const base: GitStatusDto = {
      available: await this.available(),
      repo: false,
      branch: null,
      dirty: 0,
      managed: settings.managed,
      autoCheckpoint: settings.autoCheckpoint,
      hasRemote: false,
      lastError: this.lastErrors.get(projectId) ?? null,
    };
    if (!base.available) {
      return base;
    }
    // 两次调用拿全所有状态：①顶层校验 ②porcelain --branch 一次带回分支/上游/脏数。
    const top = await this.run(root, ["rev-parse", "--show-toplevel"]).catch(
      () => "",
    );
    if (top.trim() === "" || !samePath(top.trim(), root)) {
      return base;
    }
    base.repo = true;
    const porcelain = await this.run(root, [
      "status",
      "--porcelain=v1",
      "--branch",
    ]).catch(() => null);
    if (porcelain !== null) {
      const lines = porcelain
        .split("\n")
        .filter((line) => line.trim() !== "");
      const headerLine = lines[0];
      const header =
        headerLine !== undefined && headerLine.startsWith("## ")
          ? headerLine.slice(3)
          : null;
      base.dirty = lines.filter((line) => !line.startsWith("## ")).length;
      const parsed = parseStatusHeader(header);
      base.branch = parsed.branch;
      base.hasRemote = parsed.hasUpstream;
    }
    return base;
  }

  /** 一键初始化版本管理：git init + 种子 .gitignore + 首次提交；自动存档默认开。 */
  async init(projectId: string): Promise<GitStatusDto> {
    const project = this.requireProject(projectId);
    const root = project.rootPath;
    if (!(await this.available())) {
      throw new ApiError(400, "VALIDATION_ERROR", "本机未检测到 git，无法初始化版本管理");
    }
    if (await this.isRepoRoot(root)) {
      throw new ApiError(409, "VERSION_CONFLICT", "该项目已是 git 仓库");
    }
    await this.run(root, ["init"]);
    const ignorePath = resolve(root, ".gitignore");
    if (!existsSync(ignorePath)) {
      await writeFile(ignorePath, GITIGNORE_SEED, "utf8");
    }
    await this.run(root, ["add", "-A"]);
    await this.commit(root, "SuDuo 初始化版本管理");
    await this.writeSettings(root, {
      managed: true,
      autoCheckpoint: this.autoCheckpointDefault(),
    });
    return this.status(projectId);
  }

  /** 手动检查点；工作区无改动时返回 null。 */
  async checkpoint(
    projectId: string,
    message: string | undefined,
  ): Promise<GitCheckpointDto | null> {
    const project = this.requireProject(projectId);
    return this.snapshot(project.rootPath, false, message);
  }

  /** 回合前自动存档：任何失败都不阻塞发消息，只记录 lastError。 */
  async autoCheckpoint(projectId: string, projectRoot: string): Promise<void> {
    try {
      const settings = await this.readSettings(projectRoot);
      if (!settings.autoCheckpoint) {
        return;
      }
      if (!(await this.available()) || !(await this.isRepoRoot(projectRoot))) {
        return;
      }
      await this.snapshot(projectRoot, true, undefined);
      this.lastErrors.delete(projectId);
    } catch (cause) {
      this.lastErrors.set(
        projectId,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  async listCheckpoints(projectId: string): Promise<GitCheckpointDto[]> {
    const project = this.requireProject(projectId);
    const root = project.rootPath;
    if (!(await this.available())) {
      return [];
    }
    // 非仓库时 log 直接失败并被 catch，无须额外探测调用。
    const raw = await this.run(root, [
      "log",
      "-n",
      "30",
      "--pretty=%H%x1f%s%x1f%ct",
    ]).catch(() => "");
    return raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [hash = "", subject = "", epoch = "0"] = line.split("\x1f");
        return {
          hash,
          subject,
          ts: Number(epoch) * 1000,
          auto: subject.startsWith(AUTO_SUBJECT),
        };
      })
      .filter((item) => item.hash !== "");
  }

  /**
   * 还原到指定提交（git reset --hard）。
   * 未纳入版本管理的新文件不会被删除；后续提交仍可从 reflog 找回。
   */
  async restore(projectId: string, hash: string): Promise<GitStatusDto> {
    const project = this.requireProject(projectId);
    const root = project.rootPath;
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
      throw new ApiError(400, "VALIDATION_ERROR", "提交号格式无效");
    }
    if (!(await this.available()) || !(await this.isRepoRoot(root))) {
      throw new ApiError(400, "VALIDATION_ERROR", "该项目不是 git 仓库");
    }
    // 还原做成"前进式"：先把当前状态存成检查点，再把工作区内容改写成目标检查点
    // 并提交为新的一步。历史只往前走，所以还原本身也能再被还原（可反悔）。
    // 反例（旧实现）：reset --hard 会把 HEAD 移到过去，刚存的救命检查点脱离分支历史，
    // 检查点列表里再也看不到，用户实际无从反悔。
    await this.snapshot(root, false, "还原前自动存档");
    await this.run(root, ["read-tree", "-u", "--reset", hash]);
    const pending = await this.run(root, ["status", "--porcelain"]);
    if (pending.trim() !== "") {
      await this.commit(root, MANUAL_PREFIX + "还原到 " + hash.slice(0, 7));
    }
    return this.status(projectId);
  }

  async updateSettings(
    projectId: string,
    input: { autoCheckpoint: boolean },
  ): Promise<GitStatusDto> {
    const project = this.requireProject(projectId);
    const settings = await this.readSettings(project.rootPath);
    await this.writeSettings(project.rootPath, {
      ...settings,
      autoCheckpoint: input.autoCheckpoint,
    });
    return this.status(projectId);
  }

  private async snapshot(
    root: string,
    auto: boolean,
    message: string | undefined,
  ): Promise<GitCheckpointDto | null> {
    if (!(await this.available()) || !(await this.isRepoRoot(root))) {
      throw new ApiError(400, "VALIDATION_ERROR", "该项目不是 git 仓库");
    }
    await this.run(root, ["add", "-A"]);
    const pending = await this.run(root, ["status", "--porcelain"]);
    if (pending.trim() === "") {
      return null;
    }
    const subject = auto
      ? AUTO_SUBJECT
      : MANUAL_PREFIX + (message?.trim() ? message.trim() : timeLabel());
    await this.commit(root, subject);
    const hash = (await this.run(root, ["rev-parse", "HEAD"])).trim();
    return { hash, subject, ts: Date.now(), auto };
  }

  private async commit(root: string, subject: string): Promise<void> {
    try {
      await this.run(root, ["commit", "-m", subject]);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      // 新机器常无 git 身份配置：用工具身份兜底，不写入用户全局配置。
      if (/user\.(name|email)|Please tell me who you are|empty ident/i.test(text)) {
        await this.run(root, [...FALLBACK_IDENTITY, "commit", "-m", subject]);
        return;
      }
      throw cause;
    }
  }

  private async available(): Promise<boolean> {
    if (this.gitAvailable === null) {
      this.gitAvailable = await execFileAsync("git", ["--version"], {
        windowsHide: true,
      })
        .then(() => true)
        .catch(() => false);
    }
    return this.gitAvailable;
  }

  private async isRepoRoot(root: string): Promise<boolean> {
    const top = await this.run(root, ["rev-parse", "--show-toplevel"]).catch(
      () => "",
    );
    if (top.trim() === "") {
      return false;
    }
    return samePath(top.trim(), root);
  }

  private async run(root: string, args: string[]): Promise<string> {
    try {
      const result = await execFileAsync("git", ["-C", root, ...args], {
        maxBuffer: 10 * 1024 * 1024,
        // Windows 上后台服务无控制台，不隐藏会给每次 git 调用弹一个命令窗口。
        windowsHide: true,
      });
      return result.stdout;
    } catch (cause) {
      const stderr =
        cause && typeof cause === "object" && "stderr" in cause
          ? String((cause as { stderr: unknown }).stderr).trim()
          : "";
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        stderr !== "" ? `git 操作失败：${stderr.slice(0, 300)}` : "git 操作失败",
      );
    }
  }

  private settingsPath(root: string): string {
    return resolve(root, ".suduo", "git.json");
  }

  private async readSettings(root: string): Promise<GitProjectSettings> {
    try {
      const parsed = JSON.parse(
        await readFile(this.settingsPath(root), "utf8"),
      ) as Partial<GitProjectSettings>;
      return {
        managed: parsed.managed === true,
        autoCheckpoint: parsed.autoCheckpoint === true,
      };
    } catch {
      return { managed: false, autoCheckpoint: false };
    }
  }

  private async writeSettings(
    root: string,
    settings: GitProjectSettings,
  ): Promise<void> {
    // 经 ensureSuDuoDir 建 `.suduo/`，保证它带忽略全部内容的 .gitignore。
    await ensureSuDuoDir(root);
    await writeFile(this.settingsPath(root), JSON.stringify(settings), {
      mode: 0o600,
    });
  }

  private requireProject(projectId: string) {
    const project = this.projects.getById(projectId);
    if (!project || project.state !== "active") {
      throw new ApiError(404, "NOT_FOUND", "活动项目不存在");
    }
    return project;
  }
}

/** 解析 `git status --porcelain --branch` 首行（去掉 "## " 后），导出以便单测。 */
export function parseStatusHeader(header: string | null): {
  branch: string | null;
  hasUpstream: boolean;
} {
  if (!header) {
    return { branch: null, hasUpstream: false };
  }
  const noCommits = /^No commits yet on (.+)$/.exec(header);
  if (noCommits) {
    return { branch: noCommits[1] ?? null, hasUpstream: false };
  }
  if (header.startsWith("HEAD")) {
    return { branch: "HEAD", hasUpstream: false };
  }
  const dots = header.indexOf("...");
  if (dots >= 0) {
    return { branch: header.slice(0, dots), hasUpstream: true };
  }
  const space = header.indexOf(" ");
  return {
    branch: space >= 0 ? header.slice(0, space) : header,
    hasUpstream: false,
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function timeLabel(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
