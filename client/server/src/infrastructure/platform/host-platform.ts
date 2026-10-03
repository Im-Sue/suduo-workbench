import { existsSync, mkdirSync } from "node:fs";
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
    // 源码运行的位置。Windows 安装器版另用安装目录下的 data\（显式设置 SUDUO_DATA_DIR），两者不共用；
    // 卸载安装器时只删它自己的子目录，不会碰到这里的数据。
    return win32.resolve(
      env["LOCALAPPDATA"] ??
        env["APPDATA"] ??
        win32.resolve(home, "AppData", "Local"),
      "SuDuo",
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

/**
 * 决定 SuDuo 交给 Codex 的 CODEX_HOME：显式指定（SUDUO_CODEX_HOME / CODEX_HOME）优先，否则用 ~/.codex。
 * Codex 收到不存在的 CODEX_HOME 会直接退出，所以默认目录不存在时先建好（Codex 自己也会建）；
 * 显式指定的目录不存在时不替用户建，免得掩盖拼写错误，由调用方提示。
 */
export function prepareCodexHome(
  explicit: string | undefined,
  options: HostPlatformOptions = {},
): { path: string; isDefault: boolean; exists: boolean } {
  if (explicit !== undefined && explicit !== "") {
    return { path: explicit, isDefault: false, exists: existsSync(explicit) };
  }
  const path = defaultCodexHome(options);
  mkdirSync(path, { recursive: true });
  return { path, isDefault: true, exists: true };
}
