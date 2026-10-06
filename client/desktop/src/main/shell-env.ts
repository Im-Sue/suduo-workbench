import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * 读取使用者登录 shell 的环境（技术设计 §4.4）。从访达启动的应用只拿到 launchd 给的最小环境，
 * PATH 里没有 Homebrew、mise、nvm 等目录，Codex 在项目里执行 npm、pnpm、python 会找不到命令。
 *
 * 做法与 VS Code 相同：用 `$SHELL -ilc` 跑一遍登录交互 shell，在两个标记之间打印 `env -0`，
 * 标记用来跳过 oh-my-zsh 一类的欢迎信息。
 */
export const SHELL_ENV_TIMEOUT_MS = 10_000;

/** shell 自己维护、不该带进本机服务的变量。 */
const SHELL_ONLY_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

export function shellEnvironmentCommand(shell: string, marker: string): { command: string; args: string[] } {
  return {
    command: shell,
    args: ["-ilc", `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`],
  };
}

/** 取两个标记之间的 `env -0` 输出解析成对象；找不到成对的标记返回 null。 */
export function parseShellEnvironment(output: string, marker: string): Record<string, string> | null {
  const start = output.indexOf(marker);
  const end = output.lastIndexOf(marker);
  if (start < 0 || end <= start) return null;
  const body = output.slice(start + marker.length, end);
  const env: Record<string, string> = {};
  for (const entry of body.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (SHELL_ONLY_KEYS.has(key)) continue;
    env[key] = entry.slice(separator + 1);
  }
  return Object.keys(env).length === 0 ? null : env;
}

/** 是否需要读：只有 macOS，且不是从终端启动的（从终端启动时已经带着完整环境）。 */
export function needsShellEnvironment(platform: NodeJS.Platform, env: Record<string, string | undefined>): boolean {
  return platform === "darwin" && !env["TERM"];
}

export type ShellEnvironmentResult =
  | { ok: true; env: Record<string, string>; shell: string }
  | { ok: false; reason: string; shell: string };

export function loadShellEnvironment(options: {
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<ShellEnvironmentResult> {
  const shell = options.env["SHELL"] || "/bin/zsh";
  const marker = `__SUDUO_ENV_${randomUUID()}__`;
  const { command, args } = shellEnvironmentCommand(shell, marker);
  return new Promise((resolveResult) => {
    let output = "";
    let settled = false;
    const finish = (result: ShellEnvironmentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        // 让使用者的 rc 文件能认出这是 SuDuo 在读环境（需要时可以跳过耗时的初始化）。
        env: { ...options.env, SUDUO_RESOLVING_ENVIRONMENT: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch (error) {
      finish({ ok: false, reason: error instanceof Error ? error.message : String(error), shell });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: `timed out after ${String(options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS)} ms`, shell });
    }, options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => finish({ ok: false, reason: error.message, shell }));
    child.once("close", (code) => {
      const env = parseShellEnvironment(output, marker);
      if (env === null) {
        finish({ ok: false, reason: `no environment in shell output (exit ${String(code)})`, shell });
        return;
      }
      finish({ ok: true, env, shell });
    });
  });
}
