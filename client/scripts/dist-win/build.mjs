import { createRequire } from "node:module";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { WINDOWS_BUNDLE } from "./assets.mjs";
import {
  cacheDir,
  ensureAssets,
  projectRoot,
  sha256,
} from "./fetch-assets.mjs";
import { createSuDuoIco } from "./icon.mjs";

const serverRequire = createRequire(
  resolve(projectRoot, "server", "package.json"),
);
const args = process.argv.slice(2);
const packageJson = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf8"),
);
const version = String(packageJson.version);
const buildRoot = resolve(projectRoot, ".build", "dist-win");
const payloadRoot = resolve(buildRoot, "payload");
const outputDir = resolve(projectRoot, "dist-installer");
const outputPath = resolve(outputDir, `SuDuo-Setup-${version}.exe`);
const offline =
  args.includes("--offline") || process.env["SUDUO_DIST_OFFLINE"] === "1";
const codexConfig = option("--codex-config") ??
  process.env["SUDUO_DIST_CODEX_CONFIG"];
const codexAuth = option("--codex-auth") ??
  process.env["SUDUO_DIST_CODEX_AUTH"];

run("pnpm", ["build"], projectRoot);
const assets = await ensureAssets({ offline });
const byName = new Map(assets.map((asset) => [asset.fileName, asset.path]));

rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(payloadRoot, { recursive: true });
mkdirSync(outputDir, { recursive: true });
rmSync(outputPath, { force: true });

stageNode();
stageCodex();
stageApplication();
await verifyBundledApplication();
stageBrandAssets();
stageConfiguration();
stageInstallerScripts();
const payload = summarizeDirectory(payloadRoot);
const credentialMode = codexConfig || codexAuth ? "internal" : "template";
const bundleManifest = {
  product: "SuDuo",
  version,
  target: "win32-x64",
  credentialMode,
  runtime: {
    node: {
      version: WINDOWS_BUNDLE.node.version,
      sourceSha256: WINDOWS_BUNDLE.node.sha256,
      executable: "runtime/node.exe",
    },
    codex: {
      version: WINDOWS_BUNDLE.codex.version,
      sourceSha256: WINDOWS_BUNDLE.codex.sha256,
      executable: `runtime/codex/${WINDOWS_BUNDLE.codex.executable}`,
    },
    betterSqlite3: {
      version: WINDOWS_BUNDLE.betterSqlite3.version,
      nodeAbi: WINDOWS_BUNDLE.betterSqlite3.nodeAbi,
      sourceSha256: WINDOWS_BUNDLE.betterSqlite3.sha256,
      addonSha256: WINDOWS_BUNDLE.betterSqlite3.addonSha256,
    },
    nsis: {
      version: WINDOWS_BUNDLE.nsis.version,
    },
  },
  payload,
};
writeFileSync(
  resolve(payloadRoot, "bundle-manifest.json"),
  JSON.stringify(bundleManifest, null, 2) + "\n",
);

const makensis = ensureMakensis();
const version4 = toWindowsVersion(version);
run(
  makensis.executable,
  [
    `-DVERSION=${version}`,
    `-DVERSION4=${version4}`,
    `-DPAYLOAD_DIR=${payloadRoot}`,
    `-DOUT_FILE=${outputPath}`,
    resolve(projectRoot, "scripts", "dist-win", "installer.nsi"),
  ],
  projectRoot,
  {
    ...process.env,
    NSISDIR: makensis.dataDir,
  },
);

if (!existsSync(outputPath)) {
  throw new Error("NSIS 未产生安装器");
}
const fileDescription = runCapture("file", [outputPath], projectRoot);
if (!/PE32/i.test(fileDescription)) {
  throw new Error("安装器不是 Windows PE 文件: " + fileDescription);
}
const outputSha256 = await sha256(outputPath);
const outputSize = statSync(outputPath).size;
writeFileSync(
  outputPath.replace(/\.exe$/i, ".sha256"),
  `${outputSha256}  ${outputPath.split("/").at(-1)}\n`,
);
writeFileSync(
  resolve(outputDir, "bundle-build.json"),
  JSON.stringify(
    {
      status: "PASS",
      outputPath,
      outputSize,
      outputSha256,
      credentialMode,
      offline,
      cacheDir,
      payload,
      bundled: bundleManifest.runtime,
    },
    null,
    2,
  ) + "\n",
);

process.stdout.write(
  JSON.stringify(
    {
      status: "PASS",
      outputPath,
      outputSize,
      outputSha256,
      credentialMode,
      offline,
      payload,
    },
    null,
    2,
  ) + "\n",
);

function stageNode() {
  const extraction = resolve(buildRoot, "node-extracted");
  mkdirSync(extraction, { recursive: true });
  run(
    ensureUnzip(),
    ["-q", "-o", assetPath(WINDOWS_BUNDLE.node.fileName), "-d", extraction],
    projectRoot,
  );
  const source = resolve(
    extraction,
    `node-v${WINDOWS_BUNDLE.node.version}-win-x64`,
  );
  const target = resolve(payloadRoot, "runtime");
  mkdirSync(target, { recursive: true });
  for (const file of ["node.exe", "LICENSE", "README.md"]) {
    copyFileSync(resolve(source, file), resolve(target, file));
  }
}

function ensureUnzip() {
  const system = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  if (system.status === 0) {
    return "unzip";
  }
  const root = resolve(buildRoot, "unzip");
  mkdirSync(root, { recursive: true });
  run(
    "dpkg-deb",
    ["-x", assetPath(WINDOWS_BUNDLE.unzip.fileName), root],
    projectRoot,
  );
  const executable = resolve(root, "usr", "bin", "unzip");
  if (!existsSync(executable)) {
    throw new Error("unzip 自助工具链不可用");
  }
  return executable;
}

function stageCodex() {
  const extraction = resolve(buildRoot, "codex-extracted");
  mkdirSync(extraction, { recursive: true });
  run(
    "tar",
    ["-xzf", assetPath(WINDOWS_BUNDLE.codex.fileName), "-C", extraction],
    projectRoot,
  );
  cpSync(
    resolve(extraction, "package", "vendor"),
    resolve(payloadRoot, "runtime", "codex", "vendor"),
    { recursive: true },
  );
  const executable = resolve(
    payloadRoot,
    "runtime",
    "codex",
    WINDOWS_BUNDLE.codex.executable,
  );
  assertPeFile(executable, "codex.exe");
}

function stageApplication() {
  const serverDist = resolve(payloadRoot, "app", "apps", "server", "dist");
  const webDist = resolve(payloadRoot, "app", "apps", "web", "dist");
  mkdirSync(serverDist, { recursive: true });
  mkdirSync(webDist, { recursive: true });
  const banner =
    "import { createRequire as __suDuoCreateRequire } from 'node:module'; " +
    "const require = __suDuoCreateRequire(import.meta.url);";
  run(
    "pnpm",
    [
      "exec",
      "esbuild",
      "server/dist/main.js",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--external:better-sqlite3",
      `--banner:js=${banner}`,
      `--outfile=${resolve(serverDist, "main.mjs")}`,
    ],
    projectRoot,
  );
  run(
    "pnpm",
    [
      "exec",
      "esbuild",
      "scripts/doctor.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--external:better-sqlite3",
      `--banner:js=${banner}`,
      `--outfile=${resolve(serverDist, "doctor.mjs")}`,
    ],
    projectRoot,
  );
  cpSync(resolve(projectRoot, "web", "dist"), webDist, {
    recursive: true,
  });
  // 整目录复制：新增 migration 无需改本脚本。
  const migrationTarget = resolve(serverDist, "migrations");
  mkdirSync(migrationTarget, { recursive: true });
  cpSync(
    resolve(projectRoot, "server", "src", "infrastructure", "db", "migrations"),
    migrationTarget,
    { recursive: true },
  );
  stageBetterSqlite3();
}

async function verifyBundledApplication() {
  const smokeRoot = resolve(buildRoot, "linux-smoke");
  const smokeApp = resolve(smokeRoot, "app");
  const smokeData = resolve(smokeRoot, "data");
  const smokeConfig = resolve(smokeRoot, "config");
  const smokeCodex = resolve(smokeRoot, "fake-codex.mjs");
  mkdirSync(smokeData, { recursive: true });
  mkdirSync(resolve(smokeConfig, "codex"), { recursive: true });
  cpSync(resolve(payloadRoot, "app"), smokeApp, { recursive: true });
  const betterSource = packageRoot(serverRequire, "better-sqlite3");
  copyFileSync(
    resolve(betterSource, "build", "Release", "better_sqlite3.node"),
    resolve(
      smokeApp,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ),
  );
  writeFileSync(
    smokeCodex,
    "#!/usr/bin/env node\n" +
      readFileSync(
        resolve(
          projectRoot,
          "server",
          "test",
          "fixtures",
          "fake-codex.mjs",
        ),
        "utf8",
      ),
  );
  chmodSync(smokeCodex, 0o755);
  const port = await availablePort();
  writeFileSync(
    resolve(smokeConfig, "runtime.json"),
    JSON.stringify({
      schemaVersion: 1,
      environment: {
        SUDUO_HOST: "127.0.0.1",
        SUDUO_PORT: String(port),
        SUDUO_DATA_DIR: "data",
        SUDUO_DB_PATH: "data/suduo.sqlite",
        SUDUO_PID_FILE: "data/suduo.pid",
        SUDUO_CODEX_BIN: "fake-codex.mjs",
        SUDUO_CODEX_HOME: "config/codex",
        CODEX_HOME: "config/codex",
        SUDUO_CODEX_VERSION: WINDOWS_BUNDLE.codex.version,
        SUDUO_CODEX_TRANSPORT: "stdio",
        SUDUO_LOG_LEVEL: "silent",
      },
    }),
  );
  const smokeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && key !== "CODEX_HOME" && !key.startsWith("SUDUO_"),
    ),
  );
  const child = spawn(
    process.execPath,
    [
      resolve(smokeApp, "apps", "server", "dist", "main.mjs"),
      "--runtime-config",
      resolve(smokeConfig, "runtime.json"),
    ],
    {
      cwd: smokeRoot,
      env: smokeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  try {
    const deadline = Date.now() + 15_000;
    let verified = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error("bundled server exited: " + stderr.slice(-2_000));
      }
      try {
        const base = `http://127.0.0.1:${String(port)}/`;
        const health = await fetch(base + "healthz");
        const healthBody = await health.json();
        const page = await fetch(base);
        const html = await page.text();
        if (
          health.status === 200 &&
          healthBody.product === "suduo" &&
          healthBody.status === "ok" &&
          page.status === 200 &&
          html.includes("SuDuo")
        ) {
          verified = true;
          break;
        }
      } catch {
        // Wait for migrations and listen.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!verified) {
      throw new Error("bundled server smoke timeout: " + stderr.slice(-2_000));
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function availablePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  return await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("unable to allocate smoke-test port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function stageBetterSqlite3() {
  const modules = resolve(payloadRoot, "app", "node_modules");
  const betterTarget = resolve(modules, "better-sqlite3");
  const betterSource = packageRoot(serverRequire, "better-sqlite3");
  mkdirSync(betterTarget, { recursive: true });
  cpSync(resolve(betterSource, "lib"), resolve(betterTarget, "lib"), {
    recursive: true,
  });
  copyExistingFiles(betterSource, betterTarget, [
    "package.json",
    "LICENSE",
    "README.md",
  ]);
  run(
    "tar",
    [
      "-xzf",
      assetPath(WINDOWS_BUNDLE.betterSqlite3.fileName),
      "-C",
      betterTarget,
    ],
    projectRoot,
  );
  const addon = resolve(
    betterTarget,
    "build",
    "Release",
    "better_sqlite3.node",
  );
  assertPeFile(addon, "better_sqlite3.node");
  const actualAddonSha = runCapture("sha256sum", [addon], projectRoot).split(" ")[0];
  if (actualAddonSha !== WINDOWS_BUNDLE.betterSqlite3.addonSha256) {
    throw new Error("better_sqlite3.node SHA256 不匹配: " + actualAddonSha);
  }

  const betterRequire = createRequire(resolve(betterSource, "package.json"));
  copyWholePackage(betterRequire, "bindings", resolve(modules, "bindings"));
  const bindingsRequire = createRequire(
    resolve(packageRoot(betterRequire, "bindings"), "package.json"),
  );
  copyWholePackage(
    bindingsRequire,
    "file-uri-to-path",
    resolve(modules, "file-uri-to-path"),
  );
}

function stageConfiguration() {
  const target = resolve(payloadRoot, "defaults", "codex");
  const runtimeTarget = resolve(payloadRoot, "config");
  mkdirSync(target, { recursive: true });
  mkdirSync(runtimeTarget, { recursive: true });
  const officialDefaults = resolve(projectRoot, "server", "defaults", "codex");
  if (existsSync(officialDefaults)) {
    cpSync(officialDefaults, target, { recursive: true });
  }
  copyFileSync(
    codexConfig
      ? resolve(codexConfig)
      : resolve(
          projectRoot,
          "scripts",
          "templates",
          "codex-config.template.toml",
        ),
    resolve(target, "config.toml"),
  );
  if (codexAuth) {
    copyFileSync(resolve(codexAuth), resolve(target, "auth.json"));
  }
  writeFileSync(
    resolve(runtimeTarget, "runtime.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        environment: {
          SUDUO_HOST: "127.0.0.1",
          SUDUO_PORT: "8787",
          SUDUO_DATA_DIR: "data",
          SUDUO_DB_PATH: "data/suduo.sqlite",
          SUDUO_PID_FILE: "data/suduo.pid",
          SUDUO_CODEX_BIN:
            "runtime/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
          // 一切可变状态（含 Codex 登录态）都住 data/，升级只替换载荷目录。
          SUDUO_CODEX_HOME: "data/codex",
          CODEX_HOME: "data/codex",
          // 服务端启动时从 defaults 补齐缺失配置，存在则永不覆盖。
          SUDUO_CODEX_DEFAULTS: "defaults/codex",
          SUDUO_CODEX_VERSION: WINDOWS_BUNDLE.codex.version,
          SUDUO_CODEX_TRANSPORT: "stdio",
          SUDUO_SSE_HEARTBEAT_MS: "15000",
          SUDUO_SSE_REPLAY_PAGE_SIZE: "500",
          SUDUO_RUNTIME_RESTART_MAX_MS: "30000",
          SUDUO_FS_WATCH_DEBOUNCE_MS: "300",
          SUDUO_FS_POLL_INTERVAL_MS: "2000",
          SUDUO_FS_FORCE_POLLING: "false",
          // 无打开页面且 30 分钟无任何请求/runtime 事件时自动退出。
          SUDUO_IDLE_EXIT_MS: "1800000",
          SUDUO_LOG_LEVEL: "info",
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function stageBrandAssets() {
  const target = resolve(payloadRoot, "assets");
  mkdirSync(target, { recursive: true });
  const icon = createSuDuoIco();
  if (icon.readUInt16LE(2) !== 1 || icon.readUInt16LE(4) < 4) {
    throw new Error("SuDuo ICO 生成失败");
  }
  writeFileSync(resolve(target, "suduo.ico"), icon);
}

function stageInstallerScripts() {
  const source = resolve(projectRoot, "scripts", "dist-win", "templates");
  const target = resolve(payloadRoot, "installer");
  cpSync(source, target, { recursive: true });
  copyFileSync(
    resolve(projectRoot, "scripts", "dist-win", "runtime-support.mjs"),
    resolve(target, "runtime-support.mjs"),
  );
}

function ensureMakensis() {
  const system = spawnSync("makensis", ["-VERSION"], { encoding: "utf8" });
  if (system.status === 0) {
    return { executable: "makensis", dataDir: "" };
  }
  const root = resolve(buildRoot, "nsis");
  mkdirSync(root, { recursive: true });
  for (const asset of WINDOWS_BUNDLE.nsis.packages) {
    run("dpkg-deb", ["-x", assetPath(asset.fileName), root], projectRoot);
  }
  const executable = resolve(root, "usr", "bin", "makensis");
  const dataDir = resolve(root, "usr", "share", "nsis");
  const versionResult = spawnSync(executable, ["-VERSION"], {
    encoding: "utf8",
    env: { ...process.env, NSISDIR: dataDir },
  });
  if (versionResult.status !== 0) {
    throw new Error("NSIS 自助工具链不可用: " + versionResult.stderr);
  }
  return { executable, dataDir };
}

function packageRoot(requireFrom, name) {
  return dirname(realpathSync(requireFrom.resolve(`${name}/package.json`)));
}

function copyWholePackage(requireFrom, name, target) {
  cpSync(packageRoot(requireFrom, name), target, { recursive: true });
}

function copyExistingFiles(source, target, files) {
  for (const file of files) {
    const path = resolve(source, file);
    if (existsSync(path)) {
      copyFileSync(path, resolve(target, file));
    }
  }
}

function summarizeDirectory(root) {
  let fileCount = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        fileCount += 1;
        bytes += statSync(path).size;
      }
    }
  }
  return { fileCount, bytes };
}

function assertPeFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} 缺失: ${relative(projectRoot, path)}`);
  }
  const description = runCapture("file", [path], projectRoot);
  if (!/PE32\+/i.test(description) || !/x86-64/i.test(description)) {
    throw new Error(`${label} 不是 win-x64 PE: ${description}`);
  }
}

function assetPath(fileName) {
  const path = byName.get(fileName);
  if (!path) {
    throw new Error("资产未准备: " + fileName);
  }
  return path;
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function toWindowsVersion(value) {
  const parts = value.split(".").map(Number);
  while (parts.length < 4) {
    parts.push(0);
  }
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error("无法转换 Windows 版本号: " + value);
  }
  return parts.join(".");
}

function run(command, commandArgs, cwd, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed`);
  }
}

function runCapture(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
