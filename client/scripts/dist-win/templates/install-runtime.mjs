// 安装后清理与迁移：删除旧版遗留的自启计划任务，把旧版 config\codex
// 迁移到 data\codex。所有步骤尽力而为，失败只记日志、不阻断安装——
// 服务端首次启动会补齐缺失配置，问题可通过自检定位。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInstallLogger, runNativeCommand } from "./runtime-support.mjs";

const rawInstallDir = process.argv[2];
if (!rawInstallDir) {
  throw new Error("install-runtime.mjs requires InstallDir");
}
const installDir = resolve(rawInstallDir);
const dataDir = join(installDir, "data");
const legacyCodexDir = join(installDir, "config", "codex");
const dataCodexDir = join(dataDir, "codex");
const logPath = join(dataDir, "install.log");

mkdirSync(dataDir, { recursive: true });
const log = createInstallLogger(logPath);

try {
  log(`INSTALL CLEANUP START installDir=${installDir}`);
  removeLegacyAutostartTask();
  removeLegacyAccessToken();
  migrateLegacyCodexConfig();
  log("INSTALL CLEANUP SUCCESS");
} catch (error) {
  log(
    `INSTALL CLEANUP WARNING error=${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
}

function removeLegacyAccessToken() {
  const path = join(dataDir, "access-token");
  rmSync(path, { force: true });
  log("LEGACY ACCESS TOKEN removed");
}
process.exitCode = 0;

// 旧版用登录自启计划任务常驻；新版由启动器按需拉起，任务彻底移除。
function removeLegacyAutostartTask() {
  if (process.platform !== "win32") {
    log("LEGACY TASK skipped (not windows)");
    return;
  }
  runOptional("schtasks /Change /Disable", "schtasks.exe", [
    "/Change",
    "/TN",
    "SuDuo",
    "/Disable",
  ]);
  runOptional("schtasks /End", "schtasks.exe", ["/End", "/TN", "SuDuo"]);
  runOptional("schtasks /Delete", "schtasks.exe", [
    "/Delete",
    "/TN",
    "SuDuo",
    "/F",
  ]);
}

function migrateLegacyCodexConfig() {
  if (!existsSync(legacyCodexDir)) {
    log("LEGACY CODEX CONFIG absent, nothing to migrate");
    return;
  }
  if (process.platform === "win32") {
    // 旧版安装器曾对 config\codex 做 icacls 收权，且存在把文件 DACL
    // 锁成对所有人拒绝的缺陷；先恢复为继承父目录权限再迁移。
    runOptional("icacls reset legacy codex config", "icacls.exe", [
      legacyCodexDir,
      "/reset",
      "/T",
      "/C",
    ]);
  }
  mkdirSync(dataCodexDir, { recursive: true });
  for (const entry of readdirSync(legacyCodexDir)) {
    const source = join(legacyCodexDir, entry);
    const target = join(dataCodexDir, entry);
    if (existsSync(target)) {
      log(`MIGRATE skip (target exists): ${entry}`);
      continue;
    }
    try {
      renameSync(source, target);
      log(`MIGRATE moved: ${entry}`);
    } catch (error) {
      log(
        `MIGRATE failed: ${entry} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    rmdirSync(legacyCodexDir);
    log("LEGACY CODEX CONFIG directory removed");
  } catch {
    log("LEGACY CODEX CONFIG directory kept (not empty)");
  }
}

function runOptional(label, command, args) {
  return runNativeCommand(command, args, {
    label,
    required: false,
    log,
  });
}
