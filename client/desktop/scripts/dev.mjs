// `pnpm desktop:dev` (from client/): runs the desktop shell against the local source build.
// The local service comes from client/server/dist and the web app from client/web/dist (run `pnpm build` first),
// Codex from client/node_modules, Node is the one running this script. Shell data goes to "SuDuo Desktop Dev"
// unless SUDUO_DESKTOP_HOME is set, so a real installation is never touched.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = resolve(root, "..");
const require = createRequire(join(root, "package.json"));

for (const output of [join(clientRoot, "server", "dist", "main.js"), join(clientRoot, "web", "dist", "index.html")]) {
  if (!existsSync(output)) {
    console.error(`Missing ${output}. Run \`pnpm build\` in client/ first.`);
    process.exit(1);
  }
}

// Electron's own install script is not allowed to run during `pnpm install` (see client/package.json
// ignoredBuiltDependencies), so the binary is fetched here, the first time it is needed.
// Behind a slow network set ELECTRON_MIRROR (e.g. https://npmmirror.com/mirrors/electron/).
const electronDir = dirname(require.resolve("electron/package.json"));
if (!existsSync(join(electronDir, "path.txt"))) {
  console.log("Downloading the Electron binary (first run only)…");
  const result = spawnSync(process.execPath, [join(electronDir, "install.js")], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const built = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const electron = require("electron");
const env = { ...process.env, SUDUO_DESKTOP_NODE: process.env["SUDUO_DESKTOP_NODE"] || process.execPath };
// Inherited from editors built on Electron (e.g. a VS Code extension host): it would make Electron start as plain Node.
delete env["ELECTRON_RUN_AS_NODE"];
const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
// Ctrl+C in the terminal already reaches Electron (same process group) and makes it quit through its normal flow;
// forwarding it again could kill Electron mid-quit. Only forward SIGTERM, and keep waiting for Electron to exit.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => child.kill("SIGTERM"));
