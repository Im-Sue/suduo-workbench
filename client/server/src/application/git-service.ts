import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  CHECKPOINT_TRAILER,
  LEGACY_CHECKPOINT_AUTO_SUBJECT,
  LEGACY_CHECKPOINT_MANUAL_PREFIX,
  type CheckpointKind,
  type GitCheckpointDto,
  type GitStatusDto,
  type Locale,
} from "@suduo/client-contracts";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import { ensureSuDuoDir } from "../infrastructure/workspace/suduo-dir.js";
import { allMessages, messagesFor } from "../i18n/messages/index.js";
import { ApiError } from "./api-error.js";

const execFileAsync = promisify(execFile);

const TRAILER_LINE = new RegExp(`^${CHECKPOINT_TRAILER}:\\s*(turn-start|manual)\\s*$`);
/** git trailer 的样子：`Token: value`。 */
const TRAILER_SHAPE = /^[A-Za-z0-9-]+:\s/;
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
    locale: Locale = "zh-CN",
  ): Promise<GitCheckpointDto | null> {
    const project = this.requireProject(projectId);
    return this.snapshot(project.rootPath, false, message, locale);
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
    // 每条记录以 \x1e 结尾、字段以 \x1f 分隔；正文 %b 里可能有换行，所以不能按行切。
    const raw = await this.run(root, [
      "log",
      "-n",
      "30",
      "--pretty=%H%x1f%s%x1f%ct%x1f%b%x1e",
    ]).catch(() => "");
    return raw
      .split("\x1e")
      .map((record) => record.replace(/^\n+/, ""))
      .filter((record) => record.trim() !== "")
      .map((record) => {
        const [hash = "", subject = "", epoch = "0", body = ""] = record.split("\x1f");
        const kind = checkpointKindOf(subject, body);
        return {
          hash,
          subject,
          ts: Number(epoch) * 1000,
          auto: kind === "turn-start",
          kind,
          note: kind === "manual" ? manualNoteOf(subject) : null,
        };
      })
      .filter((item) => item.hash !== "");
  }

  /**
   * 还原到指定提交（git reset --hard）。
   * 未纳入版本管理的新文件不会被删除；后续提交仍可从 reflog 找回。
   */
  async restore(projectId: string, hash: string, locale: Locale = "zh-CN"): Promise<GitStatusDto> {
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
    const text = messagesFor(locale).checkpoint;
    await this.snapshot(root, false, text.beforeRestore, locale);
    await this.run(root, ["read-tree", "-u", "--reset", hash]);
    const pending = await this.run(root, ["status", "--porcelain"]);
    if (pending.trim() !== "") {
      await this.commit(root, text.manualPrefix + text.restoredTo(hash.slice(0, 7)), "manual");
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

  /**
   * 提交标题按语言写（迁移期调用方都还没传语言，默认中文，与之前一致）；
   * 是不是检查点、是哪一种，看正文末尾的标记行，不看标题。
   */
  private async snapshot(
    root: string,
    auto: boolean,
    message: string | undefined,
    locale: Locale = "zh-CN",
  ): Promise<GitCheckpointDto | null> {
    if (!(await this.available()) || !(await this.isRepoRoot(root))) {
      throw new ApiError(400, "VALIDATION_ERROR", "该项目不是 git 仓库");
    }
    await this.run(root, ["add", "-A"]);
    const pending = await this.run(root, ["status", "--porcelain"]);
    if (pending.trim() === "") {
      return null;
    }
    const text = messagesFor(locale).checkpoint;
    // 说明压成一行：提交正文只留标记行那一段，识别时才不会和多段正文混淆。
    const oneLine = message?.replace(/\s+/g, " ").trim();
    const note = oneLine ? oneLine : timeLabel();
    const kind: CheckpointKind = auto ? "turn-start" : "manual";
    const subject = auto ? text.autoSubject : text.manualPrefix + note;
    await this.commit(root, subject, kind);
    const hash = (await this.run(root, ["rev-parse", "HEAD"])).trim();
    return { hash, subject, ts: Date.now(), auto, kind, note: auto ? null : note };
  }

  /** kind 不为空时在正文末尾加标记行（git trailer），检查点列表靠它识别。 */
  private async commit(root: string, subject: string, kind?: CheckpointKind): Promise<void> {
    const message = ["-m", subject, ...(kind === undefined ? [] : ["-m", `${CHECKPOINT_TRAILER}: ${kind}`])];
    try {
      await this.run(root, ["commit", ...message]);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      // 新机器常无 git 身份配置：用工具身份兜底，不写入用户全局配置。
      if (/user\.(name|email)|Please tell me who you are|empty ident/i.test(text)) {
        await this.run(root, [...FALLBACK_IDENTITY, "commit", ...message]);
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

/** 先看标记行；没有标记行的旧提交按 0.7 及以前的中文标题识别。 */
function checkpointKindOf(subject: string, body: string): CheckpointKind | null {
  const marked = trailerKindOf(body);
  if (marked !== null) return marked;
  if (subject.startsWith(LEGACY_CHECKPOINT_AUTO_SUBJECT)) return "turn-start";
  if (subject.startsWith(LEGACY_CHECKPOINT_MANUAL_PREFIX)) return "manual";
  return null;
}

/**
 * SuDuo 写的检查点，正文只有一段 trailer（标记行，可能还有钩子加的 Signed-off-by 之类）。
 * 只在整个正文就是这样一段、且恰好一个标记值时才认：GitHub「Squash and merge」会把各次提交的说明
 * 连同标记行拼进多段正文，不能因此把合并提交当成检查点。
 */
function trailerKindOf(body: string): CheckpointKind | null {
  const text = body.trim();
  if (text === "" || /\n\s*\n/.test(text)) return null;
  const lines = text.split("\n").map((line) => line.trim());
  if (!lines.every((line) => TRAILER_SHAPE.test(line))) return null;
  const kinds = new Set(lines.flatMap((line) => {
    const matched = TRAILER_LINE.exec(line);
    return matched === null ? [] : [matched[1] as CheckpointKind];
  }));
  return kinds.size === 1 ? [...kinds][0] ?? null : null;
}

/** 手动检查点的说明：去掉任一语言的标题前缀；对不上任何前缀时整条标题就是说明。 */
function manualNoteOf(subject: string): string {
  const prefixes = [LEGACY_CHECKPOINT_MANUAL_PREFIX, ...allMessages().map((messages) => messages.checkpoint.manualPrefix)];
  const prefix = prefixes.find((candidate) => subject.startsWith(candidate));
  return prefix === undefined ? subject : subject.slice(prefix.length);
}
