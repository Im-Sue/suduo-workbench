import { cliLocale } from "@suduo/client-contracts";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { messagesFor } from "../../i18n/messages/index.js";

export function readPrivateJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  repairPrivateFile(filePath);
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    // 不带请求语言，按这个进程的系统语言（中英双语 S8；见 settings-store.ts 的 cliText）。
    throw new Error(messagesFor(cliLocale(process.env)).cli.privateJsonUnreadable, { cause: error });
  }
}

export function writePrivateJson(filePath: string, payload: unknown): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  repairPrivateDirectory(directory);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    repairPrivateFile(temporaryPath);
    renameSync(temporaryPath, filePath);
    repairPrivateFile(filePath);
    syncDirectory(directory);
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 临时文件可能尚未创建或已经完成原子替换。
    }
    throw error;
  }
}

export function removePrivateFile(filePath: string): void {
  try {
    unlinkSync(filePath);
    syncDirectory(dirname(filePath));
  } catch (error) {
    if (!isFileMissing(error)) {
      throw error;
    }
  }
}

export function repairPrivateDirectory(path: string): void {
  if (process.platform === "win32") {
    return;
  }
  chmodSync(path, 0o700);
}

export function repairPrivateFile(path: string): void {
  if (process.platform === "win32") {
    repairWindowsAcl(path);
    return;
  }
  chmodSync(path, 0o600);
}

function repairWindowsAcl(path: string): void {
  const username = process.env["USERNAME"]?.trim();
  if (!username) {
    return;
  }
  const domain = process.env["USERDOMAIN"]?.trim();
  const identity = domain ? `${domain}\\${username}` : username;
  spawnSync(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", `${identity}:(F)`, "/C", "/Q"],
    { windowsHide: true, stdio: "ignore" },
  );
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") {
    return;
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // 文件本身已 fsync；少数文件系统不支持目录 fsync 时尽力而为。
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
}

function isFileMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
