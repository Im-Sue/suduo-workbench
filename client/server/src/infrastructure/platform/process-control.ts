import {
  spawnSync,
  type ChildProcess,
} from "node:child_process";

export type ProcessTerminationMode = "graceful" | "force";

export interface ProcessTreeCommand {
  command: string;
  args: string[];
}

export function processTreeTerminationCommand(
  pid: number,
  mode: ProcessTerminationMode,
  platform: NodeJS.Platform = process.platform,
): ProcessTreeCommand | null {
  if (platform !== "win32") {
    return null;
  }
  return {
    command: "taskkill.exe",
    args: [
      "/PID",
      String(pid),
      "/T",
      ...(mode === "force" ? ["/F"] : []),
    ],
  };
}

export function terminateChildProcess(
  child: Pick<ChildProcess, "pid" | "kill" | "killed">,
  mode: ProcessTerminationMode,
): void {
  if (child.pid === undefined || child.killed) {
    return;
  }
  const command = processTreeTerminationCommand(child.pid, mode);
  if (command) {
    spawnSync(command.command, command.args, {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
}
