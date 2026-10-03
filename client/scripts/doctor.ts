import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_VERSION } from "../contracts/src/config.js";
import {
  formatDoctorText,
  runDoctor,
  type DoctorOptions,
} from "../server/src/infrastructure/doctor/doctor-service.js";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseOptions(process.argv.slice(2));
const result = await runDoctor(options);

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  process.stdout.write(formatDoctorText(result));
  process.stdout.write(
    result.status === "PASS"
      ? "\n自检通过，可以启动 SuDuo。\n"
      : "\n自检未通过。请先修复上述问题；不会带病启动服务。\n",
  );
}
if (result.status === "FAIL") {
  process.exitCode = 1;
}

function parseOptions(args: string[]): DoctorOptions {
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(value("--port") ?? process.env["SUDUO_PORT"] ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port 必须是 1 到 65535 的整数");
  }
  const installed = args.includes("--installed");
  const codexHome = resolve(
    value("--codex-home") ??
      process.env["SUDUO_CODEX_HOME"] ??
      process.env["CODEX_HOME"] ??
      resolve(homedir(), ".codex"),
  );
  return {
    installed,
    allowPortInUse: args.includes("--allow-port-in-use"),
    port,
    codexHome,
    codexBin: resolveCommand(
      value("--codex-bin") ??
        process.env["SUDUO_CODEX_BIN"] ??
        defaultCodexCommand(),
    ),
    checkPnpm: !installed,
  };
}

function defaultCodexCommand(): string {
  if (process.platform !== "win32") {
    return resolve(workspaceRoot, "node_modules", ".bin", "codex");
  }
  const pnpmStore = resolve(workspaceRoot, "node_modules", ".pnpm");
  try {
    const candidates = readdirSync(pnpmStore, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith(`@openai+codex@${CODEX_VERSION}-win32-`),
      )
      .flatMap((entry) => {
        const vendor = resolve(
          pnpmStore,
          entry.name,
          "node_modules",
          "@openai",
          "codex",
          "vendor",
        );
        return readdirSync(vendor, { withFileTypes: true })
          .filter((target) => target.isDirectory())
          .map((target) => resolve(vendor, target.name, "bin", "codex.exe"))
          .filter(existsSync);
      });
    if (candidates.length === 1 && candidates[0]) {
      return candidates[0];
    }
  } catch {
    // The version check returns an actionable error.
  }
  return resolve(workspaceRoot, "node_modules", ".bin", "codex.cmd");
}

function resolveCommand(value: string): string {
  return value.includes("/") || value.includes("\\") ? resolve(value) : value;
}
