import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliLocale, scriptMessages } from "./i18n/index.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
// 提示跟随系统语言（规则与消息表见 scripts/i18n/）。
const t = scriptMessages(cliLocale(process.env)).installer;
const home = resolve(option("--home") ?? homedir());
const codexHome = resolve(
  option("--codex-home") ?? process.env.CODEX_HOME ?? resolve(home, ".codex"),
);
const port = option("--port") ?? "8787";
const noEnable = args.includes("--no-enable");
const skipDoctor = args.includes("--skip-doctor");
const configDir = resolve(home, ".config", "suduo");
const dataDir = resolve(home, ".local", "share", "suduo");
const systemdDir = resolve(home, ".config", "systemd", "user");
const serviceName = normalizeServiceName(
  option("--service-name") ?? "suduo.service",
);
const servicePath = resolve(systemdDir, serviceName);
const envPath = resolve(configDir, "suduo.env");
const codexBin = resolve(root, "node_modules", ".bin", "codex");
// 锁定的 Codex 版本以 codex-protocol/VERSION 为准（与 @suduo/client-contracts 的 CODEX_VERSION 同步）。
const codexVersion = readFileSync(resolve(root, "codex-protocol", "VERSION"), "utf8").trim();

run("pnpm", ["install", "--frozen-lockfile"], root);
run("pnpm", ["build"], root);

mkdirSync(configDir, { recursive: true, mode: 0o700 });
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(systemdDir, { recursive: true, mode: 0o700 });
rmSync(resolve(dataDir, "access-token"), { force: true });

copyFileSync(
  resolve(root, "scripts", "templates", "codex-config.template.toml"),
  resolve(configDir, "codex-config.template.toml"),
);

writeFileSync(
  envPath,
  [
    "SUDUO_HOST=127.0.0.1",
    `SUDUO_PORT=${port}`,
    `SUDUO_DATA_DIR=${systemdQuote(dataDir)}`,
    `SUDUO_DB_PATH=${systemdQuote(resolve(dataDir, "suduo.sqlite"))}`,
    `SUDUO_CODEX_BIN=${systemdQuote(codexBin)}`,
    `SUDUO_CODEX_HOME=${systemdQuote(codexHome)}`,
    `SUDUO_CODEX_VERSION=${codexVersion}`,
    "SUDUO_CODEX_TRANSPORT=stdio",
    "SUDUO_SSE_HEARTBEAT_MS=15000",
    "SUDUO_SSE_REPLAY_PAGE_SIZE=500",
    "SUDUO_RUNTIME_RESTART_MAX_MS=30000",
    "SUDUO_FS_WATCH_DEBOUNCE_MS=300",
    "SUDUO_FS_POLL_INTERVAL_MS=2000",
    "SUDUO_FS_FORCE_POLLING=false",
    "SUDUO_LOG_LEVEL=info",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

// 不设 PrivateTmp：用户级 systemd 要先建一个用户命名空间才能给服务私有 /tmp，Ubuntu 24.04 的 AppArmor
// 会把这个命名空间里的进程切到受限的 unprivileged_userns 配置，Codex 的 bubblewrap 沙箱随之建不了命名空间，
// 需要审批或受限执行的命令全部失败（哪怕已按官方说明装好 bubblewrap 与 AppArmor 配置）。
writeFileSync(
  servicePath,
  `[Unit]\nDescription=SuDuo M1 local Codex service\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${root}\nEnvironmentFile=${envPath}\nExecStart=${process.execPath} ${resolve(root, "server", "dist", "main.js")}\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`,
  { mode: 0o644 },
);

if (!skipDoctor) {
  run(
    process.execPath,
    [
      resolve(root, "node_modules", "tsx", "dist", "cli.mjs"),
      resolve(root, "scripts", "doctor.ts"),
      "--codex-home",
      codexHome,
      "--codex-bin",
      codexBin,
      "--port",
      port,
    ],
    root,
  );
}

if (!noEnable) {
  if (home !== resolve(homedir())) {
    run("systemctl", ["--user", "link", servicePath], root);
  }
  run("systemctl", ["--user", "daemon-reload"], root);
  run("systemctl", ["--user", "enable", "--now", serviceName], root);
}

process.stdout.write(
  JSON.stringify(
    {
      status: "installed",
      home,
      configDir,
      dataDir,
      servicePath,
      serviceName,
      codexHome,
      enabled: !noEnable,
    },
    null,
    2,
  ) + "\n",
);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed`);
  }
}

function systemdQuote(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeServiceName(value) {
  const name = value.endsWith(".service") ? value : value + ".service";
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(name)) {
    throw new Error(t.invalidServiceName);
  }
  return name;
}
