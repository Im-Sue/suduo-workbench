import { isAbsolute, relative, resolve } from "node:path";
import {
  REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
} from "@suduo/cloud-contracts";
import { DEFAULT_ROOM_FILE_EXTENSIONS } from "./application/rooms/file-types.js";
import { resolveServiceVersion } from "./version.js";

const MAX_ATTACHMENT_BYTES = 314_572_800;

export interface RequirementsServiceConfig {
  host: string;
  port: number;
  databaseUrl: string;
  databasePoolMax: number;
  databaseConnectionTimeoutMs: number;
  authSecret: string;
  authTtlSeconds: number;
  authIssuer: string;
  authAudience: string;
  attachmentRoot: string;
  maxAttachmentBytes: number;
  maxAttachmentsPerRequirement: number;
  allowedAttachmentExtensions: ReadonlySet<string>;
  /**
   * 房间文件根目录（绝对路径，SuDuo 独占，与附件根目录分开）。
   * 可选只为兼容直接构造配置的旧测试；`loadConfig` 总会给出，缺省为 `<附件根目录>-rooms`。
   */
  roomFileRoot?: string;
  /** 房间文件允许的扩展名；缺省为常见图片 / 文档 / 压缩包 / 视频。 */
  allowedRoomFileExtensions?: ReadonlySet<string>;
  runMigrations: boolean;
  logger: boolean;
  /** 产品版本，健康检查对外报告；直接构造配置的测试可不传，按 "dev" 处理。 */
  version?: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RequirementsServiceConfig {
  const databaseUrl = required(environment, "REQUIREMENTS_DATABASE_URL");
  const authSecret = required(environment, "REQUIREMENTS_AUTH_SECRET");
  const attachmentRoot = required(environment, "REQUIREMENTS_ATTACHMENT_ROOT");
  if (!isAbsolute(attachmentRoot)) {
    throw new Error("REQUIREMENTS_ATTACHMENT_ROOT must be an absolute path");
  }
  const roomFileRoot = environment["REQUIREMENTS_ROOM_FILE_ROOT"]?.trim() || defaultRoomFileRoot(attachmentRoot);
  if (!isAbsolute(roomFileRoot)) {
    throw new Error("REQUIREMENTS_ROOM_FILE_ROOT must be an absolute path");
  }
  if (overlaps(roomFileRoot, attachmentRoot)) {
    throw new Error("REQUIREMENTS_ROOM_FILE_ROOT and REQUIREMENTS_ATTACHMENT_ROOT must not be the same directory or contain each other");
  }
  if (authSecret.length < 32) {
    throw new Error("REQUIREMENTS_AUTH_SECRET must be at least 32 characters");
  }

  return {
    host: environment["REQUIREMENTS_HOST"]?.trim() || "0.0.0.0",
    port: integer(environment, "REQUIREMENTS_PORT", 4100, 1, 65_535),
    databaseUrl,
    databasePoolMax: integer(
      environment,
      "REQUIREMENTS_DATABASE_POOL_MAX",
      10,
      2,
      100,
    ),
    databaseConnectionTimeoutMs: integer(
      environment,
      "REQUIREMENTS_DATABASE_CONNECTION_TIMEOUT_MS",
      5_000,
      100,
      60_000,
    ),
    authSecret,
    authTtlSeconds: durationSeconds(
      environment["REQUIREMENTS_AUTH_TTL"] ?? "8h",
    ),
    authIssuer:
      environment["REQUIREMENTS_AUTH_ISSUER"]?.trim() ||
      "suduo-requirements-service",
    authAudience:
      environment["REQUIREMENTS_AUTH_AUDIENCE"]?.trim() ||
      "suduo-local-bff",
    attachmentRoot,
    maxAttachmentBytes: integer(
      environment,
      "REQUIREMENTS_MAX_ATTACHMENT_BYTES",
      MAX_ATTACHMENT_BYTES,
      MAX_ATTACHMENT_BYTES,
      MAX_ATTACHMENT_BYTES,
    ),
    maxAttachmentsPerRequirement: integer(
      environment,
      "REQUIREMENTS_MAX_ATTACHMENTS_PER_REQUIREMENT",
      REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
      1,
      REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT,
    ),
    allowedAttachmentExtensions: attachmentExtensions(
      environment["REQUIREMENTS_ALLOWED_ATTACHMENT_EXTENSIONS"],
    ),
    roomFileRoot,
    allowedRoomFileExtensions: extensionSet(
      environment["REQUIREMENTS_ALLOWED_ROOM_FILE_EXTENSIONS"],
      DEFAULT_ROOM_FILE_EXTENSIONS,
      "REQUIREMENTS_ALLOWED_ROOM_FILE_EXTENSIONS",
    ),
    runMigrations: boolean(environment, "REQUIREMENTS_RUN_MIGRATIONS", true),
    logger: boolean(environment, "REQUIREMENTS_LOGGER", true),
    version: resolveServiceVersion(environment),
  };
}

const DEFAULT_ATTACHMENT_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".zip",
  ".html",
  ".htm",
  ".svg",
] as const;

function attachmentExtensions(raw: string | undefined): ReadonlySet<string> {
  return extensionSet(raw, DEFAULT_ATTACHMENT_EXTENSIONS, "REQUIREMENTS_ALLOWED_ATTACHMENT_EXTENSIONS");
}

function extensionSet(
  raw: string | undefined,
  defaults: readonly string[],
  name: string,
): ReadonlySet<string> {
  const values = raw === undefined || raw.trim() === ""
    ? defaults
    : raw.split(",").map((value) => value.trim().toLowerCase());
  const normalized = new Set<string>();
  for (const value of values) {
    const extension = value.startsWith(".") ? value : `.${value}`;
    if (!/^\.[a-z0-9]{1,12}$/u.test(extension)) {
      throw new Error(`${name} contains an invalid extension`);
    }
    normalized.add(extension);
  }
  if (normalized.size === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return normalized;
}

/** 缺省房间文件根目录：附件根目录同级的 `<附件根>-rooms`。 */
export function defaultRoomFileRoot(attachmentRoot: string): string {
  return `${resolve(attachmentRoot)}-rooms`;
}

function overlaps(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  const inside = (child: string, parent: string) => {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  return inside(a, b) || inside(b, a);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function durationSeconds(raw: string): number {
  const matched = /^(\d+)([smhd]?)$/.exec(raw.trim());
  if (!matched) {
    throw new Error("REQUIREMENTS_AUTH_TTL must be a number of seconds or a duration such as 30m, 8h, or 7d");
  }
  const amount = Number(matched[1]);
  const unit = matched[2] ?? "";
  const multiplier =
    unit === "m" ? 60 : unit === "h" ? 3_600 : unit === "d" ? 86_400 : 1;
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 2_592_000) {
    throw new Error("REQUIREMENTS_AUTH_TTL must be between 60 seconds and 30 days");
  }
  return seconds;
}
