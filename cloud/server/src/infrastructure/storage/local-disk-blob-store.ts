import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { ApplicationError } from "../../application/errors.js";
import type { BlobRange, BlobStore, StoredBlob } from "./blob-store.js";

const STORAGE_KEY = /^objects\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DISK_MARGIN_BYTES = 8 * 1024 * 1024;

/**
 * 本机磁盘驱动：`<根>/objects/<2 位>/<uuid>`，先写 `.staging/` 再 fsync + rename。
 * 根目录必须是 SuDuo 独占的（带所有权标记），与需求附件的根目录分开，
 * 各自的启动清理互不影响。启动时只清 `.staging/` 里的半截上传，不删任何对象。
 */
export class LocalDiskBlobStore implements BlobStore {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly objectsRoot: string;

  constructor(
    root: string,
    private readonly marker: { fileName: string; content: string },
  ) {
    this.root = resolve(root);
    this.stagingRoot = join(this.root, ".staging");
    this.objectsRoot = join(this.root, "objects");
  }

  async initialize(): Promise<void> {
    await ensureOwnedRoot(this.root, this.marker);
    await rm(this.stagingRoot, { recursive: true, force: true });
    await ensurePrivateDirectory(this.stagingRoot);
    await ensurePrivateDirectory(this.objectsRoot);
    await syncDirectory(this.root);
  }

  async put(input: {
    stream: AsyncIterable<Uint8Array | string>;
    maxBytes: number;
    declaredSize?: number;
  }): Promise<StoredBlob> {
    if (
      input.declaredSize !== undefined &&
      (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0 || input.declaredSize > input.maxBytes)
    ) {
      throw new ApplicationError(413, "ATTACHMENT_TOO_LARGE", "File exceeds the 300 MiB limit");
    }
    await this.assertDiskSpace(input.declaredSize ?? input.maxBytes);
    const id = randomUUID();
    const storageKey = `objects/${id.slice(0, 2)}/${id}`;
    const stagingPath = join(this.stagingRoot, randomUUID());
    const finalPath = this.pathFor(storageKey);
    await ensurePrivateDirectory(dirname(finalPath));
    const file = await open(stagingPath, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const value of input.stream) {
        const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
        sizeBytes += chunk.length;
        if (sizeBytes > input.maxBytes) {
          throw new ApplicationError(413, "ATTACHMENT_TOO_LARGE", "File exceeds the 300 MiB limit");
        }
        if (input.declaredSize !== undefined && sizeBytes > input.declaredSize) {
          throw new ApplicationError(400, "ATTACHMENT_INVALID", "File size does not match the declared size");
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await file.write(chunk, offset, chunk.length - offset, null);
          offset += written.bytesWritten;
        }
      }
      if (input.declaredSize !== undefined && sizeBytes !== input.declaredSize) {
        throw new ApplicationError(400, "ATTACHMENT_INVALID", "File size does not match the declared size");
      }
      await file.sync();
      await file.close();
      await rename(stagingPath, finalPath);
      await syncDirectory(dirname(finalPath));
      return { storageKey, sizeBytes, sha256: hash.digest("hex") };
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async open(storageKey: string, range?: BlobRange): Promise<Readable> {
    const path = await this.existingFile(storageKey);
    return range === undefined ? createReadStream(path) : createReadStream(path, { start: range.start, end: range.end });
  }

  async size(storageKey: string): Promise<number> {
    const path = await this.existingFile(storageKey);
    return (await lstat(path)).size;
  }

  private async existingFile(storageKey: string): Promise<string> {
    const path = this.pathFor(storageKey);
    let information;
    try {
      information = await lstat(path);
    } catch (error) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "File is temporarily unavailable", undefined, { cause: error });
    }
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "File is temporarily unavailable");
    }
    return path;
  }

  private pathFor(storageKey: string): string {
    if (!STORAGE_KEY.test(storageKey)) {
      throw new ApplicationError(500, "INTERNAL_ERROR", "Invalid file storage key");
    }
    const path = resolve(this.root, ...storageKey.split("/"));
    if (!path.startsWith(this.root + sep)) {
      throw new ApplicationError(500, "INTERNAL_ERROR", "File storage key is outside the storage root");
    }
    return path;
  }

  private async assertDiskSpace(requiredBytes: number): Promise<void> {
    let information;
    try {
      information = await statfs(this.root, { bigint: true });
    } catch (error) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "Unable to check disk space", undefined, { cause: error });
    }
    if (information.bavail * information.bsize < BigInt(requiredBytes + DISK_MARGIN_BYTES)) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "Not enough disk space for files");
    }
  }
}

async function ensureOwnedRoot(path: string, marker: { fileName: string; content: string }): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${path} is not a safe directory`);
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`${path} must not go through a symbolic link`);
  }
  const entries = await readdir(path);
  const markerPath = join(path, marker.fileName);
  if (!entries.includes(marker.fileName)) {
    if (entries.length !== 0) {
      throw new Error(`${path} is not empty and is missing the SuDuo ownership marker`);
    }
    const file = await open(markerPath, "wx", 0o600);
    try {
      await file.writeFile(marker.content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  } else if ((await readFile(markerPath, "utf8")) !== marker.content) {
    throw new Error(`${path} has an invalid SuDuo ownership marker`);
  }
  const allowed = new Set([marker.fileName, ".staging", "objects"]);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error(`${path} contains content not managed by SuDuo`);
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${path} is not a safe directory`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
