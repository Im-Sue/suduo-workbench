/**
 * 交给本机服务的环境变量（技术设计 §4.1「拉起」）。本机服务启动的 Codex、Codex 在使用者项目里执行的命令都继承这份环境，
 * 所以它既要有使用者终端里的 PATH，又不能带进 SuDuo 自己的东西。
 */
export interface ServerEnvironmentInput {
  /** 外壳自身的环境（process.env）。 */
  base: Record<string, string | undefined>;
  /** 登录 shell 的环境（Mac 从访达启动时）；没读到为 null。 */
  shell: Record<string, string> | null;
  platform: NodeJS.Platform;
  port: number;
  dataDir: string;
  pidFile: string;
  instanceId: string;
  codexBin: string | null;
}

/** 使用者可以有意设置、安装版照样尊重的 SUDUO_*：自定义 Codex 配置目录、命令行语言。其余 SUDUO_* 由外壳决定。 */
const PASS_THROUGH_SUDUO_KEYS = new Set(["SUDUO_CODEX_HOME", "SUDUO_LOCALE"]);

/** 从访达启动、又没读到登录 shell 环境时，补在 PATH 末尾的常见目录。 */
const MAC_FALLBACK_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"];

export function buildServerEnvironment(input: ServerEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const source of [input.base, input.shell ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (isDropped(key)) continue;
      // Windows 的环境变量名不分大小写：shell 那份没有（只在 Mac 读），这里只需防同名不同写法重复。
      env[existingKey(env, key, input.platform)] = value;
    }
  }
  const pathKey = existingKey(env, "PATH", input.platform);
  env[pathKey] = cleanPath(env[pathKey] ?? "", input);
  env["SUDUO_RUN_MODE"] = "desktop";
  env["SUDUO_INSTANCE_ID"] = input.instanceId;
  env["SUDUO_HOST"] = "127.0.0.1";
  env["SUDUO_PORT"] = String(input.port);
  env["SUDUO_DATA_DIR"] = input.dataDir;
  env["SUDUO_PID_FILE"] = input.pidFile;
  // 外壳管着服务的生死，不让它自己空闲退出。
  env["SUDUO_IDLE_EXIT_MS"] = "0";
  env["SUDUO_LOG_LEVEL"] = "info";
  if (input.codexBin !== null) env["SUDUO_CODEX_BIN"] = input.codexBin;
  return env;
}

function isDropped(key: string): boolean {
  // 开发态经 pnpm 启动时注入的变量：一路传给 Codex 会话会在使用者项目里调到 SuDuo 自带的工具（与 scripts/start.mjs 一致）。
  if (/^(npm_|pnpm_)/i.test(key) || key === "INIT_CWD") return true;
  // Electron 自己的开关不能漏给子进程（例如 ELECTRON_RUN_AS_NODE 会让子进程里的 Electron 变成 node）。
  if (/^ELECTRON_/i.test(key)) return true;
  if (/^SUDUO_/i.test(key) && !PASS_THROUGH_SUDUO_KEYS.has(key.toUpperCase())) return true;
  return false;
}

function existingKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return key;
  return Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase()) ?? key;
}

function cleanPath(value: string, input: ServerEnvironmentInput): string {
  const delimiter = input.platform === "win32" ? ";" : ":";
  const entries = value
    .split(delimiter)
    .filter((entry) => entry !== "" && !/[\\/]node_modules[\\/]\.bin$/i.test(entry) && !/node-gyp-bin$/i.test(entry));
  if (input.platform === "darwin" && input.shell === null) {
    for (const fallback of MAC_FALLBACK_PATHS) {
      if (!entries.includes(fallback)) entries.push(fallback);
    }
  }
  const unique = entries.filter((entry, index) => entries.indexOf(entry) === index);
  return unique.join(delimiter);
}
