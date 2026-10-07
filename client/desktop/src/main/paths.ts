import { existsSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * 外壳用到的所有路径（技术设计 §二「数据与端口」「安装包内布局」）。纯函数：平台、环境变量与目录都从参数来，便于测试。
 *
 * 开发态（未打包）：本机服务用 client/server/dist、前端用 client/web/dist、Codex 用 client/node_modules 里锁定版本的 vendor 二进制，
 * Node 用启动开发脚本的那个（SUDUO_DESKTOP_NODE）；外壳数据默认放「SuDuo Desktop Dev」，不碰安装版的数据。
 */
export interface DesktopPathsInput {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  /** 打包后的 process.resourcesPath。 */
  resourcesPath: string;
  /** 外壳自身所在目录（开发态是 client/desktop，打包后是 app.asar）。 */
  appPath: string;
  codexVersion: string;
}

export interface DesktopPaths {
  /** 外壳数据目录（Electron userData）：偏好、窗口位置、网页缓存。 */
  shellDataDir: string;
  /** 本机服务数据目录（SUDUO_DATA_DIR）。 */
  dataDir: string;
  logDir: string;
  serverLog: string;
  desktopLog: string;
  pidFile: string;
  preferencesFile: string;
  /** 本机服务记下的界面语言（settings.json 旁边的 settings.locale.json）。 */
  storedLocaleFile: string;
  nodeBinary: string;
  serverMain: string;
  /** 自检命令（失败页「运行自检」）：程序与参数，参数里不含端口，由调用方追加。 */
  doctor: { command: string; args: string[] };
  /** 本机服务的工作目录。用数据目录：那里没有 node_modules，本机服务就不会去找工作区里的 Codex，而是用 SUDUO_CODEX_BIN。 */
  serverCwd: string;
  codexBin: string | null;
  startupPage: string;
  preload: string;
  assetsDir: string;
  /** 开发态的 client/ 根目录；打包后为 null。 */
  clientRoot: string | null;
}

export function resolveDesktopPaths(input: DesktopPathsInput): DesktopPaths {
  const path = input.platform === "win32" ? win32 : posix;
  const shellDataDir = input.env["SUDUO_DESKTOP_HOME"] || defaultShellDataDir(input);
  const dataDir = path.join(shellDataDir, "data");
  const logDir = path.join(dataDir, "logs");
  const exe = input.platform === "win32" ? ".exe" : "";
  const common = {
    shellDataDir,
    dataDir,
    logDir,
    serverLog: path.join(logDir, "suduo.log"),
    desktopLog: path.join(logDir, "desktop.log"),
    pidFile: path.join(dataDir, "suduo.pid"),
    preferencesFile: path.join(shellDataDir, "desktop.json"),
    storedLocaleFile: path.join(dataDir, "settings.locale.json"),
    serverCwd: dataDir,
    startupPage: path.join(input.appPath, "dist", "startup", "startup.html"),
    preload: path.join(input.appPath, "dist", "preload.cjs"),
    assetsDir: path.join(input.appPath, "assets"),
  };
  if (input.isPackaged) {
    const resources = input.resourcesPath;
    const nodeBinary = path.join(resources, "node", "node" + exe);
    const triple = codexTargetTriple(input.platform, input.arch);
    return {
      ...common,
      nodeBinary,
      // 不叫 resources/app：那是 Electron 自己找应用代码的位置。
      serverMain: path.join(resources, "suduo", "server", "dist", "main.mjs"),
      doctor: {
        command: nodeBinary,
        args: [path.join(resources, "suduo", "server", "dist", "doctor.mjs"), "--installed", "--allow-port-in-use"],
      },
      codexBin: triple === null ? null : path.join(resources, "codex", triple, "bin", "codex" + exe),
      clientRoot: null,
    };
  }
  const clientRoot = path.resolve(input.appPath, "..");
  const nodeBinary = input.env["SUDUO_DESKTOP_NODE"] || "node";
  return {
    ...common,
    nodeBinary,
    serverMain: path.join(clientRoot, "server", "dist", "main.js"),
    doctor: {
      command: nodeBinary,
      args: [
        path.join(clientRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(clientRoot, "scripts", "doctor.ts"),
        "--installed",
        "--allow-port-in-use",
      ],
    },
    codexBin: findWorkspaceCodex(clientRoot, input),
    clientRoot,
  };
}

function defaultShellDataDir(input: DesktopPathsInput): string {
  const name = input.isPackaged ? "SuDuo Desktop" : "SuDuo Desktop Dev";
  if (input.platform === "darwin") {
    return posix.join(input.homeDir, "Library", "Application Support", name);
  }
  if (input.platform === "win32") {
    // 本机目录而不是漫游目录（%APPDATA%）：域环境里漫游目录会随登录同步 SQLite。
    const local = input.env["LOCALAPPDATA"] || win32.join(input.homeDir, "AppData", "Local");
    return win32.join(local, name);
  }
  const config = input.env["XDG_CONFIG_HOME"] || posix.join(input.homeDir, ".config");
  return posix.join(config, input.isPackaged ? "suduo-desktop" : "suduo-desktop-dev");
}

/** Codex npm 平台包 vendor 目录下的目标三元组。 */
export function codexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  const key = `${platform}-${arch}`;
  const triples: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
  };
  return triples[key] ?? null;
}

/**
 * 开发态：client/node_modules/.pnpm/@openai+codex@<版本>-<平台>-<架构>/node_modules/@openai/codex/vendor/<三元组>/bin/codex。
 * 直接用二进制而不是 node_modules/.bin/codex：后者是要从 PATH 找 node 的包装脚本，而桌面模式不往 PATH 里放 node。
 */
function findWorkspaceCodex(clientRoot: string, input: DesktopPathsInput): string | null {
  const path = input.platform === "win32" ? win32 : posix;
  const triple = codexTargetTriple(input.platform, input.arch);
  if (triple === null) return null;
  const exe = input.platform === "win32" ? ".exe" : "";
  const store = path.join(clientRoot, "node_modules", ".pnpm");
  const prefix = `@openai+codex@${input.codexVersion}-${input.platform}-${input.arch}`;
  try {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith(prefix)) continue;
      const candidate = path.join(store, entry, "node_modules", "@openai", "codex", "vendor", triple, "bin", "codex" + exe);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // 还没装依赖。
  }
  return null;
}
