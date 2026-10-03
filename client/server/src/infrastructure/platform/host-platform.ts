import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface HostPlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function defaultSuDuoDataDir(
  options: HostPlatformOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  if (platform === "win32") {
    // 与 Windows 安装器版同一个位置（安装目录 %LOCALAPPDATA%\SuDuo 下的 data\），两种运行方式共用一份本机数据。
    return win32.resolve(
      env["LOCALAPPDATA"] ??
        env["APPDATA"] ??
        win32.resolve(home, "AppData", "Local"),
      "SuDuo",
      "data",
    );
  }
  if (platform === "darwin") {
    return posix.resolve(home, "Library", "Application Support", "SuDuo");
  }
  return posix.resolve(
    env["XDG_DATA_HOME"] ?? posix.resolve(home, ".local", "share"),
    "suduo",
  );
}

export function defaultSuDuoConfigDir(
  options: HostPlatformOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  if (platform === "win32") {
    return win32.resolve(
      env["APPDATA"] ?? win32.resolve(home, "AppData", "Roaming"),
      "SuDuo",
    );
  }
  if (platform === "darwin") {
    return posix.resolve(home, "Library", "Application Support", "SuDuo");
  }
  return posix.resolve(
    env["XDG_CONFIG_HOME"] ?? posix.resolve(home, ".config"),
    "suduo",
  );
}

/**
 * 没有显式指定 CODEX_HOME 时 Codex 自己用的目录（~/.codex）。从源码运行的使用者在这里配置模型账号，
 * SuDuo 必须用同一个目录，不能另起一个空目录。
 */
export function defaultCodexHome(options: HostPlatformOptions = {}): string {
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  return platform === "win32" ? win32.resolve(home, ".codex") : posix.resolve(home, ".codex");
}
