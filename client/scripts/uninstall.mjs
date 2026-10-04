import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cliLocale, scriptMessages } from "./i18n/index.mjs";

const args = process.argv.slice(2);
// 提示跟随系统语言（规则与消息表见 scripts/i18n/）。
const t = scriptMessages(cliLocale(process.env)).installer;
const home = resolve(option("--home") ?? homedir());
const noSystemd = args.includes("--no-systemd");
const purgeData = args.includes("--purge-data");
const serviceName = normalizeServiceName(
  option("--service-name") ?? "suduo.service",
);
const configDir = resolve(home, ".config", "suduo");
const dataDir = resolve(home, ".local", "share", "suduo");
const servicePath = resolve(home, ".config", "systemd", "user", serviceName);

if (!noSystemd && existsSync(servicePath)) {
  spawnSync("systemctl", ["--user", "stop", serviceName], {
    stdio: "ignore",
  });
  spawnSync("systemctl", ["--user", "disable", serviceName], {
    stdio: "inherit",
  });
}
rmSync(servicePath, { force: true });
rmSync(configDir, { recursive: true, force: true });
if (purgeData) {
  rmSync(dataDir, { recursive: true, force: true });
}
if (!noSystemd) {
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
}

process.stdout.write(
  JSON.stringify({
    status: "uninstalled",
    home,
    purgedData: purgeData,
    preservedDataDir: purgeData ? null : dataDir,
  }) + "\n",
);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizeServiceName(value) {
  const name = value.endsWith(".service") ? value : value + ".service";
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(name)) {
    throw new Error(t.invalidServiceName);
  }
  return name;
}
