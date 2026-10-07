// Smoke test for a packaged SuDuo (technical design §5 "安装包冒烟"): starts the packaged app in smoke mode with a
// throw-away data folder and an empty Codex home, waits for it to report and quit, and checks the report.
//   node desktop/scripts/smoke.mjs [--app <path to SuDuo.app | SuDuo.exe>]
// Default: the unpacked app electron-builder left in client/dist-desktop for this machine.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientRoot } from "./fetch-assets.mjs";

const TIMEOUT_MS = 240_000;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultApp() {
  const output = join(clientRoot, "dist-desktop");
  const candidates =
    process.platform === "darwin"
      ? [join(output, `mac-${process.arch}`, "SuDuo.app"), join(output, "mac", "SuDuo.app")]
      : [join(output, "win-unpacked", "SuDuo.exe")];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`No packaged app found (looked at ${candidates.join(", ")}); run dist.mjs first or pass --app.`);
  return found;
}

function executableOf(app) {
  return app.endsWith(".app") ? join(app, "Contents", "MacOS", "SuDuo") : app;
}

export async function smoke(app) {
  // Real path: on macOS the default temp folder is behind a symlink, which the local service's path checks reject.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "suduo-smoke-")));
  const report = join(root, "report.json");
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const env = { ...process.env, SUDUO_DESKTOP_HOME: join(root, "home"), SUDUO_CODEX_HOME: codexHome };
  for (const key of Object.keys(env)) {
    if (/^(npm_|pnpm_)/i.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  }
  // As if opened from Finder: the shell reads the login shell environment.
  delete env["TERM"];
  const executable = executableOf(app);
  console.log(`Smoke testing ${executable}`);
  const code = await new Promise((resolveExit) => {
    const child = spawn(executable, ["--smoke-report", report], { env, stdio: "inherit" });
    const timer = setTimeout(() => {
      console.error(`No result within ${String(TIMEOUT_MS / 1000)} s; killing it.`);
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      resolveExit(exitCode ?? (signal ? 1 : 0));
    });
  });
  const result = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : { ok: false, failure: "no report" };
  console.log(JSON.stringify(result, null, 2));
  return { ok: result.ok === true && code === 0, code, result, dataDir: root };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outcome = await smoke(option("--app") ?? defaultApp());
  console.log(outcome.ok ? "SMOKE PASS" : `SMOKE FAIL (exit ${String(outcome.code)})`);
  process.exit(outcome.ok ? 0 : 1);
}
