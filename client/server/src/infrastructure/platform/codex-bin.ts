import { CODEX_VERSION } from "@suduo/client-contracts";
import { existsSync, readdirSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";

/**
 * 源码运行时必须使用 workspace 锁定的 Codex，而不是回退到 PATH 的任意全局版本。
 * 已安装运行时通过 runtime-config 注入绝对 SUDUO_CODEX_BIN，作为无 workspace 时的后备。
 */
export function resolvePinnedCodexBin(input: {
  workspaceRoot?: string;
  configuredBin?: string;
  platform?: NodeJS.Platform;
} = {}): string {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    // Windows 上直接运行 vendor 里的 codex.exe：codex.cmd 只能经 cmd 启动，
    // 而 Node 拼给 cmd 的命令行不给路径加引号，仓库路径里有空格（如 C:\Users\John Smith）时就起不来。
    const vendorExe = findWindowsVendorCodex(workspaceRoot);
    if (vendorExe !== null) {
      return vendorExe;
    }
  }
  const workspaceBin = resolve(
    workspaceRoot,
    "node_modules",
    ".bin",
    platform === "win32" ? "codex.cmd" : "codex",
  );
  if (existsSync(workspaceBin)) {
    return workspaceBin;
  }
  if (input.configuredBin && isPath(input.configuredBin)) {
    return resolve(workspaceRoot, input.configuredBin);
  }
  throw new Error(
    `未找到 workspace 锁定的 Codex ${CODEX_VERSION}；请通过绝对或相对路径设置 SUDUO_CODEX_BIN`,
  );
}

/** pnpm 把锁定版本的 Windows 平台包装在 node_modules/.pnpm/@openai+codex@<版本>-win32-<架构>/ 下。 */
function findWindowsVendorCodex(workspaceRoot: string): string | null {
  const store = resolve(workspaceRoot, "node_modules", ".pnpm");
  try {
    const candidates = readdirSync(store, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`@openai+codex@${CODEX_VERSION}-win32-`))
      .flatMap((entry) => {
        const vendor = resolve(store, entry.name, "node_modules", "@openai", "codex", "vendor");
        if (!existsSync(vendor)) return [];
        return readdirSync(vendor, { withFileTypes: true })
          .filter((target) => target.isDirectory())
          .map((target) => resolve(vendor, target.name, "bin", "codex.exe"))
          .filter((path) => existsSync(path));
      });
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  } catch {
    return null;
  }
}

function isPath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/**
 * 把本机服务自己所用 node 的目录补到 PATH 最前面（已在其中则不动），供入口在启动时写回本进程环境。
 * node_modules/.bin/codex 是个要从 PATH 找 node 的包装脚本；node 由 nvm / mise 等装在用户目录、
 * 而本机服务以 systemd 用户服务运行时，继承来的 PATH 只有系统目录，Codex 会以 127 退出。
 * 不在服务单元里写死 PATH：继承来的其余目录（snap、environment.d 等）原样保留。
 */
export function withNodeOnPath(
  env: Record<string, string>,
  nodeExecutable: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const delimiter = platform === "win32" ? ";" : ":";
  // Windows 上环境变量名不分大小写，常见写法是 Path。
  const key = Object.keys(env).find((name) => (platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH")) ?? "PATH";
  const directory = (platform === "win32" ? win32 : posix).dirname(nodeExecutable);
  const entries = (env[key] ?? "").split(delimiter).filter((entry) => entry !== "");
  const same = (entry: string) => (platform === "win32" ? entry.toLowerCase() === directory.toLowerCase() : entry === directory);
  if (entries.some(same)) return env;
  return { ...env, [key]: [directory, ...entries].join(delimiter) };
}

