import { spawn } from "node:child_process";

export type OpenTerminal = (command: string) => Promise<boolean>;

/**
 * 在系统终端里执行 Agent 的官方登录命令（ADR-0016 第 2 条：登录由用户在官方流程里完成，SuDuo 不碰凭据）。
 * 命令只来自内置配置表，不接受外部输入。打开失败返回 false，界面改为让用户复制命令自己执行。
 */
export function terminalOpener(platform: NodeJS.Platform = process.platform): OpenTerminal {
  return async (command) => {
    if (platform === "darwin") {
      const script = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return run("osascript", [
        "-e", 'tell application "Terminal" to activate',
        "-e", `tell application "Terminal" to do script "${script}"`,
      ]);
    }
    if (platform === "win32") {
      return run("cmd.exe", ["/d", "/c", "start", '""', "cmd.exe", "/k", command], true);
    }
    return run("x-terminal-emulator", ["-e", "sh", "-c", `${command}; exec "\${SHELL:-sh}"`]);
  };
}

function run(file: string, args: string[], verbatim = false): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { stdio: "ignore", windowsHide: false, windowsVerbatimArguments: verbatim });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
