import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { formatRequirementNumber } from "@suduo/cloud-contracts";
import {
  SUDUO_DIR,
  assertWritableInsideProject,
  ensureSuDuoDir,
} from "../../infrastructure/workspace/suduo-dir.js";

/**
 * 需求在项目目录里的本机文件夹：`.suduo/requirements/REQ-1-标题/`，下面放
 * `materials/`（看附件、拉确认版保存的文件）和 `notes.md`（结论笔记）。
 */
export interface RequirementDir {
  /** 项目目录（落盘前据此确认目录没有经符号链接跑到项目外）。 */
  projectRoot: string;
  /** 绝对路径。 */
  absolutePath: string;
  /** 相对项目目录的路径，用在给模型 / 用户看的文字里。 */
  relativePath: string;
}

const REQUIREMENTS_DIR = "requirements";
const NOTES_FILE = "notes.md";
const NOTES_HISTORY_DIR = "notes.history";
const TITLE_LIMIT = 40;

/** 文件名 / 目录名里不安全的字符：路径分隔符、Windows 保留字符与控制字符；连续的合成一个替换符。 */
export function replaceUnsafePathCharacters(value: string, replacement: string): string {
  let result = "";
  let replacing = false;
  for (const character of value) {
    const unsafe = character.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(character);
    if (!unsafe) {
      result += character;
      replacing = false;
    } else if (!replacing) {
      result += replacement;
      replacing = true;
    }
  }
  return result;
}

/** `REQ-1-商家端-订单详情优化`：去掉路径不安全字符，标题截 40 字。 */
export function requirementDirName(number: number, title: string): string {
  const safeTitle = replaceUnsafePathCharacters(title, "-")
    .replace(/\s+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "");
  const prefix = formatRequirementNumber(number);
  // 截断后可能重新露出结尾的「-」「.」（Windows 会悄悄去掉目录名结尾的点，路径就对不上了），再去一次。
  const clipped = Array.from(safeTitle).slice(0, TITLE_LIMIT).join("").replace(/[-.]+$/gu, "");
  return clipped === "" ? prefix : `${prefix}-${clipped}`;
}

/**
 * 找到（或建好）这条需求的文件夹。标题改了以后按编号找到旧文件夹继续用，
 * 不另建一份，笔记不会因为改名丢。
 */
export async function resolveRequirementDir(
  projectRoot: string,
  requirement: { number: number; title: string },
  options: { create: boolean } = { create: true },
): Promise<RequirementDir> {
  const parent = join(projectRoot, SUDUO_DIR, REQUIREMENTS_DIR);
  const prefix = formatRequirementNumber(requirement.number);
  const existing = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const match = existing.find(
    (entry) =>
      entry.isDirectory() && (entry.name === prefix || entry.name.startsWith(prefix + "-")),
  );
  const name = match?.name ?? requirementDirName(requirement.number, requirement.title);
  const absolutePath = join(parent, name);
  if (options.create) {
    await ensureSuDuoDir(projectRoot);
    await assertWritableInsideProject(projectRoot, absolutePath);
    await mkdir(absolutePath, { recursive: true, mode: 0o700 });
  }
  return { projectRoot, absolutePath, relativePath: relative(projectRoot, absolutePath) };
}

/**
 * 结论笔记所在的需求文件夹：在 `notesRoot`（原项目目录）。会话在别的目录（并行试做的 worktree）里干活时，
 * 给它看的路径用绝对路径——`.suduo` 不进 git，相对路径在它的工作目录里找不到（长笔记就读不到全文）。
 */
export async function resolveNotesDir(
  roots: { projectRoot: string; notesRoot?: string | undefined },
  requirement: { number: number; title: string },
  options: { create: boolean } = { create: true },
): Promise<RequirementDir> {
  const root = roots.notesRoot ?? roots.projectRoot;
  const dir = await resolveRequirementDir(root, requirement, options);
  return root === roots.projectRoot ? dir : { ...dir, relativePath: dir.absolutePath };
}

export function materialsDir(dir: RequirementDir): RequirementDir {
  return childDir(dir, "materials");
}

export function childDir(dir: RequirementDir, name: string): RequirementDir {
  return {
    projectRoot: dir.projectRoot,
    absolutePath: join(dir.absolutePath, name),
    relativePath: join(dir.relativePath, name),
  };
}

/** 落盘前确认目录（含尚未创建的部分）仍在项目目录里。 */
export async function assertDirectoryInsideProject(projectRoot: string, directory: string): Promise<void> {
  await assertWritableInsideProject(projectRoot, directory);
}

export interface NotesSnapshot {
  /** 相对项目目录的路径。 */
  path: string;
  /** 笔记不存在时为 null。 */
  content: string | null;
  sha256: string | null;
}

export async function readNotes(dir: RequirementDir): Promise<NotesSnapshot> {
  const path = join(dir.relativePath, NOTES_FILE);
  try {
    const content = await readFile(join(dir.absolutePath, NOTES_FILE), "utf8");
    return { path, content, sha256: sha256(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, content: null, sha256: null };
    }
    throw error;
  }
}

export interface NotesSaveResult {
  path: string;
  /** 覆盖前的旧内容存档路径；原来没有笔记时为 null。 */
  backupPath: string | null;
  /** 用户（或别的会话）在模型上次读取之后改过笔记：只告知，不拒绝（ADR-0004）。 */
  changedSinceRead: boolean;
  sha256: string;
}

/**
 * 写结论笔记。覆盖前把旧内容存进 `notes.history/<时间>.md`，覆盖可恢复，
 * 不属于 ADR-0004 的不可逆字节损失。
 */
export async function saveNotes(
  dir: RequirementDir,
  content: string,
  lastReadSha256: string | null | undefined,
): Promise<NotesSaveResult> {
  await assertWritableInsideProject(dir.projectRoot, dir.absolutePath);
  await mkdir(dir.absolutePath, { recursive: true, mode: 0o700 });
  const current = await readNotes(dir);
  let backupPath: string | null = null;
  if (current.content !== null && current.content !== content) {
    const historyDir = join(dir.absolutePath, NOTES_HISTORY_DIR);
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupName = `${stamp}.md`;
    await writeFile(join(historyDir, backupName), current.content, { mode: 0o600 });
    backupPath = join(dir.relativePath, NOTES_HISTORY_DIR, backupName);
  }
  const target = join(dir.absolutePath, NOTES_FILE);
  const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(staging, content, { mode: 0o600 });
  await rename(staging, target);
  return {
    path: join(dir.relativePath, NOTES_FILE),
    backupPath,
    changedSinceRead:
      lastReadSha256 !== undefined && current.sha256 !== null && current.sha256 !== lastReadSha256,
    sha256: sha256(content),
  };
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
