import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 「改动」面板的会话基线存储（需求会话上下文重做 4.6）。
 *
 * 放在数据目录而不是用户项目里：
 * ```
 * <baselineRoot>/
 *   blobs/<sha256>          文本文件全文（≤1MB），全局按内容去重
 *   sessions/<会话 ID>.json  每会话清单：相对路径 → { size, mtimeMs, sha256, text }
 * ```
 * 同一项目的第二个会话几乎不占空间：未改过的文件内容相同，blob 直接复用。
 * 写入一律「临时文件 + rename」，崩溃时不会留下半截 blob 或半截清单。
 */

export const BASELINE_MANIFEST_VERSION = 1;

export interface BaselineFileEntry {
  size: number;
  /** 拍基线时的修改时间；旧格式导入的条目没有这一项，记 -1（永远不与当前文件相等）。 */
  mtimeMs: number;
  /** 文件内容的 sha256；>20MB 的文件是 `size:mtimeMs` 的 sha256（不读内容）。 */
  sha256: string;
  /** blobs/ 里是否存有全文（≤1MB 的文本文件才存）。 */
  text: boolean;
}

export interface BaselineManifest {
  version: typeof BASELINE_MANIFEST_VERSION;
  /** 开始拍基线的时间（早于任何一个文件的读取时刻）。 */
  capturedAt: number;
  files: Record<string, BaselineFileEntry>;
  /** 文件数超过上限、只拍了一部分。 */
  truncated?: boolean;
}

export interface BaselineSnapshot {
  capturedAt: number;
  files: Record<string, BaselineFileEntry>;
  /** `text: true` 条目的全文，按 sha256 给出（同内容只需一份）。 */
  texts: ReadonlyMap<string, Uint8Array | string>;
  truncated?: boolean;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const TEMP_SUFFIX = ".tmp";

export class BaselineStore {
  private readonly blobDirectory: string;
  private readonly sessionDirectory: string;
  /** 进行中的 save：垃圾回收必须等它们写完清单，否则刚写的 blob 会被当成无人引用删掉。 */
  private readonly savesInFlight = new Set<Promise<unknown>>();
  private garbageCollection: Promise<number> | null = null;

  constructor(baselineRoot: string) {
    this.blobDirectory = resolve(baselineRoot, "blobs");
    this.sessionDirectory = resolve(baselineRoot, "sessions");
  }

  /** 写入会话基线：先补齐缺的 blob，再原子替换清单。返回落盘的清单。 */
  async save(
    sessionId: string,
    snapshot: BaselineSnapshot,
  ): Promise<BaselineManifest> {
    const path = this.manifestPath(sessionId);
    // 回收进行中时先等它结束，再登记本次写入（单线程下这两步之间不会插进新的回收）。
    while (this.garbageCollection) {
      await this.garbageCollection.catch(() => undefined);
    }
    const task = this.writeSnapshot(path, snapshot);
    this.savesInFlight.add(task);
    try {
      return await task;
    } finally {
      this.savesInFlight.delete(task);
    }
  }

  /** 读取会话清单；不存在返回 null，内容损坏抛错。 */
  async load(sessionId: string): Promise<BaselineManifest | null> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parseManifest(raw);
  }

  /** 按 sha256 取基线全文；blob 不存在（或 sha256 非法）返回 null。 */
  async readText(sha256: string): Promise<string | null> {
    if (!SHA256_PATTERN.test(sha256)) {
      return null;
    }
    try {
      return await readFile(resolve(this.blobDirectory, sha256), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /** 删除会话清单（blob 留给 collectGarbage 统一回收）。 */
  async remove(sessionId: string): Promise<void> {
    await rm(this.manifestPath(sessionId), { force: true });
  }

  /** 存有清单的会话 ID。 */
  async sessionIds(): Promise<string[]> {
    return (await listNames(this.sessionDirectory))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => SESSION_ID_PATTERN.test(id));
  }

  /**
   * 删除不被任何清单引用的 blob（顺带清掉崩溃遗留的临时文件），返回删除的 blob 数。
   * 并发调用合并为一次。
   */
  collectGarbage(): Promise<number> {
    if (this.garbageCollection) {
      return this.garbageCollection;
    }
    const run = (async () => {
      await Promise.allSettled([...this.savesInFlight]);
      return this.sweep();
    })();
    this.garbageCollection = run;
    const clear = () => {
      if (this.garbageCollection === run) {
        this.garbageCollection = null;
      }
    };
    run.then(clear, clear);
    return run;
  }

  private async writeSnapshot(
    path: string,
    snapshot: BaselineSnapshot,
  ): Promise<BaselineManifest> {
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.sessionDirectory, { recursive: true, mode: 0o700 });
    for (const [sha256, content] of snapshot.texts) {
      if (SHA256_PATTERN.test(sha256)) {
        await this.ensureBlob(sha256, content);
      }
    }
    const entries: Array<[string, BaselineFileEntry]> = [];
    const checked = new Map<string, boolean>();
    for (const [relativePath, entry] of Object.entries(snapshot.files)) {
      let text = entry.text;
      if (text && !snapshot.texts.has(entry.sha256)) {
        // 调用方没给全文：blob 已存在才保留 text 标记，否则降级为「无副本」，
        // 免得 diff 时去取一个不存在的 blob。
        let exists = checked.get(entry.sha256);
        if (exists === undefined) {
          exists = await this.blobExists(entry.sha256);
          checked.set(entry.sha256, exists);
        }
        text = exists;
      }
      entries.push([
        relativePath,
        { size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256, text },
      ]);
    }
    const manifest: BaselineManifest = {
      version: BASELINE_MANIFEST_VERSION,
      capturedAt: snapshot.capturedAt,
      // fromEntries 定义自有属性：项目里真有名为 `__proto__` 的文件也不会改原型。
      files: Object.fromEntries(entries),
      ...(snapshot.truncated ? { truncated: true } : {}),
    };
    await writeAtomic(path, JSON.stringify(manifest));
    return manifest;
  }

  private async ensureBlob(
    sha256: string,
    content: Uint8Array | string,
  ): Promise<void> {
    if (await this.blobExists(sha256)) {
      // 按内容寻址：同名即同内容，不重写。
      return;
    }
    await writeAtomic(resolve(this.blobDirectory, sha256), content);
  }

  private async blobExists(sha256: string): Promise<boolean> {
    if (!SHA256_PATTERN.test(sha256)) {
      return false;
    }
    try {
      return (await stat(resolve(this.blobDirectory, sha256))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async sweep(): Promise<number> {
    const referenced = new Set<string>();
    for (const name of await listNames(this.sessionDirectory)) {
      const path = resolve(this.sessionDirectory, name);
      if (name.endsWith(TEMP_SUFFIX)) {
        // save 都已结束，残留的临时清单只可能来自崩溃。
        await rm(path, { force: true });
        continue;
      }
      if (!name.endsWith(".json")) {
        continue;
      }
      let manifest: BaselineManifest;
      try {
        manifest = parseManifest(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        if (error instanceof SyntaxError || error instanceof InvalidManifestError) {
          // 损坏的清单本身已无法读取（load 会报错），它引用的 blob 也就无从使用。
          continue;
        }
        throw error;
      }
      for (const entry of Object.values(manifest.files)) {
        if (entry.text) {
          referenced.add(entry.sha256);
        }
      }
    }
    let removed = 0;
    for (const name of await listNames(this.blobDirectory)) {
      const path = resolve(this.blobDirectory, name);
      if (name.endsWith(TEMP_SUFFIX)) {
        await rm(path, { force: true });
        continue;
      }
      if (SHA256_PATTERN.test(name) && !referenced.has(name)) {
        await rm(path, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private manifestPath(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("非法的会话 ID：" + JSON.stringify(sessionId));
    }
    return resolve(this.sessionDirectory, sessionId + ".json");
  }
}

class InvalidManifestError extends Error {}

function parseManifest(raw: string): BaselineManifest {
  const parsed = JSON.parse(raw) as Partial<BaselineManifest> | null;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.version !== BASELINE_MANIFEST_VERSION ||
    typeof parsed.capturedAt !== "number" ||
    parsed.files === null ||
    typeof parsed.files !== "object"
  ) {
    throw new InvalidManifestError("baseline manifest invalid");
  }
  return parsed as BaselineManifest;
}

async function listNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** 先写同目录临时文件再 rename：读者要么看到旧内容，要么看到完整新内容。 */
async function writeAtomic(
  path: string,
  content: Uint8Array | string,
): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
