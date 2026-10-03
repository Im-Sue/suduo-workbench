import { constants, type Dirent } from "node:fs";
import { access, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  LOCAL_DIRECTORY_ENTRY_LIMIT,
  type LocalDirectoryEntryDto,
  type LocalDirectoryListingDto,
  type LocalPathErrorCode,
  type LocalPathInspectionDto,
} from "@suduo/client-contracts";
import { ApiError } from "./api-error.js";

export interface LocalDirectoryServiceOptions {
  /** 已映射到需求项目的本机目录，最近使用在前。 */
  recentRoots(): readonly string[];
  /** 仅供测试替换；默认为当前用户主目录。 */
  homeDirectory?: () => string;
  /** 仅供测试替换；默认为 `process.platform`。 */
  platform?: NodeJS.Platform;
}

/**
 * 最近使用的目录：已映射到需求项目、且本机项目仍在用的根目录。
 * 映射表按 updated_at 倒序（每次成功校验都会刷新），即最近使用在前。
 */
export function mappedWorkspaceRoots(
  mappings: { list(): ReadonlyArray<{ localProjectId: string }> },
  projects: { getById(id: string): { rootPath: string; state: string } | null },
): string[] {
  return mappings.list().flatMap((mapping) => {
    const project = projects.getById(mapping.localProjectId);
    return project?.state === "active" ? [project.rootPath] : [];
  });
}

/** `.git` 文件（worktree / submodule 的 gitdir 指针）超过此大小即不解析。 */
const GIT_POINTER_MAX_BYTES = 64 * 1024;

/** `HEAD` 超过此大小即不解析（正常只有一行 ref 或 40 / 64 位对象 id）。 */
const GIT_HEAD_MAX_BYTES = 4 * 1024;

/**
 * macOS 用户主目录第一层受隐私保护（TCC）的目录。探测其中的 `.git` 会触发系统授权弹窗，
 * 列主目录时对它们不做任何探测，见 `LocalDirectoryEntryDto.probed`。
 */
const MACOS_PROTECTED_HOME_DIRECTORIES: ReadonlySet<string> = new Set([
  "Desktop",
  "Documents",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
]);

// Windows 没有 O_NONBLOCK，也没有会阻塞 open 的 FIFO。
const READ_NONBLOCK_FLAGS =
  constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);

const NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

/**
 * 本机目录浏览，供"选择代码目录"对话框使用。只读：不创建、不修改任何路径，
 * 也不跨出调用方给出的目录（只列一层子目录）。访问边界由 LoopbackGuard 保证。
 */
export class LocalDirectoryService {
  constructor(private readonly options: LocalDirectoryServiceOptions) {}

  async list(input: { path?: string; hidden: boolean }): Promise<LocalDirectoryListingDto> {
    const home = await this.home();
    const directory = await resolveExistingDirectory(input.path ?? home);
    let dirents: Dirent[];
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw localPathError(error, directory);
    }
    const names = (
      await Promise.all(
        dirents.map(async (dirent) =>
          (input.hidden || !dirent.name.startsWith(".")) &&
          (await isDirectoryEntry(directory, dirent))
            ? dirent.name
            : null),
      )
    )
      .filter((name): name is string => name !== null)
      .sort(compareNames);
    const skipProtected =
      (this.options.platform ?? process.platform) === "darwin" && directory === home;
    const entries = await Promise.all(
      names
        .slice(0, LOCAL_DIRECTORY_ENTRY_LIMIT)
        .map((name) =>
          skipProtected && MACOS_PROTECTED_HOME_DIRECTORIES.has(name)
            ? unprobedEntry(join(directory, name), name)
            : describeEntry(join(directory, name), name)),
    );
    const parent = dirname(directory);
    return {
      path: directory,
      parent: parent === directory ? null : parent,
      home,
      entries,
      truncated: names.length > LOCAL_DIRECTORY_ENTRY_LIMIT,
      recent: [...new Set(this.options.recentRoots())],
    };
  }

  async inspect(input: { path: string }): Promise<LocalPathInspectionDto> {
    const requested = requireAbsolutePath(input.path);
    let resolved: string;
    try {
      resolved = await realpath(requested);
    } catch (error) {
      if (isMissing(error)) {
        return {
          path: resolve(requested),
          exists: false,
          isDirectory: false,
          readable: false,
          writable: false,
          isGitRepo: false,
          branch: null,
        };
      }
      throw localPathError(error, requested);
    }
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(resolved)).isDirectory();
    } catch (error) {
      throw localPathError(error, resolved);
    }
    const [readable, writable] = await Promise.all([
      hasAccess(resolved, constants.R_OK),
      hasAccess(resolved, constants.W_OK),
    ]);
    const git = isDirectory ? await gitHead(resolved) : { isGitRepo: false, branch: null };
    return {
      path: resolved,
      exists: true,
      isDirectory,
      readable,
      writable,
      ...git,
    };
  }

  private async home(): Promise<string> {
    const home = (this.options.homeDirectory ?? homedir)();
    return realpath(home).catch(() => home);
  }
}

async function resolveExistingDirectory(input: string): Promise<string> {
  const requested = requireAbsolutePath(input);
  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    throw localPathError(error, requested);
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(resolved)).isDirectory();
  } catch (error) {
    throw localPathError(error, resolved);
  }
  if (!isDirectory) {
    throw pathError(400, "LOCAL_PATH_NOT_DIRECTORY", "这个位置不是文件夹", resolved);
  }
  return resolved;
}

function requireAbsolutePath(value: string): string {
  if (value.trim() === "" || value.includes("\0") || !isAbsolute(value)) {
    throw pathError(400, "LOCAL_PATH_INVALID", "请输入以根目录开头的完整路径", value);
  }
  return value;
}

/** 符号链接按目标判断；目标不可达的链接不列出。 */
async function isDirectoryEntry(directory: string, dirent: Dirent): Promise<boolean> {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  return stat(join(directory, dirent.name))
    .then((information) => information.isDirectory())
    .catch(() => false);
}

async function describeEntry(path: string, name: string): Promise<LocalDirectoryEntryDto> {
  const [readable, writable, isGitRepo] = await Promise.all([
    hasAccess(path, constants.R_OK),
    hasAccess(path, constants.W_OK),
    hasAccess(join(path, ".git"), constants.F_OK),
  ]);
  return { name, path, isGitRepo, readable, writable };
}

/** 未探测的目录：不做任何 access，按普通可进入目录返回。 */
function unprobedEntry(path: string, name: string): LocalDirectoryEntryDto {
  return { name, path, isGitRepo: false, readable: true, writable: true, probed: false };
}

/** 直接读 HEAD，不起 git 子进程；分离 HEAD 或读不到时 branch 为 null。 */
async function gitHead(directory: string): Promise<{ isGitRepo: boolean; branch: string | null }> {
  const dotGit = join(directory, ".git");
  let gitDirectory: string;
  try {
    const information = await stat(dotGit);
    if (information.isDirectory()) {
      gitDirectory = dotGit;
    } else if (information.isFile() && information.size <= GIT_POINTER_MAX_BYTES) {
      const content = await readSmallRegularFile(dotGit, GIT_POINTER_MAX_BYTES);
      const pointer = content === null ? null : /^gitdir:\s*(.+?)\s*$/mu.exec(content);
      if (pointer?.[1] === undefined) return { isGitRepo: false, branch: null };
      gitDirectory = resolve(directory, pointer[1]);
    } else {
      return { isGitRepo: false, branch: null };
    }
  } catch {
    return { isGitRepo: false, branch: null };
  }
  const head = await readSmallRegularFile(join(gitDirectory, "HEAD"), GIT_HEAD_MAX_BYTES);
  const reference = head === null ? null : /^ref:\s*refs\/heads\/(.+)$/u.exec(head.trim());
  return { isGitRepo: true, branch: reference?.[1] ?? null };
}

/**
 * 只读取不超过 `maxBytes` 的普通文件，否则返回 null。
 *
 * 以 O_NONBLOCK 打开、对打开后的描述符 fstat 再读：FIFO 的 open / read 会在 libuv
 * 线程池里永久阻塞（几次就占满线程池，进程无法退出），指向 /dev/zero 之类设备的
 * 链接会一直读到内存上限；先 stat 路径再 readFile 则挡不住两次调用之间被替换。
 */
async function readSmallRegularFile(path: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, READ_NONBLOCK_FLAGS);
  } catch {
    return null;
  }
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxBytes ? null : buffer.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function compareNames(left: string, right: string): number {
  return NAME_COLLATOR.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

async function hasAccess(path: string, mode: number): Promise<boolean> {
  return access(path, mode).then(() => true).catch(() => false);
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function localPathError(error: unknown, path: string): ApiError {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return pathError(404, "LOCAL_PATH_NOT_FOUND", "这个位置不存在", path, error);
  }
  if (code === "EACCES" || code === "EPERM") {
    return pathError(403, "LOCAL_PATH_PERMISSION_DENIED", "没有权限访问这个位置", path, error);
  }
  if (code === "ELOOP" || code === "ENAMETOOLONG" || code === "EINVAL") {
    return pathError(400, "LOCAL_PATH_INVALID", "这个路径无法解析", path, error);
  }
  return new ApiError(500, "RUNTIME_REQUEST_FAILED", "读取本机目录失败", { path }, {
    cause: error,
  });
}

function pathError(
  statusCode: number,
  code: LocalPathErrorCode,
  message: string,
  path: string,
  cause?: unknown,
): ApiError {
  return new ApiError(
    statusCode,
    code,
    message,
    { path },
    cause === undefined ? undefined : { cause },
  );
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}
