import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ResolveExecutableOptions {
  /** 用户在设置里填的路径覆盖；填了就只认它。 */
  override?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** 测试用：替换「这个路径是不是可执行文件」的判断。 */
  isExecutable?: (candidate: string) => boolean;
}

/**
 * 找 Agent 的可执行文件。桌面应用从图形界面启动时 PATH 往往不全（没有 nvm、mise、Homebrew 的目录），
 * 所以在 PATH 之后再查常见的安装目录（参照 Tutti 的解析顺序）。找不到返回 null。
 */
export function resolveExecutable(names: readonly string[], options: ResolveExecutableOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const isExecutable = options.isExecutable ?? defaultIsExecutable(platform);
  const override = options.override?.trim();
  if (override) {
    return isExecutable(override) ? override : null;
  }
  const extensions = platform === "win32" ? windowsExtensions(env) : [""];
  const pathSeparator = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const dirs = uniqueDirs([
    ...(env["PATH"] ?? env["Path"] ?? "").split(pathSeparator),
    ...fallbackDirs(platform, home, env),
  ]);
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = join(dir, name + ext);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

function fallbackDirs(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const appData = env["APPDATA"];
    const localAppData = env["LOCALAPPDATA"];
    return [
      ...(appData ? [path.win32.join(appData, "npm")] : []),
      ...(localAppData ? [path.win32.join(localAppData, "Programs")] : []),
      path.win32.join(home, ".local", "bin"),
      path.win32.join(home, ".bun", "bin"),
      path.win32.join(home, ".volta", "bin"),
    ];
  }
  return [
    path.posix.join(home, ".local", "bin"),
    path.posix.join(home, ".npm-global", "bin"),
    path.posix.join(home, ".bun", "bin"),
    path.posix.join(home, ".volta", "bin"),
    path.posix.join(home, ".local", "share", "mise", "shims"),
    path.posix.join(home, ".asdf", "shims"),
    path.posix.join(home, ".opencode", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  // npm 在 Windows 上装的是 .cmd 包装；优先 .cmd，不选无扩展名的 POSIX shim（参照 Tutti）。
  const declared = (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.toLowerCase())
    .filter((ext) => ext !== "");
  const ordered = [".cmd", ".exe", ...declared.filter((ext) => ext !== ".cmd" && ext !== ".exe")];
  return [...new Set(ordered)];
}

function uniqueDirs(dirs: string[]): string[] {
  return [...new Set(dirs.map((dir) => dir.trim()).filter((dir) => dir !== ""))];
}

function defaultIsExecutable(platform: NodeJS.Platform): (candidate: string) => boolean {
  return (candidate) => {
    try {
      if (!statSync(candidate).isFile()) {
        return false;
      }
      if (platform !== "win32") {
        accessSync(candidate, constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  };
}
