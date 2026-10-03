import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "CODEX_HOME",
  "SUDUO_CODEX_BIN",
  "SUDUO_CODEX_DEFAULTS",
  "SUDUO_CODEX_HOME",
  "SUDUO_CODEX_TRANSPORT",
  "SUDUO_CODEX_VERSION",
  "SUDUO_DATA_DIR",
  "SUDUO_DB_PATH",
  "SUDUO_FS_FORCE_POLLING",
  "SUDUO_FS_POLL_INTERVAL_MS",
  "SUDUO_FS_WATCH_DEBOUNCE_MS",
  "SUDUO_GLOBAL_SKILLS",
  "SUDUO_HOST",
  "SUDUO_IDLE_EXIT_MS",
  "SUDUO_LOG_LEVEL",
  "SUDUO_PID_FILE",
  "SUDUO_PORT",
  "SUDUO_REQUIREMENTS_SERVICE_URL",
  "SUDUO_RUNTIME_RESTART_MAX_MS",
  "SUDUO_SSE_HEARTBEAT_MS",
  "SUDUO_SSE_REPLAY_PAGE_SIZE",
  "SUDUO_V2_DATA_DIR",
]);

const PATH_KEYS = new Set([
  "CODEX_HOME",
  "SUDUO_CODEX_BIN",
  "SUDUO_CODEX_DEFAULTS",
  "SUDUO_CODEX_HOME",
  "SUDUO_DATA_DIR",
  "SUDUO_DB_PATH",
  "SUDUO_PID_FILE",
  "SUDUO_V2_DATA_DIR",
]);

interface RuntimeConfigFile {
  schemaVersion: 1;
  environment: Record<string, string>;
}

export interface AppliedRuntimeConfig {
  configPath: string;
  installRoot: string;
}

export function applyRuntimeConfigFromArgs(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AppliedRuntimeConfig | null {
  const index = args.indexOf("--runtime-config");
  if (index < 0) {
    return null;
  }
  const rawPath = args[index + 1];
  if (!rawPath) {
    throw new Error("--runtime-config 必须提供配置文件路径");
  }
  const configPath = resolve(cwd, rawPath);
  const installRoot = resolve(dirname(configPath), "..");
  const parsed = parseRuntimeConfig(readFileSync(configPath, "utf8"));
  for (const [key, rawValue] of Object.entries(parsed.environment)) {
    if (!ALLOWED_ENVIRONMENT_KEYS.has(key)) {
      throw new Error("runtime config 包含不允许的环境项: " + key);
    }
    const value = PATH_KEYS.has(key)
      ? resolveInstalledPath(installRoot, rawValue, key)
      : rawValue;
    if (environment[key] === undefined) {
      environment[key] = value;
    }
  }
  return { configPath, installRoot };
}

function parseRuntimeConfig(text: string): RuntimeConfigFile {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime config 必须是 JSON object");
  }
  const candidate = value as Partial<RuntimeConfigFile>;
  if (candidate.schemaVersion !== 1) {
    throw new Error("runtime config schemaVersion 必须为 1");
  }
  if (
    !candidate.environment ||
    typeof candidate.environment !== "object" ||
    Array.isArray(candidate.environment)
  ) {
    throw new Error("runtime config environment 必须是 object");
  }
  for (const [key, item] of Object.entries(candidate.environment)) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("runtime config 环境项必须是非空字符串: " + key);
    }
  }
  return candidate as RuntimeConfigFile;
}

function resolveInstalledPath(
  installRoot: string,
  value: string,
  key: string,
): string {
  if (isAbsolute(value)) {
    throw new Error(key + " 必须是相对安装目录的路径");
  }
  const absolute = resolve(installRoot, value);
  const remainder = relative(installRoot, absolute);
  if (remainder === ".." || remainder.startsWith("..\\") || remainder.startsWith("../")) {
    throw new Error(key + " 不得越出安装目录");
  }
  return absolute;
}
