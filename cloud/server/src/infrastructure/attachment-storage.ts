import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { ApplicationError } from "../application/errors.js";

const STORAGE_KEY = /^objects\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STAGING_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DISK_MARGIN_BYTES = 8 * 1024 * 1024;
const ROOT_MARKER = ".suduo-attachments-v1";
const ROOT_MARKER_CONTENT = "suduo-requirements-attachments-v1\n";

export interface StoredAttachment {
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export class AttachmentStorage {
  private readonly root: string;
  private readonly stagingRoot: string;
  private readonly objectsRoot: string;

  constructor(
    root: string,
    private readonly maxBytes: number,
    private readonly allowedExtensions: ReadonlySet<string>,
  ) {
    this.root = resolve(root);
    this.stagingRoot = join(this.root, ".staging");
    this.objectsRoot = join(this.root, "objects");
  }

  async initialize(): Promise<void> {
    await ensureOwnedRoot(this.root);
    await ensurePrivateDirectory(this.stagingRoot);
    await ensurePrivateDirectory(this.objectsRoot);
    await syncDirectory(this.root);
  }

  async reconcile(activeStorageKeys: ReadonlySet<string>): Promise<void> {
    await rm(this.stagingRoot, { recursive: true, force: true });
    await ensurePrivateDirectory(this.stagingRoot);
    for (const prefix of await readdir(this.objectsRoot, { withFileTypes: true })) {
      const prefixPath = join(this.objectsRoot, prefix.name);
      if (!prefix.isDirectory() || prefix.isSymbolicLink()) {
        await rm(prefixPath, { recursive: true, force: true });
        continue;
      }
      for (const entry of await readdir(prefixPath, { withFileTypes: true })) {
        const key = `objects/${prefix.name}/${entry.name}`;
        const path = join(prefixPath, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink() || !activeStorageKeys.has(key)) {
          await rm(path, { recursive: true, force: true });
        }
      }
      await rm(prefixPath, { recursive: false }).catch(() => undefined);
    }
    await syncDirectory(this.objectsRoot);
  }

  async store(input: {
    stream: AsyncIterable<Uint8Array | string>;
    fileName: string;
    contentType: string;
    declaredSize?: number;
  }): Promise<StoredAttachment> {
    const fileName = safeFileName(input.fileName);
    const extension = extname(fileName).toLowerCase();
    if (!this.allowedExtensions.has(extension)) {
      throw new ApplicationError(400, "ATTACHMENT_INVALID", "附件类型不在允许范围内", {
        extension,
      });
    }
    if (
      input.declaredSize !== undefined &&
      (!Number.isSafeInteger(input.declaredSize) ||
        input.declaredSize < 0 ||
        input.declaredSize > this.maxBytes)
    ) {
      throw new ApplicationError(413, "ATTACHMENT_TOO_LARGE", "附件超过 300 MiB 上限");
    }
    await this.assertDiskSpace(input.declaredSize ?? this.maxBytes);

    const id = randomUUID();
    const storageKey = `objects/${id.slice(0, 2)}/${id}`;
    const stagingPath = join(this.stagingRoot, randomUUID());
    const finalPath = this.pathFor(storageKey);
    const finalDirectory = dirname(finalPath);
    await ensurePrivateDirectory(finalDirectory);
    await syncDirectory(this.objectsRoot);
    const file = await open(stagingPath, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const value of input.stream) {
        const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
        sizeBytes += chunk.length;
        if (input.declaredSize !== undefined && sizeBytes > input.declaredSize) {
          throw new ApplicationError(400, "ATTACHMENT_INVALID", "附件声明大小与实际大小不一致");
        }
        if (sizeBytes > this.maxBytes) {
          throw new ApplicationError(413, "ATTACHMENT_TOO_LARGE", "附件超过 300 MiB 上限");
        }
        hash.update(chunk);
        await writeAll(file, chunk);
      }
      if (input.declaredSize !== undefined && sizeBytes !== input.declaredSize) {
        throw new ApplicationError(400, "ATTACHMENT_INVALID", "附件声明大小与实际大小不一致");
      }
      await file.sync();
      await file.close();
      await rename(stagingPath, finalPath);
      await syncDirectory(finalDirectory);
      return {
        storageKey,
        fileName,
        contentType: safeContentType(input.contentType),
        sizeBytes,
        sha256: hash.digest("hex"),
      };
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async open(storageKey: string): Promise<Readable> {
    const path = this.pathFor(storageKey);
    let information;
    try {
      information = await lstat(path);
    } catch (error) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "附件文件暂时不可用", undefined, {
        cause: error,
      });
    }
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "附件文件暂时不可用");
    }
    return createReadStream(path);
  }

  async remove(storageKey: string): Promise<void> {
    const path = this.pathFor(storageKey);
    try {
      await unlink(path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }

  private pathFor(storageKey: string): string {
    if (!STORAGE_KEY.test(storageKey)) {
      throw new ApplicationError(500, "INTERNAL_ERROR", "附件存储键无效");
    }
    const path = resolve(this.root, ...storageKey.split("/"));
    if (!path.startsWith(this.root + sep)) {
      throw new ApplicationError(500, "INTERNAL_ERROR", "附件存储键越界");
    }
    return path;
  }

  private async assertDiskSpace(requiredBytes: number): Promise<void> {
    let information;
    try {
      information = await statfs(this.root, { bigint: true });
    } catch (error) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "无法检查附件磁盘空间", undefined, {
        cause: error,
      });
    }
    const available = information.bavail * information.bsize;
    const required = BigInt(requiredBytes + DISK_MARGIN_BYTES);
    if (available < required) {
      throw new ApplicationError(503, "DEPENDENCY_UNAVAILABLE", "附件磁盘空间不足");
    }
  }
}

async function ensureOwnedRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${path} 不是安全目录`);
  }
  const actualRoot = await realpath(path);
  if (actualRoot !== path) {
    throw new Error("REQUIREMENTS_ATTACHMENT_ROOT 不能经过符号链接");
  }
  const entries = await readdir(path);
  const markerPath = join(path, ROOT_MARKER);
  if (!entries.includes(ROOT_MARKER)) {
    if (entries.length !== 0 && !await isLegacyOwnedRoot(path, entries)) {
      throw new Error("REQUIREMENTS_ATTACHMENT_ROOT 非空且缺少 SuDuo 所有权标记");
    }
    const marker = await open(markerPath, "wx", 0o600);
    try {
      await marker.writeFile(ROOT_MARKER_CONTENT, "utf8");
      await marker.sync();
    } finally {
      await marker.close();
    }
    await syncDirectory(path);
  } else {
    const markerInformation = await lstat(markerPath);
    if (
      !markerInformation.isFile() ||
      markerInformation.isSymbolicLink() ||
      await readFile(markerPath, "utf8") !== ROOT_MARKER_CONTENT
    ) {
      throw new Error("REQUIREMENTS_ATTACHMENT_ROOT 的 SuDuo 所有权标记无效");
    }
  }
  const allowed = new Set([ROOT_MARKER, ".staging", "objects"]);
  if (entries.some((entry) => !allowed.has(entry))) {
    throw new Error("REQUIREMENTS_ATTACHMENT_ROOT 包含非 SuDuo 管理内容");
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function isLegacyOwnedRoot(path: string, entries: string[]): Promise<boolean> {
  if (entries.some((entry) => entry !== ".staging" && entry !== "objects")) return false;
  if (!entries.includes(".staging") || !entries.includes("objects")) return false;
  for (const name of entries) {
    const rootEntry = join(path, name);
    const rootInformation = await lstat(rootEntry);
    if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) return false;
  }
  for (const entry of await readdir(join(path, ".staging"), { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !STAGING_FILE.test(entry.name)) return false;
  }
  const objectsRoot = join(path, "objects");
  for (const prefix of await readdir(objectsRoot, { withFileTypes: true })) {
    if (
      !/^[0-9a-f]{2}$/u.test(prefix.name) ||
      !prefix.isDirectory() ||
      prefix.isSymbolicLink()
    ) return false;
    for (const entry of await readdir(join(objectsRoot, prefix.name), { withFileTypes: true })) {
      const key = `objects/${prefix.name}/${entry.name}`;
      if (!entry.isFile() || entry.isSymbolicLink() || !STORAGE_KEY.test(key)) return false;
    }
  }
  return true;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${path} 不是安全目录`);
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await file.write(buffer, offset, buffer.length - offset, null);
    offset += result.bytesWritten;
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

function safeFileName(input: string): string {
  const leaf = basename(input.replaceAll("\\", "/"))
    .normalize("NFC");
  const normalized = stripControls(leaf).trim();
  const value = Array.from(normalized).slice(0, 200).join("");
  if (!value || value === "." || value === "..") {
    throw new ApplicationError(400, "ATTACHMENT_INVALID", "附件文件名无效");
  }
  return value;
}

function safeContentType(input: string): string {
  const value = stripControls(input).trim().slice(0, 255);
  return value || "application/octet-stream";
}

function stripControls(input: string): string {
  return Array.from(input)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("");
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
