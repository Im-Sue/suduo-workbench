// Stages everything a desktop package needs for one target into client/.build/desktop/<target>/ (technical design §2
// "安装包内布局", decision 3). electron-builder then packs `app/` into app.asar and copies `resources/*` next to it.
//   app/                       the shell: package.json, dist/ (main, preload, startup page), assets/
//   resources/suduo/           local service bundle (server/dist/main.mjs, doctor.mjs, migrations), web/dist,
//                              node_modules/better-sqlite3 (prebuild for the bundled Node's ABI)
//   resources/node/            official Node binary
//   resources/codex/<triple>/  Codex vendor directory, unchanged (binaries keep their publisher signatures)
//   resources/licenses/        SuDuo licence, third-party notices, licences of the bundled runtimes
// Expects `pnpm build` to have run in client/ (dist.mjs does that).
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { CODEX_VERSION, targetFor } from "./assets.mjs";
import { clientRoot, ensureAssets } from "./fetch-assets.mjs";

const desktopRoot = join(clientRoot, "desktop");
const repoRoot = resolve(clientRoot, "..");

export async function stage(platform, arch, { offline = false } = {}) {
  const target = targetFor(platform, arch);
  checkCodexVersion();
  for (const output of [
    join(clientRoot, "server", "dist", "main.js"),
    join(clientRoot, "web", "dist", "index.html"),
    join(desktopRoot, "dist", "main.cjs"),
  ]) {
    if (!existsSync(output)) throw new Error(`Missing ${output}; run \`pnpm build\` in client/ first.`);
  }
  const assets = await ensureAssets(target, { offline });
  const stageDir = join(clientRoot, ".build", "desktop", `${platform}-${arch}`);
  rmSync(stageDir, { recursive: true, force: true });
  const appDir = join(stageDir, "app");
  const resources = join(stageDir, "resources");
  const work = join(stageDir, "work");
  mkdirSync(work, { recursive: true });

  stageShell(appDir);
  await stageService(join(resources, "suduo"), assets.betterSqlite3, target);
  stageNode(join(resources, "node"), assets.node, work, target);
  stageCodex(join(resources, "codex"), assets.codex, work, target);
  stageLicenses(join(resources, "licenses"));
  rmSync(work, { recursive: true, force: true });
  return { stageDir, appDir, resources, version: clientVersion() };
}

function clientVersion() {
  return JSON.parse(readFileSync(join(clientRoot, "package.json"), "utf8")).version;
}

function checkCodexVersion() {
  const pinned = readFileSync(join(clientRoot, "codex-protocol", "VERSION"), "utf8").trim();
  if (pinned !== CODEX_VERSION) {
    throw new Error(`desktop/scripts/assets.mjs pins Codex ${CODEX_VERSION} but codex-protocol/VERSION is ${pinned}`);
  }
}

function stageShell(appDir) {
  mkdirSync(appDir, { recursive: true });
  cpSync(join(desktopRoot, "dist"), join(appDir, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  cpSync(join(desktopRoot, "assets"), join(appDir, "assets"), { recursive: true });
  // The packaged app's own package.json: app.getVersion() reads the product version from here.
  writeFileSync(
    join(appDir, "package.json"),
    JSON.stringify(
      {
        name: "suduo-desktop",
        productName: "SuDuo",
        version: clientVersion(),
        description: "SuDuo — requirement collaboration and local Codex workbench",
        author: "sue",
        license: "PolyForm-Noncommercial-1.0.0",
        main: "dist/main.cjs",
      },
      null,
      2,
    ) + "\n",
  );
}

async function stageService(suDuoDir, betterSqlite3Archive, target) {
  const serverDist = join(suDuoDir, "server", "dist");
  mkdirSync(serverDist, { recursive: true });
  // Same bundling as the retired Windows installer (verified there): ESM, Node 24, better-sqlite3 left external,
  // and a `require` shim for the few CommonJS dependencies that call it.
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["better-sqlite3"],
    banner: {
      js: "import { createRequire as __suDuoCreateRequire } from 'node:module'; const require = __suDuoCreateRequire(import.meta.url);",
    },
    logLevel: "warning",
  };
  await build({ ...common, entryPoints: [join(clientRoot, "server", "dist", "main.js")], outfile: join(serverDist, "main.mjs") });
  await build({ ...common, entryPoints: [join(clientRoot, "scripts", "doctor.ts")], outfile: join(serverDist, "doctor.mjs") });
  // Migrations are read next to the bundle (new URL("./migrations/…", import.meta.url)); copy the whole folder.
  cpSync(join(clientRoot, "server", "src", "infrastructure", "db", "migrations"), join(serverDist, "migrations"), { recursive: true });
  cpSync(join(clientRoot, "web", "dist"), join(suDuoDir, "web", "dist"), { recursive: true });

  const modules = join(suDuoDir, "node_modules");
  const serverRequire = createRequire(join(clientRoot, "server", "package.json"));
  const betterSource = packageRoot(serverRequire, "better-sqlite3");
  const betterTarget = join(modules, "better-sqlite3");
  mkdirSync(betterTarget, { recursive: true });
  cpSync(join(betterSource, "lib"), join(betterTarget, "lib"), { recursive: true });
  for (const file of ["package.json", "LICENSE", "README.md"]) {
    if (existsSync(join(betterSource, file))) cpSync(join(betterSource, file), join(betterTarget, file));
  }
  // The prebuild for the bundled Node's ABI and the target platform (not the one installed for this machine).
  extract(betterSqlite3Archive, betterTarget);
  const addon = join(betterTarget, "build", "Release", "better_sqlite3.node");
  assertBinary(addon, target, "better_sqlite3.node");
  const betterRequire = createRequire(join(betterSource, "package.json"));
  copyPackage(betterRequire, "bindings", join(modules, "bindings"));
  const bindingsRequire = createRequire(join(packageRoot(betterRequire, "bindings"), "package.json"));
  copyPackage(bindingsRequire, "file-uri-to-path", join(modules, "file-uri-to-path"));
}

function stageNode(nodeDir, archive, work, target) {
  mkdirSync(nodeDir, { recursive: true });
  const extractDir = join(work, "node");
  mkdirSync(extractDir, { recursive: true });
  extract(archive, extractDir);
  const root = join(extractDir, readdirSync(extractDir).find((name) => name.startsWith("node-v")) ?? "");
  const binary = target.platform === "win32" ? join(root, "node.exe") : join(root, "bin", "node");
  const destination = join(nodeDir, target.platform === "win32" ? "node.exe" : "node");
  cpSync(binary, destination);
  assertBinary(destination, target, "node");
  cpSync(join(root, "LICENSE"), join(nodeDir, "LICENSE"));
}

function stageCodex(codexDir, archive, work, target) {
  const extractDir = join(work, "codex");
  mkdirSync(extractDir, { recursive: true });
  extract(archive, extractDir);
  const vendor = join(extractDir, "package", "vendor", target.codexTriple);
  if (!existsSync(vendor)) throw new Error(`Codex package has no vendor/${target.codexTriple}`);
  cpSync(vendor, join(codexDir, target.codexTriple), { recursive: true });
  const binary = join(codexDir, target.codexTriple, "bin", target.platform === "win32" ? "codex.exe" : "codex");
  assertBinary(binary, target, "codex");
  for (const file of ["LICENSE", "NOTICE", "README.md"]) {
    if (existsSync(join(extractDir, "package", file))) cpSync(join(extractDir, "package", file), join(codexDir, file));
  }
}

function stageLicenses(licenseDir) {
  mkdirSync(licenseDir, { recursive: true });
  for (const file of ["LICENSE", "LICENSE.zh-CN.md", "THIRD_PARTY_NOTICES.md", "COMMERCIAL.md", "COMMERCIAL.zh-CN.md"]) {
    if (existsSync(join(repoRoot, file))) cpSync(join(repoRoot, file), join(licenseDir, file));
  }
}

function packageRoot(requireFrom, name) {
  return dirname(requireFrom.resolve(`${name}/package.json`));
}

function copyPackage(requireFrom, name, destination) {
  cpSync(packageRoot(requireFrom, name), destination, { recursive: true, dereference: true });
}

/**
 * The staged binaries must be for the target, not for the machine running the build. Reads the executable header
 * directly (no `file` command, which Windows doesn't have): 64-bit Mach-O and its CPU type, or a PE image and its machine.
 */
function assertBinary(path, target, label) {
  const header = Buffer.alloc(4096);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  let found = "unknown format";
  if (header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4);
    found = cpu === 0x0100000c ? "darwin-arm64" : cpu === 0x01000007 ? "darwin-x64" : `darwin cpu 0x${cpu.toString(16)}`;
  } else if (header.toString("latin1", 0, 2) === "MZ") {
    const pe = header.readUInt32LE(0x3c);
    if (pe + 6 <= header.length && header.toString("latin1", pe, pe + 4) === "PE\0\0") {
      const machine = header.readUInt16LE(pe + 4);
      found = machine === 0x8664 ? "win32-x64" : machine === 0xaa64 ? "win32-arm64" : `win32 machine 0x${machine.toString(16)}`;
    }
  }
  if (found !== `${target.platform}-${target.arch}`) {
    throw new Error(`${label} is not a ${target.platform}-${target.arch} binary (found ${found}): ${path}`);
  }
}

/**
 * Extracts a .tar.gz / .tgz / .zip archive. On Windows uses the system's bsdtar (System32\tar.exe), which reads zip too;
 * the GNU tar that Git for Windows puts on PATH takes "C:\…" for a remote host.
 */
function extract(archive, destination) {
  const tar = process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const args = archive.endsWith(".zip") && process.platform !== "win32" ? null : ["-xf", archive, "-C", destination];
  const result = args === null ? spawnSync("unzip", ["-q", "-o", archive, "-d", destination], { stdio: "inherit" }) : spawnSync(tar, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Extracting ${archive} failed`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, arch] = (option("--target") ?? `${process.platform}-${process.arch}`).split("-");
  const result = await stage(platform, arch, { offline: process.argv.includes("--offline") });
  console.log(JSON.stringify(result, null, 2));
}
