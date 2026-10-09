import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  open,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type {
  AttachmentDto,
  ExistingFilesResponse,
  FileContentDto,
  FileIndexResponse,
  ListFilesResponse,
  ListSkillsResponse,
  RuntimeSkill,
  SkillDto,
} from "@suduo/client-contracts";
import {
  detectOpenTargets,
  openWithSystemApp,
  type SystemOpenMode,
} from "../infrastructure/platform/system-open.js";
import type { SkillRootsProvider } from "./skill-roots.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../infrastructure/db/repositories/session-repository.js";
import { saveImageAttachment } from "../infrastructure/workspace/attachment-store.js";
import {
  BaselineStore,
  type BaselineFileEntry,
  type BaselineManifest,
  type BaselineSnapshot,
} from "../infrastructure/workspace/baseline-store.js";
import {
  guardExistingPath,
  requireDirectory,
  requireFile,
  toPosix,
} from "../infrastructure/workspace/path-guard.js";
import { ApiError, errorTextOf } from "./api-error.js";

const MAX_TEXT_BYTES = 1024 * 1024;
const FULL_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 8000;
/** 已知二进制扩展名：读成 utf8 会得到巨型乱码（曾导致渲染卡死），一律走 binary 变体。 */
const BINARY_EXTENSIONS = new Set([
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf",
  ".zip", ".rar", ".7z", ".gz", ".tar", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".node", ".bin", ".dat",
  ".sqlite", ".db", ".mdb",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".mkv", ".flac",
  ".jar", ".class", ".o", ".a", ".lib", ".pyc", ".wasm",
]);
/** 快照文件数上限（按目录检查，单个目录内可略超）。 */
const MAX_SNAPSHOT_FILES = 5_000;
/** 超过该大小的文件不读内容，按 size + mtime 算哈希。 */
const HASH_BY_STAT_BYTES = 20 * 1024 * 1024;
/**
 * 缓存条目的 mtime 与取得它的时刻相距不足该窗口时不可信：同一个时间刻度内的二次改写
 * 可能大小、mtime 都不变（即 git 的 racy-clean 问题）。2s 覆盖 FAT 这类粗粒度文件系统。
 */
const RACY_WINDOW_MS = 2_000;
/** 内存里最多保留多少个会话的刷新缓存（按最近使用淘汰）。 */
const MAX_CACHED_SESSIONS = 16;
/** 同一目录内并发 stat 的批大小。 */
const STAT_CONCURRENCY = 64;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * 目录遍历期间该跳过的文件系统错误。
 *
 * `readdir` 列出条目到随后 `stat`/`readFile` 之间，文件完全可能已经消失或变得
 * 不可达——构建产物被重写、`git checkout` 切分支、编译器写完临时文件就删。
 * 这是**遍历的常态而非异常**：实测在服务运行期间重新构建前端时，
 * `listChanges` 会因 `dist/assets` 下的旧 chunk 被删而整个失败并返回 500。
 *
 * 因此这类错误只跳过该条目，不中断遍历（与上方 `readdir` 的既有处置一致）；
 * **其余错误照常抛出**，不把编程错误一起吞掉。
 */
const TRANSIENT_FS_ERROR_CODES = new Set([
  "ENOENT",   // 条目已被删除
  "ENOTDIR",  // 路径中途的目录被替换成了文件
  "ELOOP",    // 符号链接环
  "EACCES",   // 无读取权限
  "EPERM",
  "EBUSY",    // Windows 上被占用
]);

export function isTransientFsError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  const code = (cause as NodeJS.ErrnoException).code;
  return code !== undefined && TRANSIENT_FS_ERROR_CODES.has(code);
}
// .ccb 是 CCB 等 agent 工具的运行时状态目录（实测可达 3.1GB / 8.5 万文件），不属于用户改动；
// 不排除会吃光快照的 5000 文件配额，让 listChanges 退化成十几秒的全盘读取+哈希。
const IGNORED_DIRECTORIES = new Set([".git", ".suduo", ".ccb", "node_modules"]);

/** 某个文件「上次看到」的状态（刷新缓存的条目）。 */
interface FileState {
  size: number;
  mtimeMs: number;
  sha256: string;
  /** 取得这份状态的时刻（不晚于读取文件内容的时刻），供 racy 判定。 */
  checkedAt: number;
}

interface LineStats {
  additions: number;
  deletions: number;
}

/** 每会话的增量刷新缓存（只在内存里，重启后以基线清单为初值重建）。 */
interface SessionScanCache {
  files: Map<string, FileState>;
  /** 行级增删的记忆：键含路径与前后 sha256，内容没变就不必再读文件、跑 LCS。 */
  lineStats: Map<string, LineStats>;
}

export interface WorkspaceChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  size: number | null;
  /** 行级增删（二进制/超限文件为 0）。 */
  additions: number;
  deletions: number;
}

export interface WorkspaceChanges {
  items: WorkspaceChange[];
  /** 本会话累计行级增删（环境信息卡的「变更」）。 */
  additions: number;
  deletions: number;
}

export interface WorkspaceDiff {
  path: string;
  kind: WorkspaceChange["kind"];
  before: string;
  after: string;
  truncated: boolean;
}

export class WorkspaceService {
  /** 「改动」面板的会话基线（数据目录下，按内容去重）。 */
  private readonly baselines: BaselineStore;
  /** 每会话的增量刷新缓存；Map 的插入顺序即最近使用顺序。 */
  private readonly scanCaches = new Map<string, SessionScanCache>();
  /** 进行中的基线拍摄：/changes 遇到时等它，而不是再拍一份。 */
  private readonly capturesInFlight = new Map<string, Promise<BaselineManifest>>();

  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly skillRoots: SkillRootsProvider,
    /** 向 runtime 查询它真正认识的 skills（真相源）；传 undefined 则回落磁盘扫描。 */
    private readonly skillCatalog: ((cwd: string) => Promise<RuntimeSkill[] | null>) | undefined,
    // 必传：正式装配放数据目录下的 baselines/，测试传自己会清理的临时目录。
    // 不设兜底目录——以前兜底到系统临时目录且无人清理，每跑一次测试都漏一批。
    options: { baselineRoot: string },
  ) {
    this.baselines = new BaselineStore(options.baselineRoot);
  }

  async listDirectory(projectId: string, path = "", sessionId?: string): Promise<ListFilesResponse> {
    const guarded = await guardExistingPath(this.rootFor(projectId, sessionId), path);
    await requireDirectory(guarded);
    const entries = await readdir(guarded.absolutePath, { withFileTypes: true });
    const mapped = (
      await Promise.all(
        entries
          .filter((entry) => ![".git", ".suduo"].includes(entry.name))
          .map(async (entry) => {
            const absolutePath = resolve(guarded.absolutePath, entry.name);
            let info;
            try {
              info = await stat(absolutePath);
            } catch (cause) {
              // 列举与 stat 之间条目消失：跳过它，不让整个目录列举失败。
              if (isTransientFsError(cause)) return null;
              throw cause;
            }
            return {
              name: entry.name,
              path: toPosix(relative(guarded.root, absolutePath)),
              type: entry.isDirectory() ? "directory" as const : "file" as const,
              size: entry.isFile() ? info.size : null,
              modifiedAt: info.mtimeMs,
            };
          }),
      )
    ).filter((item) => item !== null);
    mapped.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
    return { path: guarded.relativePath, entries: mapped };
  }

  async readContent(projectId: string, path: string, sessionId?: string): Promise<FileContentDto> {
    const guarded = await guardExistingPath(this.rootFor(projectId, sessionId), path);
    await requireFile(guarded);
    const info = await stat(guarded.absolutePath);
    const mediaType = mediaTypeFor(path);
    if (mediaType.startsWith("image/")) {
      // 图片走 raw 流端点，不再 base64 内联（大图内存与传输都省）。
      return {
        type: "image",
        path: guarded.relativePath,
        mediaType,
        url: rawFileUrl(projectId, guarded.relativePath, sessionId),
        size: info.size,
      };
    }
    if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) {
      return {
        type: "binary",
        path: guarded.relativePath,
        mediaType:
          extname(path).toLowerCase() === ".pdf"
            ? "application/pdf"
            : "application/octet-stream",
        size: info.size,
      };
    }
    if (info.size > FULL_TEXT_BYTES) {
      // 超大文件不再报错：返回头部预览并标记截断，完整内容走系统应用打开。
      const handle = await open(guarded.absolutePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_TEXT_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, MAX_TEXT_BYTES, 0);
        const head = buffer.subarray(0, bytesRead);
        if (looksBinary(head)) {
          return {
            type: "binary",
            path: guarded.relativePath,
            mediaType: "application/octet-stream",
            size: info.size,
          };
        }
        return {
          type: "text",
          path: guarded.relativePath,
          mediaType,
          text: head.toString("utf8"),
          size: info.size,
          truncated: true,
        };
      } finally {
        await handle.close();
      }
    }
    const bytes = await readFile(guarded.absolutePath);
    if (looksBinary(bytes)) {
      // 未知扩展名的二进制（含空字节）不当文本回传，避免巨型乱码卡死渲染。
      return {
        type: "binary",
        path: guarded.relativePath,
        mediaType: "application/octet-stream",
        size: info.size,
      };
    }
    return {
      type: "text",
      path: guarded.relativePath,
      mediaType,
      text: bytes.toString("utf8"),
      size: info.size,
    };
  }

  /** 项目文件递归索引（@ 引用面板用），跳过 .git/.suduo/node_modules。 */
  async listIndex(projectId: string): Promise<FileIndexResponse> {
    const project = this.requireProject(projectId);
    const items: string[] = [];
    let truncated = false;
    const walk = async (directory: string, prefix: string): Promise<void> => {
      if (truncated) {
        return;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN"),
      );
      for (const entry of entries) {
        if (truncated) {
          return;
        }
        const childRelative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) {
            await walk(resolve(directory, entry.name), childRelative);
          }
          continue;
        }
        if (entry.isFile()) {
          if (items.length >= MAX_INDEX_ENTRIES) {
            truncated = true;
            return;
          }
          items.push(childRelative);
        }
      }
    };
    await walk(project.rootPath, "");
    return { items, truncated };
  }

  /** 供 raw 流端点使用：路径校验 + 元信息。 */
  async resolveRawFile(
    projectId: string,
    path: string,
    sessionId?: string,
  ): Promise<{ absolutePath: string; mediaType: string; size: number }> {
    const guarded = await guardExistingPath(this.rootFor(projectId, sessionId), path);
    await requireFile(guarded);
    const info = await stat(guarded.absolutePath);
    const extension = extname(path).toLowerCase();
    const mediaType =
      extension === ".pdf" ? "application/pdf" : mediaTypeFor(path);
    return { absolutePath: guarded.absolutePath, mediaType, size: info.size };
  }

  async listOpenTargets(): Promise<SystemOpenMode[]> {
    return detectOpenTargets();
  }

  /** Codex 注册表里对该项目可见的全部 skills（设置页用：含停用项与作用域）。 */
  async skillCatalogFor(projectId: string): Promise<RuntimeSkill[]> {
    const project = this.requireProject(projectId);
    const catalog = await this.skillCatalog?.(project.rootPath);
    if (!catalog) {
      throw new ApiError(
        503,
        "RUNTIME_UNAVAILABLE",
        (t) => t.workspace.files.skillsUnavailable,
      );
    }
    return [...catalog].sort((left, right) =>
      left.name.localeCompare(right.name, "zh-CN"),
    );
  }

  /** 按「打开位置」目标打开文件/目录（路径必须落在项目内）。 */
  /**
   * 批量确认项目内的普通文件是否存在（会话回答里的路径要不要变成链接）。只读：不存在、不是文件、
   * 越出项目目录（含符号链接）、路径不合法的一律当作不存在，不报错。
   */
  async existingFiles(projectId: string, paths: readonly string[], sessionId?: string): Promise<ExistingFilesResponse> {
    const root = this.rootFor(projectId, sessionId);
    const unique = [...new Set(paths)];
    const checks = await Promise.all(
      unique.map(async (path) => {
        try {
          const guarded = await guardExistingPath(root, path);
          return (await stat(guarded.absolutePath)).isFile() ? path : null;
        } catch {
          return null;
        }
      }),
    );
    return { files: checks.filter((path): path is string => path !== null) };
  }

  async openWithSystem(
    projectId: string,
    path: string,
    mode: SystemOpenMode,
    line?: number,
    sessionId?: string,
  ): Promise<void> {
    const guarded = await guardExistingPath(this.rootFor(projectId, sessionId), path);
    try {
      await openWithSystemApp(guarded.absolutePath, mode, mode === "vscode" ? line : undefined);
    } catch (cause) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        // 系统程序给的原因原样带上（打开失败的报错由 system-open 生成）；拿不到原因时用通用说明。
        cause instanceof Error ? errorTextOf(cause) : (t) => t.workspace.files.openFailed,
      );
    }
  }

  async saveAttachment(
    projectId: string,
    input: { mediaType: string; dataBase64: string },
  ): Promise<AttachmentDto> {
    const project = this.requireProject(projectId);
    if (
      typeof input.mediaType !== "string" ||
      typeof input.dataBase64 !== "string"
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.attachment.fieldsInvalid);
    }
    return saveImageAttachment({
      projectId,
      projectRoot: project.rootPath,
      mediaType: input.mediaType,
      dataBase64: input.dataBase64,
    });
  }

  /**
   * skills 列表以 runtime（codex）注册表为真相源：
   * 我们自扫目录曾导致 UI 里能选、但 codex 不认识 → 消息里的 skill 引用被静默忽略。
   * runtime 不可用时回落到磁盘扫描，至少不至于空列表。
   */
  async listSkills(projectId: string): Promise<ListSkillsResponse> {
    const project = this.requireProject(projectId);
    const catalog = await this.skillCatalog?.(project.rootPath);
    if (catalog) {
      return {
        items: catalog
          .filter((skill) => skill.enabled)
          .map((skill) => ({
            name: skill.name,
            path: skill.path,
            ...(skill.description ? { description: skill.description } : {}),
          }))
          .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
      };
    }
    const roots = [
      resolve(project.rootPath, ".codex", "skills"),
      resolve(project.rootPath, ".agents", "skills"),
      ...this.skillRoots.roots(),
    ];
    const skills = new Map<string, SkillDto>();
    for (const root of roots) {
      for (const skill of await discoverSkills(root)) {
        skills.set(skill.path, skill);
      }
    }
    return {
      items: [...skills.values()].sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN"),
      ),
    };
  }

  /** 拍会话基线（建会话时；/changes 发现缺失时也会补拍）。 */
  async captureBaseline(sessionId: string): Promise<void> {
    await this.startCapture(this.sessionRoot(sessionId), sessionId);
  }

  /** 会话实际干活的目录：并行试做的版本是它的 worktree（S10），其余是项目目录。 */
  private sessionRoot(sessionId: string): string {
    const { session, project } = this.requireSessionProject(sessionId);
    return session.workspacePath ?? project.rootPath;
  }

  /**
   * 后台拍基线（建会话后调用，不阻塞创建）。不抛错：失败只记一行日志，
   * 之后打开「改动」面板时会按缺失补拍。
   */
  async captureBaselineInBackground(sessionId: string): Promise<void> {
    try {
      await this.captureBaseline(sessionId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "workspace.baseline_capture_failed",
          sessionId,
          message: errorMessage(error),
        }),
      );
    }
  }

  /**
   * 会话删除时调用：删清单、清内存缓存，顺带删项目目录里的旧格式基线。
   * 不抛错（删不掉只是多占点数据目录空间，不该挡住删除会话）。
   */
  async forgetSessionBaseline(sessionId: string): Promise<void> {
    // 等进行中的拍摄落盘后再删，否则它会在删除之后把清单写回来。
    await this.capturesInFlight.get(sessionId)?.catch(() => undefined);
    this.scanCaches.delete(sessionId);
    try {
      await this.baselines.remove(sessionId);
      const session = this.sessions.getById(sessionId);
      const project = session ? this.projects.getById(session.projectId) : null;
      if (project) {
        await removeLegacyBaseline(project.rootPath, sessionId);
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "workspace.baseline_forget_failed",
          sessionId,
          message: errorMessage(error),
        }),
      );
    }
  }

  /**
   * 启动时调用：先删掉会话已不存在或已删除的清单，再回收不被任何清单引用的 blob。
   * 返回删除的 blob 数；不抛错（失败记日志、返回 0）。
   */
  async collectBaselineGarbage(): Promise<number> {
    try {
      for (const sessionId of await this.baselines.sessionIds()) {
        const session = this.sessions.getById(sessionId);
        if (!session || session.state === "deleted") {
          this.scanCaches.delete(sessionId);
          await this.baselines.remove(sessionId);
        }
      }
      return await this.baselines.collectGarbage();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "workspace.baseline_gc_failed",
          message: errorMessage(error),
        }),
      );
      return 0;
    }
  }

  /**
   * 「改动」列表：当前项目与会话基线的差异。
   *
   * 增量刷新：遍历目录只 `stat`，大小与 mtime 都和上次一样的文件直接沿用缓存里的哈希，
   * 变了才读文件重算；行级增删按「路径 + 前后哈希」记忆，没变就不再读文件、跑 LCS。
   */
  async listChanges(sessionId: string): Promise<WorkspaceChanges> {
    const root = this.sessionRoot(sessionId);
    const baseline = await this.loadBaseline(root, sessionId);
    const cache = this.scanCacheFor(sessionId, baseline);
    // 本轮新读到、且与基线不同的文本：算行级增删时直接用，不再读第二遍。
    const freshTexts = new Map<string, Buffer>();
    const current = await scanProject(root, {
      previous: (path) => cache.files.get(path),
      onRead: (path, bytes, state) => {
        if (
          ownEntry(baseline.files, path)?.sha256 !== state.sha256 &&
          isTextCandidate(path, state.size)
        ) {
          freshTexts.set(path, bytes);
        }
      },
    });
    const memo = {
      previous: cache.lineStats,
      next: new Map<string, LineStats>(),
      freshTexts,
    };
    const items: WorkspaceChange[] = [];
    const paths = new Set([
      ...Object.keys(baseline.files),
      ...current.files.keys(),
    ]);
    for (const path of paths) {
      const before = ownEntry(baseline.files, path);
      const after = current.files.get(path) ?? null;
      if (!before && !after) {
        continue;
      }
      if (before && after && before.sha256 === after.sha256) {
        continue;
      }
      const stats = await this.lineStatsFor(root, path, before, after, memo);
      items.push({
        path,
        kind: !before ? "created" : !after ? "deleted" : "modified",
        size: after ? after.size : null,
        ...stats,
      });
    }
    this.touchScanCache(sessionId, {
      files: current.files,
      lineStats: memo.next,
    });
    items.sort((left, right) => left.path.localeCompare(right.path));
    let additions = 0;
    let deletions = 0;
    for (const item of items) {
      additions += item.additions;
      deletions += item.deletions;
    }
    return { items, additions, deletions };
  }

  /**
   * 这个会话有没有工作区基线（不现拍）：跨会话读取「改动」时先问它（多 Agent S7），
   * 没有就退回 Agent 报告的改动——现拍的基线是此刻的目录，会把之前的改动都算没了。
   */
  async hasBaseline(sessionId: string): Promise<boolean> {
    if (this.capturesInFlight.has(sessionId)) return true;
    return (await this.baselines.load(sessionId).catch(() => null)) !== null;
  }

  /** 单文件 diff：只读这一个文件与它的基线副本，不重拍整个项目。 */
  async diff(sessionId: string, path: string): Promise<WorkspaceDiff> {
    const root = this.sessionRoot(sessionId);
    const baseline = await this.loadBaseline(root, sessionId);
    const before = ownEntry(baseline.files, path);
    const after = await readCurrentFile(root, path);
    if (!before && !after) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.workspace.files.diffNotFound);
    }
    // blob 丢失（被手工清理等）时按「无副本」处理：显示占位并标记截断。
    const beforeText = before?.text
      ? await this.baselines.readText(before.sha256)
      : null;
    const kind = !before ? "created" : !after ? "deleted" : "modified";
    return {
      path,
      kind,
      before: beforeText ?? binaryPlaceholder(before),
      after: after?.text ?? binaryPlaceholder(after),
      truncated:
        (before !== null && beforeText === null) ||
        (after !== null && after.text === null),
    };
  }

  projectRoot(projectId: string): string {
    return this.requireProject(projectId).rootPath;
  }

  private requireProject(projectId: string) {
    const project = this.projects.getById(projectId);
    if (!project || project.state !== "active") {
      throw new ApiError(404, "NOT_FOUND", (t) => t.workspace.project.activeNotFound);
    }
    return project;
  }

  /**
   * 文件操作的根：会话页带上会话、且会话在独立工作目录（并行试做的 worktree，S10）里干活时是那个目录，
   * 否则是项目目录（会话不属于这个项目时也按项目目录）。
   */
  private rootFor(projectId: string, sessionId?: string): string {
    const project = this.requireProject(projectId);
    if (sessionId === undefined || sessionId === "") return project.rootPath;
    const session = this.sessions.getById(sessionId);
    return session !== null && session.projectId === project.id ? (session.workspacePath ?? project.rootPath) : project.rootPath;
  }

  private requireSessionProject(sessionId: string) {
    const session = this.sessions.getById(sessionId);
    if (!session) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.workspace.files.sessionNotFound);
    }
    const project = this.requireProject(session.projectId);
    return { session, project };
  }

  /** 取会话基线：进行中的拍摄 → 新存储 → 旧位置导入 → 补拍。 */
  private async loadBaseline(
    projectRoot: string,
    sessionId: string,
  ): Promise<BaselineManifest> {
    let manifest: BaselineManifest | null = null;
    const inFlight = this.capturesInFlight.get(sessionId);
    if (inFlight) {
      // 建会话后的后台拍摄还没完成：等它，不重复拍；它失败了就按缺失处理。
      manifest = await inFlight.catch(() => null);
    }
    manifest ??= await this.readStoredBaseline(sessionId);
    manifest ??= await this.importLegacyBaseline(projectRoot, sessionId);
    manifest ??= await this.startCapture(projectRoot, sessionId);
    // 忽略清单扩容后，旧基线仍留着已不再快照的路径；不剔除会把它们整片
    // 报成「已删除」。读取时过滤即可兼容存量基线，无需重建。
    return { ...manifest, files: withoutIgnoredPaths(manifest.files) };
  }

  private async readStoredBaseline(
    sessionId: string,
  ): Promise<BaselineManifest | null> {
    try {
      return await this.baselines.load(sessionId);
    } catch (error) {
      throw new ApiError(500, "RUNTIME_REQUEST_FAILED", (t) => t.workspace.files.baselineInvalid, undefined, {
        cause: error,
      });
    }
  }

  /**
   * 旧版把基线写在 `<项目>/.suduo/baselines/<会话>.json`（全文内联）。首次访问时导入
   * 新存储并删除旧文件；导入失败（读不了、格式不对）按缺失补拍，旧文件同样删除——
   * 它已无法使用。补拍本身失败时保留旧文件，不在没有替代品时删东西。
   */
  private async importLegacyBaseline(
    projectRoot: string,
    sessionId: string,
  ): Promise<BaselineManifest | null> {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      return null;
    }
    let raw: string | null;
    try {
      raw = await readFile(legacyBaselinePath(projectRoot, sessionId), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return null;
      }
      raw = null;
    }
    let manifest: BaselineManifest | null = null;
    const snapshot = raw === null ? null : parseLegacyBaseline(raw, sessionId);
    if (snapshot) {
      manifest = await this.baselines.save(sessionId, snapshot).catch(() => null);
    }
    manifest ??= await this.startCapture(projectRoot, sessionId);
    await removeLegacyBaseline(projectRoot, sessionId);
    return manifest;
  }

  /** 开始拍基线并登记为进行中；同一会话再次拍摄时以最新一次为准。 */
  private startCapture(
    projectRoot: string,
    sessionId: string,
  ): Promise<BaselineManifest> {
    const task = this.capture(projectRoot, sessionId);
    this.capturesInFlight.set(sessionId, task);
    const settle = () => {
      if (this.capturesInFlight.get(sessionId) === task) {
        this.capturesInFlight.delete(sessionId);
      }
    };
    task.then(settle, settle);
    return task;
  }

  private async capture(
    projectRoot: string,
    sessionId: string,
  ): Promise<BaselineManifest> {
    // 取遍历开始的时刻：早于任何文件的读取，用作缓存初值的 checkedAt 是保守的。
    const capturedAt = Date.now();
    const texts = new Map<string, Buffer>();
    const scan = await scanProject(projectRoot, {
      onRead: (path, bytes, state) => {
        if (isTextCandidate(path, state.size)) {
          texts.set(state.sha256, bytes);
        }
      },
    });
    const files = Object.fromEntries(
      [...scan.files].map(([path, state]): [string, BaselineFileEntry] => [
        path,
        {
          size: state.size,
          mtimeMs: state.mtimeMs,
          sha256: state.sha256,
          text: isTextCandidate(path, state.size) && texts.has(state.sha256),
        },
      ]),
    );
    const manifest = await this.baselines.save(sessionId, {
      capturedAt,
      files,
      texts,
      ...(scan.truncated ? { truncated: true } : {}),
    });
    // 刚拍下的状态就是最新的刷新缓存，下一次 /changes 不必再读这些文件。
    this.touchScanCache(sessionId, { files: scan.files, lineStats: new Map() });
    return manifest;
  }

  /** 取会话的刷新缓存；第一次（缓存为空）时以基线清单为初值。 */
  private scanCacheFor(
    sessionId: string,
    baseline: BaselineManifest,
  ): SessionScanCache {
    const cached = this.scanCaches.get(sessionId);
    if (cached) {
      this.touchScanCache(sessionId, cached);
      return cached;
    }
    const files = new Map<string, FileState>();
    for (const [path, entry] of Object.entries(baseline.files)) {
      files.set(path, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: entry.sha256,
        checkedAt: baseline.capturedAt,
      });
    }
    const seeded = { files, lineStats: new Map<string, LineStats>() };
    this.touchScanCache(sessionId, seeded);
    return seeded;
  }

  /** 写入并标记为最近使用；超出上限时淘汰最久未用的会话。 */
  private touchScanCache(sessionId: string, cache: SessionScanCache): void {
    this.scanCaches.delete(sessionId);
    this.scanCaches.set(sessionId, cache);
    while (this.scanCaches.size > MAX_CACHED_SESSIONS) {
      const oldest = this.scanCaches.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.scanCaches.delete(oldest);
    }
  }

  private async lineStatsFor(
    projectRoot: string,
    path: string,
    before: BaselineFileEntry | null,
    after: FileState | null,
    memo: {
      previous: Map<string, LineStats>;
      next: Map<string, LineStats>;
      freshTexts: Map<string, Buffer>;
    },
  ): Promise<LineStats> {
    const key = [path, before?.sha256 ?? "", after?.sha256 ?? ""].join("\0");
    const known = memo.previous.get(key) ?? memo.next.get(key);
    if (known) {
      memo.next.set(key, known);
      return known;
    }
    const beforeText = before?.text
      ? await this.baselines.readText(before.sha256)
      : null;
    const current = after
      ? await readCurrentText(projectRoot, path, after, memo.freshTexts)
      : { text: null, exact: true };
    const stats = !before
      ? { additions: countLines(current.text), deletions: 0 }
      : !after
        ? { additions: 0, deletions: countLines(beforeText) }
        : lineStats(beforeText, current.text);
    if (current.exact) {
      memo.next.set(key, stats);
    }
    return stats;
  }
}

/**
 * 是否落在被忽略的目录里。只按目录段判断，与遍历口径一致：遍历只跳过这些名字的
 * **目录**（git worktree 根下的 `.git` 是文件，照常计入）。
 */
function isIgnoredPath(path: string): boolean {
  const segments = path.split("/");
  segments.pop();
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function withoutIgnoredPaths(
  files: Record<string, BaselineFileEntry>,
): Record<string, BaselineFileEntry> {
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => !isIgnoredPath(path)),
  );
}

/** 只取自有属性：防止名为 `constructor` / `__proto__` 的文件命中原型链。 */
function ownEntry(
  files: Record<string, BaselineFileEntry>,
  path: string,
): BaselineFileEntry | null {
  return Object.hasOwn(files, path) ? (files[path] ?? null) : null;
}

/** ≤1MB 的文本类文件才保存全文、参与行级统计。 */
function isTextCandidate(path: string, size: number): boolean {
  return size <= MAX_TEXT_BYTES && isTextPath(path);
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ScanOptions {
  /** 上次看到的状态：大小、mtime 都相同且不在 racy 窗口内时沿用其哈希，不读文件。 */
  previous?: (path: string) => FileState | undefined;
  /** 每个实际读过内容的文件回调一次（>20MB 的文件不读内容，不回调）。 */
  onRead?: (path: string, bytes: Buffer, state: FileState) => void;
}

/**
 * 遍历项目：最多约 5000 个文件，跳过 `.git/.suduo/.ccb/node_modules` 目录；
 * >20MB 的文件按 size + mtime 算哈希，其余读内容算 sha256（命中 previous 时不读）。
 */
async function scanProject(
  root: string,
  options: ScanOptions = {},
): Promise<{ files: Map<string, FileState>; truncated: boolean }> {
  const files = new Map<string, FileState>();
  const pending = [root];
  while (pending.length > 0 && files.size < MAX_SNAPSHOT_FILES) {
    const directory = pending.pop();
    if (!directory) {
      break;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates: string[] = [];
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          pending.push(absolutePath);
        }
        continue;
      }
      if (entry.isFile()) {
        candidates.push(absolutePath);
      }
    }
    const infos = await statFiles(candidates);
    for (const [index, absolutePath] of candidates.entries()) {
      const info = infos[index];
      if (!info) {
        continue;
      }
      const path = toPosix(relative(root, absolutePath));
      const checkedAt = Date.now();
      if (info.size > HASH_BY_STAT_BYTES) {
        files.set(path, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          sha256: sha256Hex(String(info.size) + ":" + String(info.mtimeMs)),
          checkedAt,
        });
        continue;
      }
      const previous = options.previous?.(path);
      if (previous && isUnchanged(previous, info)) {
        files.set(path, previous);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(absolutePath);
      } catch (cause) {
        if (isTransientFsError(cause)) continue;
        throw cause;
      }
      const state: FileState = {
        size: bytes.length,
        mtimeMs: info.mtimeMs,
        sha256: sha256Hex(bytes),
        checkedAt,
      };
      files.set(path, state);
      options.onRead?.(path, bytes, state);
    }
  }
  return { files, truncated: pending.length > 0 };
}

/** 分批并发 stat；条目在列举后消失等瞬态错误记为 null（跳过），其余照常抛出。 */
async function statFiles(paths: string[]): Promise<Array<Stats | null>> {
  const results: Array<Stats | null> = [];
  for (let index = 0; index < paths.length; index += STAT_CONCURRENCY) {
    const batch = paths.slice(index, index + STAT_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async (path) => {
          try {
            return await stat(path);
          } catch (cause) {
            if (isTransientFsError(cause)) return null;
            throw cause;
          }
        }),
      )),
    );
  }
  return results;
}

/**
 * 大小、mtime 都没变即视为内容没变——但 mtime 离取得缓存的时刻太近时不信任
 * （同一时间刻度内的再次改写可能看不出 mtime 变化），宁可重读一次。
 */
function isUnchanged(previous: FileState, info: Stats): boolean {
  return (
    previous.size === info.size &&
    previous.mtimeMs === info.mtimeMs &&
    previous.checkedAt - previous.mtimeMs > RACY_WINDOW_MS
  );
}

/** 当前文件的文本（行级统计用）；exact=false 表示读到的已不是 state 对应的内容。 */
async function readCurrentText(
  root: string,
  path: string,
  state: FileState,
  freshTexts: Map<string, Buffer>,
): Promise<{ text: string | null; exact: boolean }> {
  if (!isTextCandidate(path, state.size)) {
    return { text: null, exact: true };
  }
  const fresh = freshTexts.get(path);
  if (fresh) {
    return { text: fresh.toString("utf8"), exact: true };
  }
  // 本轮命中了哈希缓存、行级增删却没有记忆（少见）：补读一次。
  let bytes: Buffer;
  try {
    bytes = await readFile(resolve(root, path));
  } catch (cause) {
    if (isTransientFsError(cause)) return { text: null, exact: false };
    throw cause;
  }
  return { text: bytes.toString("utf8"), exact: sha256Hex(bytes) === state.sha256 };
}

/**
 * diff 用：只读这一个文件。不存在、越界、在忽略目录里或不是普通文件都返回 null
 * （与「改动」列表的口径一致，也不让 diff 端点读到项目外的文件）。
 */
async function readCurrentFile(
  root: string,
  path: string,
): Promise<{ size: number; text: string | null } | null> {
  if (isIgnoredPath(path)) {
    return null;
  }
  let absolutePath: string;
  try {
    absolutePath = (await guardExistingPath(root, path)).absolutePath;
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
  let info;
  try {
    info = await stat(absolutePath);
  } catch (cause) {
    if (isTransientFsError(cause)) return null;
    throw cause;
  }
  if (!info.isFile()) {
    return null;
  }
  if (info.size > HASH_BY_STAT_BYTES) {
    return { size: info.size, text: null };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (cause) {
    if (isTransientFsError(cause)) return null;
    throw cause;
  }
  return {
    size: bytes.length,
    text: isTextCandidate(path, bytes.length) ? bytes.toString("utf8") : null,
  };
}

function legacyBaselinePath(projectRoot: string, sessionId: string): string {
  return resolve(projectRoot, ".suduo", "baselines", sessionId + ".json");
}

/** 删项目目录里的旧格式基线；旧目录空了一并删掉。尽力而为，不抛错。 */
async function removeLegacyBaseline(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return;
  }
  await rm(legacyBaselinePath(projectRoot, sessionId), { force: true }).catch(
    () => undefined,
  );
  // 还有别的会话的旧基线时目录非空，rmdir 失败，忽略即可。
  await rmdir(resolve(projectRoot, ".suduo", "baselines")).catch(() => undefined);
}

/**
 * 解析旧格式基线 `{ version: 1, sessionId, createdAt, files: { 路径: { hash, size, text } } }`。
 * 任何一处不符合就整份视为无效（返回 null），由调用方补拍。
 */
function parseLegacyBaseline(
  raw: string,
  sessionId: string,
): BaselineSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed["version"] !== 1 ||
    parsed["sessionId"] !== sessionId ||
    !isRecord(parsed["files"])
  ) {
    return null;
  }
  const entries: Array<[string, BaselineFileEntry]> = [];
  const texts = new Map<string, string>();
  for (const [path, value] of Object.entries(parsed["files"])) {
    if (!isRecord(value)) {
      return null;
    }
    const hash = value["hash"];
    const size = value["size"];
    const text = value["text"];
    if (
      typeof hash !== "string" ||
      !SHA256_HEX.test(hash) ||
      typeof size !== "number" ||
      (text !== null && typeof text !== "string")
    ) {
      return null;
    }
    if (isIgnoredPath(path)) {
      continue;
    }
    if (typeof text === "string") {
      texts.set(hash, text);
    }
    // 旧格式没有 mtime：记 -1，首次刷新时这些文件都会重读一遍。
    entries.push([
      path,
      { size, mtimeMs: -1, sha256: hash, text: typeof text === "string" },
    ]);
  }
  const createdAt = parsed["createdAt"];
  return {
    capturedAt: typeof createdAt === "number" ? createdAt : Date.now(),
    files: Object.fromEntries(entries),
    texts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countLines(text: string | null): number {
  if (text === null || text === "") {
    return 0;
  }
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

const MAX_STAT_LINES = 5000;

/**
 * 行级增删统计（环境信息卡用）。
 * 二进制（text=null）记 0；超大文件按行数差近似，避免为统计跑重 LCS。
 */
function lineStats(
  beforeText: string | null,
  afterText: string | null,
): { additions: number; deletions: number } {
  if (beforeText === null || afterText === null) {
    return { additions: 0, deletions: 0 };
  }
  const before = beforeText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const after = afterText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (before.length > MAX_STAT_LINES || after.length > MAX_STAT_LINES) {
    const delta = after.length - before.length;
    return {
      additions: Math.max(delta, 0),
      deletions: Math.max(-delta, 0),
    };
  }
  // 公共前后缀裁剪后按 LCS 长度反推增删（与前端 diff 口径一致）。
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);
  const common = lcsLength(midBefore, midAfter);
  return {
    additions: midAfter.length - common,
    deletions: midBefore.length - common,
  };
}

function lcsLength(before: string[], after: string[]): number {
  const rows = before.length;
  const cols = after.length;
  if (rows === 0 || cols === 0) {
    return 0;
  }
  // 滚动数组：统计只需长度，无须回溯路径。
  let previous = new Uint32Array(cols + 1);
  let current = new Uint32Array(cols + 1);
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) {
      current[col] =
        before[row - 1] === after[col - 1]
          ? (previous[col - 1] ?? 0) + 1
          : Math.max(previous[col] ?? 0, current[col - 1] ?? 0);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[cols] ?? 0;
}

export async function discoverSkills(root: string): Promise<SkillDto[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillDto[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = resolve(root, entry.name, "SKILL.md");
    try {
      const text = await readFile(path, "utf8");
      const metadata = parseSkillMetadata(text);
      skills.push({
        name: metadata.name ?? entry.name,
        path,
        ...(metadata.description === undefined
          ? {}
          : { description: metadata.description }),
        ...(metadata.version === undefined
          ? {}
          : { version: metadata.version }),
      });
    } catch {
      // Invalid skill directories are omitted rather than breaking the list.
    }
  }
  return skills;
}

function parseSkillMetadata(text: string): {
  name?: string;
  description?: string;
  version?: string;
} {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const values: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);
    if (match?.[1] && match[2]) {
      values[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
  return {
    ...(values["name"] ? { name: values["name"] } : {}),
    ...(values["description"]
      ? { description: values["description"] }
      : {}),
    ...(values["version"] ? { version: values["version"] } : {}),
  };
}

function mediaTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".txt": "text/plain",
      ".json": "application/json",
      ".ts": "text/typescript",
      ".tsx": "text/typescript",
      ".js": "text/javascript",
      ".css": "text/css",
      ".html": "text/html",
      ".yaml": "text/yaml",
      ".yml": "text/yaml",
      ".csv": "text/csv",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    } as Record<string, string>
  )[extension] ?? "text/plain";
}

function rawFileUrl(projectId: string, relativePath: string, sessionId?: string): string {
  const session = sessionId === undefined || sessionId === "" ? "" : `&sessionId=${encodeURIComponent(sessionId)}`;
  return `/api/v1/projects/${encodeURIComponent(projectId)}/files/raw?path=${encodeURIComponent(relativePath)}${session}`;
}

function isTextPath(path: string): boolean {
  return !mediaTypeFor(path).startsWith("image/") || extname(path) === ".svg";
}

/** 前 8KB 含空字节即判定为二进制。 */
function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 8192);
  return window.includes(0);
}

function binaryPlaceholder(file: { size: number } | null): string {
  return file ? `[binary or oversized file: ${String(file.size)} bytes]` : "";
}
