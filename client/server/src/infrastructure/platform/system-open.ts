import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 打开目标（参考 codex 桌面 App 的「打开位置」交互）：
 * open=系统默认应用；reveal=文件管理器定位；vscode=VS Code；terminal=终端。
 */
export type SystemOpenMode = "open" | "reveal" | "vscode" | "terminal";

export interface OpenCommand {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * 计算打开命令（纯函数，便于单测）。
 * - win32：explorer 直开/定位；vscode 经 cmd /c（code 是 .cmd）；终端用 start 继承 cwd。
 * - WSL：路径须先经 wslpath -w 转换（由调用方完成）。
 * - linux：xdg-open / code / 常见终端仿真器。
 */
export function buildOpenCommand(input: {
  platform: NodeJS.Platform;
  wsl: boolean;
  mode: SystemOpenMode;
  path: string;
  /** terminal 模式的工作目录（已按文件/目录归一为目录）。 */
  directory?: string;
  /** linux 桌面探测到的终端程序。 */
  linuxTerminal?: string;
  /** vscode：打开后跳到这一行。 */
  line?: number;
}): OpenCommand {
  const { platform, wsl, mode, path } = input;
  const directory = input.directory ?? path;
  const windowsLike = platform === "win32" || (platform === "linux" && wsl);

  if (mode === "vscode") {
    // `code -g 文件:行` 打开并跳到行。
    const target = input.line === undefined ? [path] : ["-g", `${path}:${input.line}`];
    if (platform === "win32") {
      return { command: "cmd", args: ["/c", "code", ...target] };
    }
    return { command: "code", args: target };
  }
  if (mode === "terminal") {
    if (platform === "win32") {
      // start 继承 cwd，规避 Windows 参数引号地狱。
      return { command: "cmd", args: ["/c", "start", "", "cmd"], cwd: directory };
    }
    if (platform === "linux" && wsl) {
      return { command: "wt.exe", args: ["-d", directory] };
    }
    if (platform === "darwin") {
      return { command: "open", args: ["-a", "Terminal", directory] };
    }
    const terminal = input.linuxTerminal ?? "x-terminal-emulator";
    if (terminal === "gnome-terminal") {
      return { command: terminal, args: [`--working-directory=${directory}`] };
    }
    if (terminal === "konsole") {
      return { command: terminal, args: ["--workdir", directory] };
    }
    return { command: terminal, args: [], cwd: directory };
  }
  if (windowsLike) {
    return mode === "reveal"
      ? { command: "explorer.exe", args: ["/select," + path] }
      : { command: "explorer.exe", args: [path] };
  }
  if (platform === "darwin") {
    return mode === "reveal"
      ? { command: "open", args: ["-R", path] }
      : { command: "open", args: [path] };
  }
  return mode === "reveal"
    ? { command: "xdg-open", args: [dirname(path)] }
    : { command: "xdg-open", args: [path] };
}

export function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

let cachedTargets: SystemOpenMode[] | null = null;
let cachedLinuxTerminal: string | null = null;

/** 探测本机可用的打开目标（结果缓存）。open/reveal 视为恒可用。 */
export async function detectOpenTargets(): Promise<SystemOpenMode[]> {
  if (cachedTargets) {
    return cachedTargets;
  }
  const targets: SystemOpenMode[] = ["open", "reveal"];
  if (await commandExists("code")) {
    targets.push("vscode");
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    targets.push("terminal");
  } else if (isWsl()) {
    if (await commandExists("wt.exe")) {
      targets.push("terminal");
    }
  } else {
    for (const candidate of ["gnome-terminal", "konsole", "x-terminal-emulator", "xterm"]) {
      if (await commandExists(candidate)) {
        cachedLinuxTerminal = candidate;
        targets.push("terminal");
        break;
      }
    }
  }
  cachedTargets = targets;
  return targets;
}

async function commandExists(name: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  return execFileAsync(probe, [name], { windowsHide: true })
    .then(() => true)
    .catch(() => false);
}

/** 把绝对路径按当前平台交给对应目标（detached，不等待应用退出）。 */
export async function openWithSystemApp(
  absolutePath: string,
  mode: SystemOpenMode,
  line?: number,
): Promise<void> {
  const wsl = isWsl();
  const info = await stat(absolutePath).catch(() => null);
  const localDirectory =
    info?.isDirectory() === true ? absolutePath : dirname(absolutePath);

  let path = absolutePath;
  let directory = localDirectory;
  if (wsl && mode !== "vscode") {
    // WSL 里 VS Code 走 code shim 用 linux 路径；其余目标交给 Windows 侧程序。
    path = await toWindowsPath(absolutePath);
    directory = await toWindowsPath(localDirectory);
  }
  const { command, args, cwd } = buildOpenCommand({
    platform: process.platform,
    wsl,
    mode,
    path,
    directory,
    ...(cachedLinuxTerminal === null ? {} : { linuxTerminal: cachedLinuxTerminal }),
    ...(line === undefined ? {} : { line }),
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      ...(cwd === undefined ? {} : { cwd }),
    });
    child.once("error", (cause) => {
      rejectPromise(new Error(`无法调用系统程序 ${command}：${cause.message}`));
    });
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

async function toWindowsPath(linuxPath: string): Promise<string> {
  const converted = await execFileAsync("wslpath", ["-w", linuxPath], {
    windowsHide: true,
  });
  return converted.stdout.trim();
}
