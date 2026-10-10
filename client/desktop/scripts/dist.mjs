// Builds a desktop installer for one target (technical design §3 decisions 3, 5, 6):
//   pnpm build (client) → stage.mjs → electron-builder → client/dist-desktop/
//   node desktop/scripts/dist.mjs [--target darwin-arm64|darwin-x64|win32-x64] [--skip-build] [--offline]
// From client/: `pnpm dist:desktop`. The first trial releases are unsigned: macOS packages are ad-hoc signed
// (Apple silicon refuses to run unsigned code), Windows installers are not signed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientRoot } from "./fetch-assets.mjs";
import { stage } from "./stage.mjs";

const desktopRoot = join(clientRoot, "desktop");
const outputDir = join(clientRoot, "dist-desktop");
const require = createRequire(join(desktopRoot, "package.json"));

/** electron-builder configuration for a staged target. */
export function builderConfig({ arch, appDir, resources }) {
  const electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;
  return {
    appId: "dev.suduo.desktop",
    productName: "SuDuo",
    copyright: "Copyright © 2026 sue · PolyForm Noncommercial 1.0.0",
    electronVersion,
    directories: { app: appDir, output: outputDir, buildResources: join(desktopRoot, "build") },
    files: ["**/*"],
    asar: true,
    // Nothing to rebuild: the shell has no native modules, and the service's SQLite module is a prebuild for the
    // bundled Node, staged under resources/suduo.
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    // One entry for the whole staged resources folder: electron-builder always drops a node_modules sitting directly
    // under an extraResources source (app-builder-lib util/filter.js), and the service needs suduo/node_modules.
    extraResources: [{ from: resources, to: ".", filter: ["**/*"] }],
    // Only the interface languages SuDuo ships (Chromium's own UI strings, e.g. context menus and dialogs).
    electronLanguages: ["en", "en-US", "en_US", "zh-CN", "zh_CN"],
    electronFuses: {
      // The local service runs on the bundled official Node, never as ELECTRON_RUN_AS_NODE.
      runAsNode: false,
      // Cookie encryption keeps its key in the macOS Keychain. An ad-hoc signed app gets a new signature with every
      // build, so the Keychain asks for permission again and network requests wait on that prompt. SuDuo keeps no
      // secrets in cookies (sign-in state lives in the local service), so leave it off for the unsigned trial.
      enableCookieEncryption: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    mac: {
      target: [{ target: "dmg", arch: [arch] }],
      category: "public.app-category.developer-tools",
      icon: join(desktopRoot, "build", "icon.icns"),
      minimumSystemVersion: "13.5",
      // Unsigned trial: ad-hoc signature only. Hardened runtime needs a real identity, so it stays off.
      identity: "-",
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
      // Node and Codex keep their publishers' notarized Developer ID signatures (re-signing them ad hoc would drop
      // the notarization that lets Gatekeeper accept them after a download).
      signIgnore: ["/Contents/Resources/node/", "/Contents/Resources/codex/"],
    },
    dmg: {
      artifactName: "SuDuo-${version}-mac-${arch}.${ext}",
      // latest-mac.yml 里要有 dmg：未签名的 Mac 版只检查有没有新版本、打开发布页下载（D3，技术设计 §4.3）。
      writeUpdateInfo: true,
      window: { width: 540, height: 380 },
      contents: [
        { x: 140, y: 190 },
        { x: 400, y: 190, type: "link", path: "/Applications" },
      ],
    },
    win: {
      target: [{ target: "nsis", arch: [arch] }],
      icon: join(desktopRoot, "build", "icon.ico"),
      requestedExecutionLevel: "asInvoker",
    },
    nsis: {
      artifactName: "SuDuo-Setup-${version}-${arch}.${ext}",
      // Per-user, no admin rights, no wizard (requirement 4.1).
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "SuDuo",
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
      include: join(desktopRoot, "build", "installer.nsh"),
      installerLanguages: ["en_US", "zh_CN"],
      multiLanguageInstaller: true,
    },
    // 应用内更新读 GitHub Release 上的 latest.yml / latest-mac.yml（打进安装包的 app-update.yml 指明仓库）。
    // 这里只生成这些文件，不上传：上传由 desktop.yml 在三台构建机都做完后统一做（两台 Mac 的 latest-mac.yml 要合并）。
    publish: { provider: "github", owner: "Im-Sue", repo: "suduo-workbench", releaseType: "release" },
  };
}

async function main() {
  const [platform, arch] = (option("--target") ?? `${process.platform}-${process.arch}`).split("-");
  if (!process.argv.includes("--skip-build")) runPnpm(["run", "build"]);
  const staged = await stage(platform, arch, { offline: process.argv.includes("--offline") });
  const builder = require("electron-builder");
  const targets =
    platform === "darwin"
      ? builder.Platform.MAC.createTarget(["dmg"], builder.Arch[arch])
      : builder.Platform.WINDOWS.createTarget(["nsis"], builder.Arch[arch]);
  const artifacts = await builder.build({ targets, config: builderConfig({ arch, ...staged }), publish: "never" });
  const installers = artifacts.filter((path) => /\.(dmg|exe)$/.test(path));
  const lines = [];
  for (const path of installers) {
    lines.push(`${await sha256(path)}  ${path.split(/[\\/]/).pop()}`);
    console.log(`${path} (${(statSync(path).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  writeFileSync(join(outputDir, `SHA256SUMS-${platform}-${arch}.txt`), lines.join("\n") + "\n");
  // 两台 Mac 构建机各写一份 latest-mac.yml：按架构改名，发布时合并（merge-update-info.mjs）。
  if (platform === "darwin" && existsSync(join(outputDir, "latest-mac.yml"))) {
    renameSync(join(outputDir, "latest-mac.yml"), join(outputDir, `latest-mac-${arch}.yml`));
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function runPnpm(args) {
  const execPath = process.env["npm_execpath"];
  const result =
    execPath && /pnpm/i.test(execPath) && /\.(c|m)?js$/i.test(execPath)
      ? spawnSync(process.execPath, [execPath, ...args], { cwd: clientRoot, stdio: "inherit" })
      : spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { cwd: clientRoot, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Old artifacts for the same target would be confused with the new ones. */
export function cleanOutput() {
  try {
    for (const entry of readdirSync(outputDir)) rmSync(join(outputDir, entry), { recursive: true, force: true });
  } catch {
    // No output yet.
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cleanOutput();
  await main();
}
