import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_VERSION } from "../contracts/src/config.js";
import { cliLocale } from "../contracts/src/i18n.js";
import {
  formatDoctorText,
  runDoctor,
  type DoctorOptions,
} from "../server/src/infrastructure/doctor/doctor-service.js";
import { messagesFor } from "../server/src/i18n/messages/index.js";
import { AgentCatalogService } from "../server/src/application/agents/agent-catalog-service.js";
import { AgentSettingsStore, agentSettingsPathFor } from "../server/src/application/agents/agent-settings-store.js";
import { defaultSuDuoDataDir } from "../server/src/infrastructure/platform/host-platform.js";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
// 输出跟随系统语言（SUDUO_LOCALE → LC_ALL → LC_MESSAGES → LANG → 系统区域，见 cliLocale）；--json 里的文字同样。
// 这里经 tsx 直接跑源码，`@suduo/client-contracts` 从 client/ 根目录解析不到，所以按相对路径引（同上面的 config.js）。
const locale = cliLocale(process.env);
const t = messagesFor(locale).doctor.cli;
const options = parseOptions(process.argv.slice(2));
const result = await runDoctor(options, locale);

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  process.stdout.write(formatDoctorText(result));
  process.stdout.write("\n" + (result.status === "PASS" ? t.passed : t.failed) + "\n");
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
    throw new Error(t.invalidPort);
  }
  const installed = args.includes("--installed");
  const codexHome = resolve(
    value("--codex-home") ??
      process.env["SUDUO_CODEX_HOME"] ??
      process.env["CODEX_HOME"] ??
      resolve(homedir(), ".codex"),
  );
  const codexBin = resolveCommand(
    value("--codex-bin") ??
      process.env["SUDUO_CODEX_BIN"] ??
      defaultCodexCommand(),
  );
  // 各家 Agent 按本机服务同样的设置检测（启用、路径覆盖、默认 Agent 存在数据目录的 agent-settings.json 里）。
  const dataDir = process.env["SUDUO_DATA_DIR"] ?? defaultSuDuoDataDir();
  const agents = new AgentCatalogService({
    store: new AgentSettingsStore(agentSettingsPathFor(resolve(dataDir, "settings.json"))),
    codexBin,
  });
  return {
    installed,
    allowPortInUse: args.includes("--allow-port-in-use"),
    port,
    codexHome,
    codexBin,
    checkPnpm: !installed,
    agents: () => agents.list(),
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
