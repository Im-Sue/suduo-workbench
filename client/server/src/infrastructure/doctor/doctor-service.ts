import { execFile, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { CODEX_VERSION, type JsonValue } from "@suduo/client-contracts";
import { openBetterSqlite3Database } from "../db/better-sqlite3-database.js";
import { runMigrations } from "../db/migration-runner.js";
import {
  defaultSuDuoConfigDir,
  defaultSuDuoDataDir,
} from "../platform/host-platform.js";
import {
  decodeWindowsCommandOutput,
  formatWindowsCommandOutput,
} from "../platform/windows-command-output.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  /** Codex doctor 的原始 check id；SuDuo 自身检查没有该字段。 */
  id?: string;
  category?: string;
  /** 官方已脱敏详情，供后续诊断页按需展示。 */
  details?: JsonValue;
  remediation?: string | null;
  /** 保留官方状态（ok / warning / fail），不把 warning 伪装为 pass。 */
  officialStatus?: string;
}

export interface CodexDoctorCommandResult {
  status: number | null;
  stdout: Buffer | null;
  stderr: Buffer | null;
}

export type CodexDoctorRunner = (
  codexBin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsHide: boolean },
) => CodexDoctorCommandResult;

export interface DoctorOptions {
  installed: boolean;
  allowPortInUse: boolean;
  port: number;
  codexHome: string;
  codexBin: string;
  checkPnpm?: boolean;
  codexDoctorRunner?: CodexDoctorRunner;
  /** 测试注入：Linux 沙箱探测与宿主信息。 */
  linuxSandbox?: Partial<LinuxSandboxHost>;
}

/** Linux 沙箱探测依赖的宿主信息（测试可替换）。 */
export interface LinuxSandboxHost {
  platform: NodeJS.Platform;
  /** 在临时目录里用 Codex 沙箱跑一条命令（异步，带超时）。 */
  probe: (
    codexBin: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
  ) => Promise<CodexDoctorCommandResult & { timedOut?: boolean }>;
  /** PATH 上第一个 bwrap；没有为 null。Codex 优先用它，没有才用自带的。 */
  systemBwrap: () => string | null;
  /** /proc/sys/kernel/apparmor_restrict_unprivileged_userns 是否为 1（读不到为 null）。 */
  usernsRestricted: () => boolean | null;
  /** 是否作为 systemd 服务在跑（systemd 给服务进程设 INVOCATION_ID）。 */
  underSystemdService: () => boolean;
  /** 是否跑在容器里（容器里读到的 AppArmor 开关是宿主机的，处理办法不同）。 */
  inContainer: () => boolean;
}

export interface DoctorResult {
  status: "PASS" | "FAIL";
  codexHome: string;
  platform: NodeJS.Platform;
  mode: "installed" | "source";
  configDir: string;
  dataDir: string;
  port: number;
  checkedAt: string;
  checks: DoctorCheck[];
}

export async function runDoctor(
  options: DoctorOptions,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  checkVersion(checks, "Node.js", process.version.slice(1), "24.10.0");
  if (options.checkPnpm ?? !options.installed) {
    checkCommandVersion(checks, "pnpm", ["--version"], "10.25.0");
  }
  checkCodex(checks, options);
  await checkLinuxSandbox(checks, options);
  checkDatabaseAddon(checks);
  await checkPort(checks, options.port, options.allowPortInUse);
  const failed = checks.filter((check) => check.status === "fail");
  return {
    status: failed.length === 0 ? "PASS" : "FAIL",
    codexHome: options.codexHome,
    platform: process.platform,
    mode: options.installed ? "installed" : "source",
    configDir: options.installed
      ? options.codexHome
      : defaultSuDuoConfigDir(),
    dataDir: process.env["SUDUO_DATA_DIR"] ?? defaultSuDuoDataDir(),
    port: options.port,
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export function formatDoctorText(result: DoctorResult): string {
  const lines = [
    "SuDuo Doctor",
    `status=${result.status}`,
    `checkedAt=${result.checkedAt}`,
    `platform=${result.platform}`,
    `mode=${result.mode}`,
    `codexHome=${result.codexHome}`,
    `dataDir=${result.dataDir}`,
    `port=${String(result.port)}`,
    "",
    ...result.checks.map(
      (check) =>
        `${check.status.toUpperCase()} ${check.name}: ${check.message}` +
        (check.remediation ? `\n  remediation: ${check.remediation}` : ""),
    ),
  ];
  return lines.join("\n") + "\n";
}

function checkVersion(
  checks: DoctorCheck[],
  name: string,
  actual: string,
  expected: string,
): void {
  checks.push({
    name,
    status: actual === expected ? "pass" : "fail",
    message:
      actual === expected
        ? `${actual}（已锁定）`
        : `需要 ${expected}，当前为 ${actual}`,
  });
}

function checkCommandVersion(
  checks: DoctorCheck[],
  command: string,
  args: string[],
  expected: string,
): void {
  const result = spawnSync(command, args, { encoding: null, windowsHide: true });
  if (process.platform === "win32") {
    checks.push({
      name: command,
      status: result.status === 0 ? "pass" : "fail",
      message:
        result.status === 0
          ? `命令可执行（项目锁定 ${expected}）；输出仅供诊断：${formatWindowsCommandOutput(result.stdout)}`
          : `命令执行失败 status=${String(result.status)}；stderr：${formatWindowsCommandOutput(result.stderr)}`,
    });
    return;
  }
  const actual =
    result.status === 0
      ? decodeWindowsCommandOutput(result.stdout).utf8.trim()
      : "不可用";
  checkVersion(checks, command, actual, expected);
}

function checkCodex(checks: DoctorCheck[], options: DoctorOptions): void {
  const runner = options.codexDoctorRunner ?? defaultCodexDoctorRunner;
  const result = runner(options.codexBin, ["doctor", "--json"], {
    env: { ...process.env, CODEX_HOME: options.codexHome },
    windowsHide: true,
  });

  let report: OfficialDoctorReport;
  try {
    report = parseOfficialDoctorReport(result.stdout);
  } catch (error) {
    checks.push({
      name: "Codex 官方诊断",
      status: "fail",
      message:
        result.status === 0
          ? "codex doctor --json 返回无效 JSON：" + messageOf(error)
          : "codex doctor --json 执行失败 status=" +
            String(result.status) +
            "；stderr：" +
            formatWindowsCommandOutput(result.stderr),
    });
    return;
  }

  const officialChecks = Object.values(report.checks).map((value) => {
    const check = requireObject(value, "codex doctor check");
    return {
      id: stringField(check, "id") ?? "unknown",
      category: stringField(check, "category") ?? "general",
      status: stringField(check, "status"),
      summary: stringField(check, "summary") ?? "未提供摘要",
      remediation: nullableStringField(check, "remediation"),
      details: check["details"] as JsonValue | undefined,
    };
  });
  const blockingOfficialFailure = officialChecks.some((check) => severityOf(check) === "fail");
  const nonBlockingOfficialFailure = officialChecks.some((check) => severityOf(check) === "warn");

  // doctor 的非零退出码表示诊断结论（overallStatus=fail），不是命令无法执行。
  // 汇总项以逐项门禁判读，不让 workspace 锁版下必然失败的 npm 全局更新检查阻断启动。
  checks.push({
    name: "Codex 官方诊断",
    status: blockingOfficialFailure ? "fail" : nonBlockingOfficialFailure ? "warn" : "pass",
    message: "overallStatus=" + report.overallStatus,
    officialStatus: report.overallStatus,
  });

  const codexVersion = stringField(report.value, "codexVersion");
  checks.push({
    name: "Codex CLI",
    status: codexVersion === CODEX_VERSION ? "pass" : "fail",
    message:
      codexVersion === CODEX_VERSION
        ? `codex-cli ${codexVersion}（workspace 锁定版本）`
        : `需要 codex-cli ${CODEX_VERSION}，当前为 ${codexVersion ?? "未知"}`,
  });

  // codex doctor --json 的 checks 是以 check id 为键的对象，不能当数组处理。
  for (const check of officialChecks) {
    checks.push({
      name: `Codex · ${check.category} · ${check.id}`,
      status: severityOf(check),
      message: check.summary,
      id: check.id,
      category: check.category,
      ...(check.details === undefined ? {} : { details: check.details }),
      remediation: check.remediation,
      ...(check.status === null ? {} : { officialStatus: check.status }),
    });
  }
  if (officialChecks.length === 0) {
    checks.push({
      name: "Codex 官方诊断",
      status: "fail",
      message:
        "codex doctor --json 未返回任何检查项（overallStatus=" +
        report.overallStatus +
        "）",
    });
  }
}

/**
 * 这两项只判断 npm 全局自更新能否命中当前安装；SuDuo 固定使用 workspace 钉版 Codex，
 * 因而它们会结构性失败，却不影响运行能力。保留原始失败与 remediation，但不作为启动门禁。
 */
const NON_BLOCKING_OFFICIAL_CHECK_IDS = new Set(["installation", "updates.status"]);

function isNonBlockingOfficialCheck(id: string): boolean {
  return NON_BLOCKING_OFFICIAL_CHECK_IDS.has(id);
}

/**
 * 官方三档：ok → 通过；warning → 需留意（不阻断，例如新版里「桌面端安全评估不可用」「桌面端更新 CDN 不可达」
 * 这类与 SuDuo 无关的桌面端检查）；fail 及未知状态 → 失败（上面两项结构性失败除外）。
 */
function severityOf(check: { id: string; status: string | null }): DoctorCheck["status"] {
  if (check.status === "ok") return "pass";
  if (check.status === "warning" || isNonBlockingOfficialCheck(check.id)) return "warn";
  return "fail";
}

const defaultCodexDoctorRunner: CodexDoctorRunner = (codexBin, args, options) =>
  spawnSync(codexBin, args, { encoding: null, ...options });

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " 必须是 object");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function nullableStringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return value[key] === null ? null : stringField(value, key);
}

interface OfficialDoctorReport {
  value: Record<string, unknown>;
  overallStatus: string;
  checks: Record<string, unknown>;
}

function parseOfficialDoctorReport(stdout: Buffer | null): OfficialDoctorReport {
  const value = requireObject(
    JSON.parse(decodeWindowsCommandOutput(stdout).utf8),
    "codex doctor --json",
  );
  if (typeof value["schemaVersion"] !== "number") {
    throw new Error("codex doctor --json 缺少 schemaVersion");
  }
  const overallStatus = stringField(value, "overallStatus");
  if (overallStatus === null) {
    throw new Error("codex doctor --json 缺少 overallStatus");
  }
  return {
    value,
    overallStatus,
    checks: requireObject(value["checks"], "codex doctor checks"),
  };
}

const SANDBOX_PROBE_MARKER = "suduo-sandbox-ok";
const SANDBOX_PROBE_TIMEOUT_MS = 30_000;
const SANDBOXING_DOCS = "https://developers.openai.com/codex/concepts/sandboxing";
const UBUNTU_2404_APPARMOR_FIX =
  "sudo apt update && sudo apt install apparmor-profiles apparmor-utils && " +
  "sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict && " +
  "sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict";
/** bubblewrap / 命名空间相关的报错（与 Codex 判断沙箱不可用时匹配的一致）。 */
const NAMESPACE_FAILURE = /bwrap|namespace|RTM_NEWADDR|RTM_NEWLINK|uid map|Operation not permitted/i;

/**
 * Linux 上 Codex 用 bubblewrap 做沙箱：PATH 上有系统 bwrap 就用它，否则用自带的（需要非特权用户命名空间）。
 * Ubuntu 24.04 默认用 AppArmor 限制非特权用户命名空间，没装官方放行配置时两者都建不了网络命名空间，
 * 需要审批或受限执行的命令会全部失败——而 codex doctor 的沙箱项仍报 ok。这里真跑一条沙箱命令来判断，
 * 起不来时按官方沙箱前置条件给出处理办法。
 *
 * 只告知、不阻断（ADR-0004）：沙箱起不来时服务照样能装能跑，受影响的是需要沙箱的命令，
 * 人照着处理办法就能自己恢复；所以记为「需留意」，不让安装或启动失败。
 */
async function checkLinuxSandbox(checks: DoctorCheck[], options: DoctorOptions): Promise<void> {
  const host: LinuxSandboxHost = { ...defaultLinuxSandboxHost, ...options.linuxSandbox };
  if (host.platform !== "linux") return;
  const name = "Codex 沙箱（Linux）";
  const workdir = mkdtempSync(resolve(tmpdir(), "suduo-sandbox-probe-"));
  try {
    const result = await host.probe(
      options.codexBin,
      ["sandbox", "--permission-profile", ":workspace", "-C", workdir, "--", "/bin/sh", "-c", `echo ${SANDBOX_PROBE_MARKER}`],
      { env: { ...process.env, CODEX_HOME: options.codexHome }, cwd: workdir, timeoutMs: SANDBOX_PROBE_TIMEOUT_MS },
    );
    const stdout = decodeWindowsCommandOutput(result.stdout).utf8;
    const stderr = decodeWindowsCommandOutput(result.stderr).utf8;
    const systemBwrap = host.systemBwrap();
    if (result.status === 0 && stdout.includes(SANDBOX_PROBE_MARKER)) {
      checks.push(
        systemBwrap !== null
          ? { name, status: "pass", message: `沙箱可用，使用系统的 bubblewrap（${systemBwrap}）` }
          : {
              name,
              status: "warn",
              message: "沙箱可用，但用的是 Codex 自带的 bubblewrap；官方建议安装系统的 bubblewrap",
              remediation: `sudo apt install bubblewrap（Fedora：sudo dnf install bubblewrap）。详见 ${SANDBOXING_DOCS}`,
            },
      );
      return;
    }
    if (result.timedOut) {
      checks.push({
        name,
        status: "warn",
        message: `沙箱命令 ${String(SANDBOX_PROBE_TIMEOUT_MS / 1000)} 秒内没有结束，没能确认沙箱是否可用`,
        remediation: "稍后在诊断页重新检查；一直这样时，在终端里运行 codex sandbox -P :workspace -- true 看看卡在哪里",
      });
      return;
    }
    const detail = lastLine(stderr) ?? `退出码 ${String(result.status)}`;
    if (result.status === null || !NAMESPACE_FAILURE.test(stderr)) {
      // 不是命名空间的问题（Codex 本身没跑起来、配置读不了等）：不把它说成 bubblewrap 的毛病。
      checks.push({
        name,
        status: "warn",
        message: `没能运行 Codex 的沙箱命令，无法确认沙箱是否可用（${detail}）`,
        remediation: "先处理上面「Codex 官方诊断」「Codex CLI」里的问题，再回来重新检查",
      });
      return;
    }
    const container = host.inContainer();
    const restricted = host.usernsRestricted();
    const causes = container
      ? ["SuDuo 跑在容器里，容器默认不允许创建用户命名空间"]
      : [
          ...(systemBwrap === null ? ["没有安装系统的 bubblewrap"] : []),
          ...(restricted === true ? ["系统用 AppArmor 限制了非特权用户命名空间（Ubuntu 24.04 默认如此）"] : []),
        ];
    const steps = container
      ? ["让容器允许创建用户命名空间（例如 Docker 加 --security-opt seccomp=unconfined --security-opt apparmor=unconfined），或把 SuDuo 装在宿主机上"]
      : [
          ...(systemBwrap === null ? ["sudo apt install bubblewrap（Fedora：sudo dnf install bubblewrap）"] : []),
          ...(restricted === true ? [`加载官方的 AppArmor 放行配置：${UBUNTU_2404_APPARMOR_FIX}`] : []),
          // 旧版安装脚本生成的服务配置带 PrivateTmp，会让服务进程落进受限的用户命名空间（见 scripts/install.mjs）。
          ...(restricted === true && host.underSystemdService()
            ? ["SuDuo 是作为系统服务在跑：重新运行安装（pnpm install:m1）更新服务配置后重启服务"]
            : []),
        ];
    checks.push({
      name,
      status: "warn",
      message:
        "Codex 的沙箱在这台机器上起不来，需要审批或受限执行的命令都会失败" +
        (causes.length > 0 ? `：${causes.join("；")}` : "") +
        `（${detail}）`,
      remediation:
        (steps.length > 0 ? steps.join("；然后 ") + "。" : "") +
        `按 OpenAI 的沙箱前置条件处理：${SANDBOXING_DOCS}` +
        (!container && restricted === true
          ? "；若仍不行，可退一步放开限制：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
          : ""),
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

const defaultLinuxSandboxHost: LinuxSandboxHost = {
  platform: process.platform,
  probe: (codexBin, args, options) =>
    new Promise((resolveProbe) => {
      // 异步跑：诊断页在服务进程里调用，spawnSync 会把整个事件循环卡住最多 30 秒。
      execFile(
        codexBin,
        args,
        { env: options.env, cwd: options.cwd, timeout: options.timeoutMs, encoding: "buffer", maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolveProbe({
            status: failure === null ? 0 : typeof failure.code === "number" ? failure.code : null,
            stdout,
            stderr,
            timedOut: failure?.killed === true,
          });
        },
      );
    }),
  systemBwrap: () => {
    for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
      if (directory === "") continue;
      const candidate = resolve(directory, "bwrap");
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // 不在这个目录里。
      }
    }
    return null;
  },
  usernsRestricted: () => {
    try {
      return readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
    } catch {
      return null;
    }
  },
  underSystemdService: () => process.env["INVOCATION_ID"] !== undefined,
  inContainer: () => existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
};

function lastLine(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? null;
}

function checkDatabaseAddon(checks: DoctorCheck[]): void {
  const directory = mkdtempSync(resolve(tmpdir(), "suduo-doctor-"));
  const path = resolve(directory, "doctor.sqlite");
  try {
    const database = openBetterSqlite3Database(path);
    runMigrations(database);
    database.exec("CREATE TABLE doctor_check (value TEXT NOT NULL) STRICT;");
    database.prepare("INSERT INTO doctor_check (value) VALUES (@value)").run({
      value: "ok",
    });
    const row = database
      .prepare("SELECT value FROM doctor_check")
      .get<{ value: string }>();
    database.close();
    if (row?.value !== "ok") {
      throw new Error("temporary WAL read-back mismatch");
    }
    checks.push({
      name: "better-sqlite3",
      status: "pass",
      message: "原生 addon 可加载，临时库 migration/WAL 写读正常",
    });
  } catch (error) {
    checks.push({
      name: "better-sqlite3",
      status: "fail",
      message: messageOf(error),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function checkPort(
  checks: DoctorCheck[],
  port: number,
  allowPortInUse: boolean,
): Promise<void> {
  const server = createServer();
  const available = await new Promise<boolean>((resolveCheck) => {
    server.once("error", () => resolveCheck(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveCheck(true));
    });
  });
  checks.push({
    name: "监听端口",
    status: available || allowPortInUse ? "pass" : "fail",
    message: available
      ? `127.0.0.1:${String(port)} 可用`
      : allowPortInUse
        ? `127.0.0.1:${String(port)} 已占用（服务正在运行）`
        : `127.0.0.1:${String(port)} 已被占用`,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
