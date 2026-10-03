import { existsSync } from "node:fs";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import type { InstallSkillRequest, SkillDto } from "@suduo/client-contracts";
import { discoverSkills } from "./workspace-service.js";
import { ApiError } from "./api-error.js";

const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;

/** 用户全局 skills 目录（默认 ~/.codex/skills；重装 SuDuo 也保留）。 */
export function defaultGlobalSkillsRoot(): string {
  return resolve(homedir(), ".codex", "skills");
}

/**
 * Skills 安装/卸载管理（v1 只管全局目录；项目级 skills 跟项目文件夹自管）。
 * 安装源：zip（base64 上送，fflate 解压）与本地文件夹；同名冲突须 overwrite 显式确认。
 */
export class SkillAdminService {
  constructor(private readonly globalRoot: string = defaultGlobalSkillsRoot()) {}

  root(): string {
    return this.globalRoot;
  }

  async list(): Promise<SkillDto[]> {
    return discoverSkills(this.globalRoot);
  }

  async install(input: InstallSkillRequest): Promise<SkillDto> {
    if (input.source === "zip") {
      return this.installZip(input);
    }
    return this.installFolder(input);
  }

  async remove(path: string): Promise<void> {
    const target = this.requireManagedSkillDir(path);
    await rm(target, { recursive: true, force: true });
  }

  private async installZip(input: {
    fileName: string;
    dataBase64: string;
    overwrite?: boolean;
  }): Promise<SkillDto> {
    if (typeof input.dataBase64 !== "string" || input.dataBase64 === "") {
      throw new ApiError(400, "VALIDATION_ERROR", "zip 内容不能为空");
    }
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.length > MAX_ZIP_BYTES) {
      throw new ApiError(400, "VALIDATION_ERROR", "zip 超过 30 MiB 上限");
    }
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(new Uint8Array(bytes));
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", "zip 解压失败，文件可能损坏");
    }
    const entries = Object.entries(files).filter(([path]) => !path.endsWith("/"));
    if (entries.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "zip 为空");
    }
    if (entries.length > MAX_ENTRIES) {
      throw new ApiError(400, "VALIDATION_ERROR", "zip 文件数超过 2000 上限");
    }
    let total = 0;
    for (const [path, data] of entries) {
      assertSafeEntryPath(path);
      total += data.length;
    }
    if (total > MAX_UNPACKED_BYTES) {
      throw new ApiError(400, "VALIDATION_ERROR", "解压后超过 50 MiB 上限");
    }

    // 结构判定：单一顶层目录含 SKILL.md → 用该目录名；根含 SKILL.md → 用 zip 文件名。
    const paths = entries.map(([path]) => normalizeEntry(path));
    let prefix = "";
    let skillName: string;
    if (paths.includes("SKILL.md")) {
      skillName = sanitizeName(basename(input.fileName).replace(/\.zip$/i, ""));
    } else {
      const tops = new Set(paths.map((path) => path.split("/")[0] ?? ""));
      const top = tops.size === 1 ? [...tops][0] : undefined;
      if (!top || !paths.includes(`${top}/SKILL.md`)) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "zip 必须在根目录或唯一顶层目录内包含 SKILL.md",
        );
      }
      prefix = top + "/";
      skillName = sanitizeName(top);
    }

    const target = await this.prepareTarget(skillName, input.overwrite === true);
    for (const [rawPath, data] of entries) {
      const relativePath = normalizeEntry(rawPath).slice(prefix.length);
      if (relativePath === "") {
        continue;
      }
      const destination = join(target, relativePath);
      assertContained(target, destination);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
    return this.requireInstalled(skillName);
  }

  private async installFolder(input: {
    path: string;
    overwrite?: boolean;
  }): Promise<SkillDto> {
    if (typeof input.path !== "string" || input.path === "") {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供文件夹路径");
    }
    const source = resolve(input.path);
    const info = await stat(source).catch(() => null);
    if (!info?.isDirectory()) {
      throw new ApiError(400, "VALIDATION_ERROR", "文件夹不存在：" + source);
    }
    if (!existsSync(join(source, "SKILL.md"))) {
      throw new ApiError(400, "VALIDATION_ERROR", "该文件夹内没有 SKILL.md");
    }
    const skillName = sanitizeName(basename(source));
    const target = await this.prepareTarget(skillName, input.overwrite === true);
    await cp(source, target, { recursive: true });
    return this.requireInstalled(skillName);
  }

  private async prepareTarget(
    skillName: string,
    overwrite: boolean,
  ): Promise<string> {
    const target = join(this.globalRoot, skillName);
    if (existsSync(target)) {
      if (!overwrite) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          `全局已存在同名 skill「${skillName}」，确认后可覆盖更新`,
        );
      }
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(target, { recursive: true });
    return target;
  }

  private async requireInstalled(skillName: string): Promise<SkillDto> {
    const installed = (await this.list()).find(
      (skill) => dirname(skill.path) === join(this.globalRoot, skillName),
    );
    if (!installed) {
      throw new ApiError(400, "VALIDATION_ERROR", "安装后未识别到有效 SKILL.md");
    }
    return installed;
  }

  private requireManagedSkillDir(path: string): string {
    if (typeof path !== "string" || path === "") {
      throw new ApiError(400, "VALIDATION_ERROR", "必须提供 skill 路径");
    }
    // 接受 SKILL.md 路径或 skill 目录路径，归一到目录。
    const normalized = resolve(path);
    const directory = basename(normalized) === "SKILL.md" ? dirname(normalized) : normalized;
    const parent = dirname(directory);
    if (!samePath(parent, this.globalRoot)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "只允许管理全局 skills 目录内的 skill",
      );
    }
    return directory;
  }
}

function normalizeEntry(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function assertSafeEntryPath(path: string): void {
  const normalized = normalizeEntry(path);
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized
      .split("/")
      .some((segment) => segment === ".." || segment === "")
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "zip 含非法路径：" + path);
  }
}

function assertContained(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(normalizedRoot + "/") &&
    !normalizedCandidate.startsWith(normalizedRoot + "\\")
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "zip 条目越出安装目录");
  }
}

function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, "-");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new ApiError(400, "VALIDATION_ERROR", "无法从来源推断合法的 skill 名称");
  }
  return cleaned;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}
