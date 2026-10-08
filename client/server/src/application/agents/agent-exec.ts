import { execFile } from "node:child_process";

export interface AgentExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 进程起不来（找不到、无权限）。 */
  spawnError: string | null;
}

export type AgentExec = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<AgentExecResult>;

/**
 * 会让子进程 claude 拒绝启动或误以为自己是嵌套会话的变量（开发者常在 Claude Code 里跑 SuDuo，参照 Tutti）。
 * 同时去掉父进程 Claude Code 传下来的会话标识，避免串到用户正在用的那个会话。
 */
export function agentChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key === "CLAUDECODE" ||
      key === "CLAUDE_PID" ||
      key === "CLAUDE_EFFORT" ||
      key === "CLAUDE_AGENT_SDK_VERSION" ||
      key.startsWith("CLAUDE_CODE_")
    ) {
      delete next[key];
    }
  }
  return next;
}

const MAX_OUTPUT = 256 * 1024;

/** 跑一条检测命令（版本、登录状态），有超时与输出上限；Windows 的 .cmd / .bat 经 cmd.exe 执行。 */
export const execAgentCommand: AgentExec = (file, args, options) =>
  new Promise((resolve) => {
    const windowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const command = windowsScript ? "cmd.exe" : file;
    const commandArgs = windowsScript ? ["/d", "/s", "/c", [quoteWindows(file), ...args.map(quoteWindows)].join(" ")] : [...args];
    execFile(
      command,
      commandArgs,
      {
        timeout: options.timeoutMs,
        env: options.env,
        cwd: options.cwd,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        windowsVerbatimArguments: windowsScript,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" });
          return;
        }
        const timedOut = Boolean(error && (error as { killed?: boolean }).killed && (error as { signal?: string }).signal === "SIGTERM");
        const exitCode = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
        resolve({ exitCode, stdout: String(stdout), stderr: String(stderr), timedOut, spawnError: null });
      },
    );
  });

function quoteWindows(value: string): string {
  return /[\s"&|<>^]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}
