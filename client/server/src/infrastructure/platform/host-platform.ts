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
    return win32.resolve(
      env["LOCALAPPDATA"] ??
        env["APPDATA"] ??
        win32.resolve(home, "AppData", "Local"),
      "SuDuo",
    );
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
  return posix.resolve(
    env["XDG_CONFIG_HOME"] ?? posix.resolve(home, ".config"),
    "suduo",
  );
}
