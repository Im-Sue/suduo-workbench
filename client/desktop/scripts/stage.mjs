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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  run("tar", ["-xzf", betterSqlite3Archive, "-C", betterTarget]);
  const addon = join(betterTarget, "build", "Release", "better_sqlite3.node");
  assertBinary(addon, target, "better_sqlite3.node");
  const betterRequire = createRequire(join(betterSource, "package.json"));
  copyPackage(betterRequire, "bindings", join(modules, "bindings"));
  const bindingsRequire = createRequire(join(packageRoot(betterRequire, "bindings"), "package.json"));
  copyPackage(bindingsRequire, "file-uri-to-path", join(modules, "file-uri-to-path"));
}

function stageNode(nodeDir, archive, work, target) {
  mkdirSync(nodeDir, { recursive: true });
  const extract = join(work, "node");
  mkdirSync(extract, { recursive: true });
  if (archive.endsWith(".zip")) run("unzip", ["-q", "-o", archive, "-d", extract]);
  else run("tar", ["-xzf", archive, "-C", extract]);
  const root = join(extract, readdirSync(extract).find((name) => name.startsWith("node-v")) ?? "");
  const binary = target.platform === "win32" ? join(root, "node.exe") : join(root, "bin", "node");
  const destination = join(nodeDir, target.platform === "win32" ? "node.exe" : "node");
  cpSync(binary, destination);
  assertBinary(destination, target, "node");
  cpSync(join(root, "LICENSE"), join(nodeDir, "LICENSE"));
}

function stageCodex(codexDir, archive, work, target) {
  const extract = join(work, "codex");
  mkdirSync(extract, { recursive: true });
  run("tar", ["-xzf", archive, "-C", extract]);
  const vendor = join(extract, "package", "vendor", target.codexTriple);
  if (!existsSync(vendor)) throw new Error(`Codex package has no vendor/${target.codexTriple}`);
  cpSync(vendor, join(codexDir, target.codexTriple), { recursive: true });
  const binary = join(codexDir, target.codexTriple, "bin", target.platform === "win32" ? "codex.exe" : "codex");
  assertBinary(binary, target, "codex");
  for (const file of ["LICENSE", "NOTICE", "README.md"]) {
    if (existsSync(join(extract, "package", file))) cpSync(join(extract, "package", file), join(codexDir, file));
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

/** The staged binaries must be for the target, not for the machine running the build. */
function assertBinary(path, target, label) {
  const description = runCapture("file", ["-b", path]);
  const ok =
    target.platform === "win32"
      ? /PE32\+/.test(description) && /x86-64/.test(description)
      : /Mach-O/.test(description) && (target.arch === "arm64" ? /arm64/.test(description) : /x86_64/.test(description));
  if (!ok) throw new Error(`${label} is not a ${target.platform}-${target.arch} binary: ${description}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
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
