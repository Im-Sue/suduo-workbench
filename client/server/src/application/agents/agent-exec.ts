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
 * 父进程 Claude Code 传下来的会话标识与进程间通信变量：留着会让子进程 claude 误以为自己是嵌套会话、
 * 串到用户正在用的那个会话（开发者常在 Claude Code 里跑 SuDuo，参照 Tutti）。只去掉这些；用户自己的
 * 配置（CLAUDE_CODE_USE_BEDROCK、CLAUDE_CODE_USE_VERTEX、CLAUDE_CODE_MAX_OUTPUT_TOKENS 等）原样保留。
 */
const PARENT_SESSION_VARIABLES = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
]);

export function agentChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(next)) {
    if (PARENT_SESSION_VARIABLES.has(key)) {
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
    // cmd.exe 的 /s 会去掉整行首尾各一个引号：整行外面再包一层，路径里有空格也不会被拆开。
    const commandArgs = windowsScript ? ["/d", "/s", "/c", `"${[quoteWindows(file), ...args.map(quoteWindows)].join(" ")}"`] : [...args];
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
