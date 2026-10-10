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
import {
  CODEX_VERSION,
  SUDUO_DOCTOR_CHECK_IDS,
  type AgentDto,
  type AgentListDto,
  type DoctorCheckDto,
  type DoctorResultDto,
  type JsonValue,
  type Locale,
} from "@suduo/client-contracts";
import { messagesFor, type ServerMessages } from "../../i18n/messages/index.js";
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

/** 一项检查：SuDuo 自己的项 id 见 SUDUO_DOCTOR_CHECK_IDS，Codex 官方项是官方的 check id。 */
export type DoctorCheck = DoctorCheckDto;

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
  /** 各家 Agent 的检测结果（多 Agent S12）；不给就不查 Codex 以外的 Agent。 */
  agents?: () => Promise<AgentListDto>;
  /**
   * 不等检测、手上已有的结果（还没测完的是「检测中」）。给了它，诊断最多等 agentsWaitMs（默认 5 秒）就用它：
   * 冷启动时各家读版本、查登录要几十秒，不能拖住设置页与首启向导的环境检查。命令行不给，等测完。
   */
  agentsNow?: () => AgentListDto;
  agentsWaitMs?: number;
  /** 本机工具服务的地址（服务里跑诊断时给；命令行没有服务在跑，不查这一项）。 */
  toolServerUrl?: () => string | null;
  /** 测试注入：Git 检查用到的宿主信息。 */
  gitHost?: Partial<GitHost>;
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

export interface DoctorResult extends DoctorResultDto {
  platform: NodeJS.Platform;
}

/** 检查项的名称、结论与处理建议按 locale 生成（/api/v1/doctor 用请求语言）。 */
export async function runDoctor(
  options: DoctorOptions,
  locale: Locale,
): Promise<DoctorResult> {
  const t = messagesFor(locale);
  const checks: DoctorCheck[] = [];
  // 各家 Agent 的检测先开始，和下面的 Codex 检查一起跑。
  const agentsPending = options.agents?.().catch(() => null);
  checkNodeVersion(checks, t, process.version.slice(1), "24.10.0");
  if (options.checkPnpm ?? !options.installed) {
    checkCommandVersion(checks, t, SUDUO_DOCTOR_CHECK_IDS.pnpm, "pnpm", ["--version"], "10.25.0");
  }
  const beforeCodex = checks.length;
  checkCodex(checks, t, options);
  await checkLinuxSandbox(checks, t, options);
  // Codex 的各项（官方诊断、CLI 版本、Linux 沙箱）归到 Codex 一组。
  for (const check of checks.slice(beforeCodex)) check.agentId = "codex";
  if (agentsPending !== undefined) {
    const now = options.agentsNow;
    const list =
      now === undefined
        ? await agentsPending
        : await Promise.race([
            agentsPending,
            new Promise<AgentListDto | null>((resolve) => {
              setTimeout(() => resolve(now()), options.agentsWaitMs ?? 5_000).unref();
            }),
          ]);
    if (list !== null && list !== undefined) checkAgents(checks, t, list);
  }
  if (options.toolServerUrl !== undefined) checkToolServer(checks, t, options.toolServerUrl());
  checkGit(checks, t, { ...defaultGitHost(), ...options.gitHost });
  checkDatabaseAddon(checks, t);
  await checkPort(checks, t, options.port, options.allowPortInUse);
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
  const line = (check: DoctorCheck) =>
    `${check.status.toUpperCase()} ${check.name}: ${check.message}` + (check.remediation ? `\n  remediation: ${check.remediation}` : "");
  // SuDuo 自己的环境项在前，各家 Agent 的项按 Agent 分组（多 Agent S12）。
  const groups = new Map<string, DoctorCheck[]>();
  for (const check of result.checks) {
    if (check.agentId === undefined) continue;
    groups.set(check.agentId, [...(groups.get(check.agentId) ?? []), check]);
  }
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
    ...result.checks.filter((check) => check.agentId === undefined).map(line),
    ...[...groups].flatMap(([agentId, checks]) => ["", `[${agentId}]`, ...checks.map(line)]),
  ];
  return lines.join("\n") + "\n";
}

/**
 * 各家 Agent（多 Agent S12）：可执行文件、版本（在不在验证过的范围）、登录状态，一家一项。只查启用了的、
 * 装了的（没装的只在它是默认 Agent 时提一句）；Codex 有自己的几项，这里不重复。版本没验证过只提示（ADR-0004）。
 * 只有版本低于最低要求算失败，别的都是提醒：缺一家 Agent 不影响 SuDuo 启动。
 */
export function checkAgents(checks: DoctorCheck[], t: ServerMessages, list: AgentListDto): void {
  const text = t.doctor.agent;
  for (const agent of list.agents) {
    if (agent.bundled || !agent.enabled) continue;
    if (agent.status === "not_installed" && agent.id !== list.defaultAgentId) continue;
    const notes: string[] = [];
    let status: DoctorCheck["status"] = "pass";
    let remediation: string | null = null;
    switch (agent.status) {
      case "ready":
        notes.push(text.ready(agent.version));
        break;
      case "installed":
        notes.push(agent.reasonCode === "check_timeout" ? text.checkTimeout : text.installed(agent.version));
        break;
      case "auth_required":
        status = "warn";
        notes.push(text.authRequired(agent.version));
        remediation = loginRemediation(agent, t);
        break;
      case "not_installed":
        status = "warn";
        notes.push(text.notInstalledDefault);
        remediation = text.installRemediation(agent.homepageUrl);
        break;
      case "version_unsupported":
        status = "fail";
        notes.push(text.versionUnsupported(agent.version ?? "?", agent.minVersion ?? "?"));
        break;
      case "checking":
        status = "warn";
        notes.push(text.checking);
        break;
      case "error":
        status = "warn";
        notes.push(text.error(agent.reasonDetail ?? agent.reasonCode ?? "?"));
        break;
    }
    if (agent.versionVerified === false && agent.version !== null) {
      if (status === "pass") status = "warn";
      notes.push(text.unverified(agent.version, agent.verifiedVersions.join(", ")));
    }
    if (agent.executablePath !== null) notes.push(text.path(agent.executablePath));
    checks.push({
      id: SUDUO_DOCTOR_CHECK_IDS.agent,
      name: agent.displayName,
      status,
      message: notes.join(text.separator),
      remediation,
      version: agent.version,
      agentId: agent.id,
    });
  }
}

function loginRemediation(agent: AgentDto, t: ServerMessages): string | null {
  const login = agent.actions.find((action) => action.kind === "open_terminal_login")?.command;
  return login === undefined ? null : t.doctor.agent.loginRemediation(login);
}

/** 本机工具服务（ADR-0015）：Codex 以外的 Agent 经它用 SuDuo 的工具。 */
function checkToolServer(checks: DoctorCheck[], t: ServerMessages, url: string | null): void {
  checks.push({
    id: SUDUO_DOCTOR_CHECK_IDS.toolServer,
    name: t.doctor.names.toolServer,
    status: url === null ? "warn" : "pass",
    message: url === null ? t.doctor.toolServer.notListening : t.doctor.toolServer.listening(url),
  });
}

/** actual 为 null：命令不可用。 */
/**
 * Node.js：同一大版本、不低于最低版本即可（与 package.json 的 engines、pnpm start 一致）。
 * 桌面应用捆绑的是 24 的较新补丁版本，源码运行的使用者也常装最新的 24.x，不要求逐字等于开发环境锁定的版本。
 */
export function checkNodeVersion(checks: DoctorCheck[], t: ServerMessages, actual: string, minimum: string): void {
  const parse = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10));
  const [major, minor = 0, patch = 0] = parse(actual);
  const [wantMajor, wantMinor = 0, wantPatch = 0] = parse(minimum);
  const ok =
    major === wantMajor &&
    (minor > wantMinor || (minor === wantMinor && patch >= wantPatch));
  checks.push({
    id: SUDUO_DOCTOR_CHECK_IDS.node,
    name: "Node.js",
    status: ok ? "pass" : "fail",
    message: ok ? t.doctor.version.supported(actual, minimum) : t.doctor.version.belowMinimum(minimum, actual),
  });
}

function checkVersion(
  checks: DoctorCheck[],
  t: ServerMessages,
  id: string,
  name: string,
  actual: string | null,
  expected: string,
): void {
  checks.push({
    id,
    name,
    status: actual === expected ? "pass" : "fail",
    message:
      actual === expected
        ? t.doctor.version.pinned(actual)
        : t.doctor.version.mismatch(expected, actual),
  });
}

function checkCommandVersion(
  checks: DoctorCheck[],
  t: ServerMessages,
  id: string,
  command: string,
  args: string[],
  expected: string,
): void {
  const result = spawnSync(command, args, { encoding: null, windowsHide: true });
  if (process.platform === "win32") {
    checks.push({
      id,
      name: command,
      status: result.status === 0 ? "pass" : "fail",
      message:
        result.status === 0
          ? t.doctor.command.windowsOk(expected, formatWindowsCommandOutput(result.stdout))
          : t.doctor.command.windowsFailed(String(result.status), formatWindowsCommandOutput(result.stderr)),
    });
    return;
  }
  const actual =
    result.status === 0
      ? decodeWindowsCommandOutput(result.stdout).utf8.trim()
      : null;
  checkVersion(checks, t, id, command, actual, expected);
}

function checkCodex(checks: DoctorCheck[], t: ServerMessages, options: DoctorOptions): void {
  const runner = options.codexDoctorRunner ?? defaultCodexDoctorRunner;
  const result = runner(options.codexBin, ["doctor", "--json"], {
    env: { ...process.env, CODEX_HOME: options.codexHome },
    windowsHide: true,
  });

  let report: OfficialDoctorReport;
  try {
    report = parseOfficialDoctorReport(result.stdout, t);
  } catch (error) {
    checks.push({
      id: SUDUO_DOCTOR_CHECK_IDS.codexDoctor,
      name: t.doctor.names.codexDoctor,
      status: "fail",
      message:
        result.status === 0
          ? t.doctor.codex.invalidJson(messageOf(error))
          : t.doctor.codex.runFailed(String(result.status), formatWindowsCommandOutput(result.stderr)),
    });
    return;
  }

  const officialChecks = Object.values(report.checks).map((value) => {
    const check = requireObject(value, "codex doctor check", t);
    return {
      id: stringField(check, "id") ?? "unknown",
      category: stringField(check, "category") ?? "general",
      status: stringField(check, "status"),
      summary: stringField(check, "summary") ?? t.doctor.codex.noSummary,
      remediation: nullableStringField(check, "remediation"),
      details: check["details"] as JsonValue | undefined,
    };
  });
  const blockingOfficialFailure = officialChecks.some((check) => severityOf(check) === "fail");
  const nonBlockingOfficialFailure = officialChecks.some((check) => severityOf(check) === "warn");

  // doctor 的非零退出码表示诊断结论（overallStatus=fail），不是命令无法执行。
  // 汇总项以逐项门禁判读，不让 workspace 锁版下必然失败的 npm 全局更新检查阻断启动。
  checks.push({
    id: SUDUO_DOCTOR_CHECK_IDS.codexDoctor,
    name: t.doctor.names.codexDoctor,
    status: blockingOfficialFailure ? "fail" : nonBlockingOfficialFailure ? "warn" : "pass",
    message: "overallStatus=" + report.overallStatus,
    officialStatus: report.overallStatus,
  });

  const codexVersion = stringField(report.value, "codexVersion");
  checks.push({
    id: SUDUO_DOCTOR_CHECK_IDS.codexCli,
    name: "Codex CLI",
    status: codexVersion === CODEX_VERSION ? "pass" : "fail",
    message:
      codexVersion === CODEX_VERSION
        ? t.doctor.codex.cliPinned(codexVersion)
        : t.doctor.codex.cliMismatch(CODEX_VERSION, codexVersion),
    // 前端直接读版本，不从说明文字里抠。
    version: codexVersion,
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
      id: SUDUO_DOCTOR_CHECK_IDS.codexDoctorEmpty,
      name: t.doctor.names.codexDoctor,
      status: "fail",
      message: t.doctor.codex.noChecks(report.overallStatus),
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

/** 抛出的说明会拼进检查结论，所以按本次自检的语言写。 */
function requireObject(value: unknown, label: string, t: ServerMessages): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t.doctor.codex.mustBeObject(label));
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

function parseOfficialDoctorReport(stdout: Buffer | null, t: ServerMessages): OfficialDoctorReport {
  const value = requireObject(
    JSON.parse(decodeWindowsCommandOutput(stdout).utf8),
    "codex doctor --json",
    t,
  );
  if (typeof value["schemaVersion"] !== "number") {
    throw new Error(t.doctor.codex.missingField("schemaVersion"));
  }
  const overallStatus = stringField(value, "overallStatus");
  if (overallStatus === null) {
    throw new Error(t.doctor.codex.missingField("overallStatus"));
  }
  return {
    value,
    overallStatus,
    checks: requireObject(value["checks"], "codex doctor checks", t),
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
async function checkLinuxSandbox(checks: DoctorCheck[], t: ServerMessages, options: DoctorOptions): Promise<void> {
  const host: LinuxSandboxHost = { ...defaultLinuxSandboxHost, ...options.linuxSandbox };
  if (host.platform !== "linux") return;
  const id = SUDUO_DOCTOR_CHECK_IDS.linuxSandbox;
  const name = t.doctor.names.linuxSandbox;
  const text = t.doctor.sandbox;
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
          ? { id, name, status: "pass", message: text.readySystem(systemBwrap) }
          : {
              id,
              name,
              status: "warn",
              message: text.readyBundled,
              remediation: text.readyBundledRemediation(SANDBOXING_DOCS),
            },
      );
      return;
    }
    if (result.timedOut) {
      checks.push({
        id,
        name,
        status: "warn",
        message: text.timedOut(SANDBOX_PROBE_TIMEOUT_MS / 1000),
        remediation: text.timedOutRemediation,
      });
      return;
    }
    const detail = lastLine(stderr) ?? text.exitCode(String(result.status));
    if (result.status === null || !NAMESPACE_FAILURE.test(stderr)) {
      // 不是命名空间的问题（Codex 本身没跑起来、配置读不了等）：不把它说成 bubblewrap 的毛病。
      checks.push({
        id,
        name,
        status: "warn",
        message: text.notRun(detail),
        remediation: text.notRunRemediation,
      });
      return;
    }
    const container = host.inContainer();
    const restricted = host.usernsRestricted();
    const causes = container
      ? [text.causes.container]
      : [
          ...(systemBwrap === null ? [text.causes.noSystemBwrap] : []),
          ...(restricted === true ? [text.causes.apparmorRestricted] : []),
        ];
    const steps = container
      ? [text.steps.container]
      : [
          ...(systemBwrap === null ? [text.steps.installBwrap] : []),
          ...(restricted === true ? [text.steps.loadApparmorProfile(UBUNTU_2404_APPARMOR_FIX)] : []),
          // 旧版安装脚本生成的服务配置带 PrivateTmp，会让服务进程落进受限的用户命名空间（见 scripts/install.mjs）。
          ...(restricted === true && host.underSystemdService() ? [text.steps.reinstallService] : []),
        ];
    checks.push({
      id,
      name,
      status: "warn",
      message: text.unavailable(causes, detail),
      remediation: text.remediation(steps, SANDBOXING_DOCS, !container && restricted === true),
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

/** Git 检查用到的宿主信息（测试可替换）。 */
export interface GitHost {
  platform: NodeJS.Platform;
  /** 跑一条命令，取退出码与输出；命令不存在时 status 为 null。 */
  run(command: string, args: string[]): { status: number | null; stdout: string };
}

function defaultGitHost(): GitHost {
  return {
    platform: process.platform,
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      return { status: result.error === undefined ? result.status : null, stdout: typeof result.stdout === "string" ? result.stdout : "" };
    },
  };
}

/**
 * Git（桌面应用 D2，需求 4.6）：检查点等功能要用，所有运行形态都查。没装只提醒、给安装引导，不拦启动。
 * Mac 上先用 `xcode-select -p` 看装没装命令行工具：没装时 /usr/bin/git 会弹系统的安装对话框，不能在自检里意外触发。
 */
export function checkGit(checks: DoctorCheck[], t: ServerMessages, host: GitHost): void {
  const text = t.doctor.git;
  const missing = (message: string): void => {
    checks.push({
      id: SUDUO_DOCTOR_CHECK_IDS.git,
      name: "Git",
      status: "warn",
      message,
      remediation: host.platform === "darwin" ? text.installMac : host.platform === "win32" ? text.installWindows : text.installLinux,
    });
  };
  if (host.platform === "darwin" && host.run("xcode-select", ["-p"]).status !== 0) {
    missing(text.noCommandLineTools);
    return;
  }
  const result = host.run("git", ["--version"]);
  const version = /git version (\S+)/u.exec(result.stdout)?.[1] ?? null;
  if (result.status !== 0 || version === null) {
    missing(text.missing);
    return;
  }
  checks.push({ id: SUDUO_DOCTOR_CHECK_IDS.git, name: "Git", status: "pass", message: text.ok(version), version });
}

function checkDatabaseAddon(checks: DoctorCheck[], t: ServerMessages): void {
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
      id: SUDUO_DOCTOR_CHECK_IDS.sqlite,
      name: "better-sqlite3",
      status: "pass",
      message: t.doctor.sqlite.ok,
    });
  } catch (error) {
    checks.push({
      id: SUDUO_DOCTOR_CHECK_IDS.sqlite,
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
  t: ServerMessages,
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
  // 端口被占用时先看是不是 SuDuo 自己：SuDuo 正在运行时跑自检是常见用法，不算失败。
  const suDuoRunning = !available && !allowPortInUse && (await isSuDuoListening(port));
  const address = `127.0.0.1:${String(port)}`;
  checks.push({
    id: SUDUO_DOCTOR_CHECK_IDS.port,
    name: t.doctor.names.port,
    status: available || allowPortInUse || suDuoRunning ? "pass" : "fail",
    message: available
      ? t.doctor.port.available(address)
      : allowPortInUse || suDuoRunning
        ? t.doctor.port.inUseBySuDuo(address)
        : t.doctor.port.inUseByOther(address),
  });
}

async function isSuDuoListening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    const body = (await response.json().catch(() => null)) as { product?: unknown } | null;
    return response.ok && body?.product === "suduo";
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
