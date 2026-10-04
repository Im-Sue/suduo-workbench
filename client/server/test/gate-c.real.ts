/// <reference lib="dom" />

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_VERSION, type Locale } from "@suduo/client-contracts";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { startRequirementsServiceFixture } from "./gate-c/requirements-service-fixture.js";
import { gateCStepsFor, resolveGateCStepSelection } from "./gate-c/steps/registry.js";
import { runGateCSteps, type GateCStepContext } from "./gate-c/steps/types.js";
import { browserLocaleOf, gateLocaleFromEnv, loadGateUiText } from "./gate-c/ui-text.js";
import { untranslatedSummary } from "./gate-c/untranslated-audit.js";

const serverRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(serverRoot, "..");
const artifactRoot = resolve(workspaceRoot, "artifacts", "gate-c");
const projectRoot = resolve(artifactRoot, "project");
const installHome = resolve(artifactRoot, "install-home");
const evidenceDatabase = resolve(artifactRoot, "gate-c.sqlite");
const resultPath = resolve(artifactRoot, "result.json");
const serviceName = "suduo-gate-c.service";
const codexHome = process.env["SUDUO_CODEX_HOME"] ?? process.env["CODEX_HOME"];
const codexBin = resolve(workspaceRoot, "node_modules", ".bin", "codex");
const tsxCli = resolve(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs");
const doctorScript = resolve(workspaceRoot, "scripts", "doctor.ts");
const installScript = resolve(workspaceRoot, "scripts", "install.mjs");
const uninstallScript = resolve(workspaceRoot, "scripts", "uninstall.mjs");
// Debian 系多架构目录：gate-c 主机是 x86_64（WSL2），本机虚拟机（scripts/gate-c-vm.sh）在 Apple 芯片上是 aarch64。
const multiarch = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
const browserLibraryPath = resolve(
  workspaceRoot,
  ".cache",
  "playwright-libs",
  "usr",
  "lib",
  multiarch,
);
const systemBrowserLibraries = [
  `/usr/lib/${multiarch}/libasound.so.2`,
  "/usr/lib64/libasound.so.2",
  "/usr/lib/libasound.so.2",
];
const screenshots: string[] = [];

if (!codexHome) {
  throw new Error(
    "Gate C requires CODEX_HOME or SUDUO_CODEX_HOME with a usable model configuration",
  );
}

/**
 * 验收语言（中英双语技术设计 §五）：不设 `SUDUO_GATE_LOCALE` 时按中文跑全量，行为与改动前一致；
 * `SUDUO_GATE_LOCALE=en` 跑英文冒烟（另一组步骤，见 registry 的 gateCEnglishSteps）。
 * 界面文字从前端字典取，载入放在装服务之前：字典缺键要立刻失败。
 */
const gateLocale = gateLocaleFromEnv(process.env["SUDUO_GATE_LOCALE"]);
const gateRun = gateCStepsFor(gateLocale);
const ui = await loadGateUiText(gateLocale);

/**
 * 分片回归入口（PR1）：`GATE_C_STEPS=final-interrupt,assistant-approval` 只跑点名的
 * 步骤及其前置闭包。不设该变量时是全量，行为与改动前完全一致。
 * 解析放在装服务、开浏览器之前——名字写错要立刻失败，别先花一轮真实模型调用。
 */
const selection = resolveGateCStepSelection(
  gateRun.steps,
  process.env["GATE_C_STEPS"],
  gateRun.prerequisites,
);
if (selection.subset || gateLocale !== "zh-CN") {
  process.stdout.write(
    JSON.stringify({
      gate: "C",
      locale: gateLocale,
      mode: selection.subset ? "subset" : "full",
      requested: selection.requested,
      plan: selection.steps.map((step) => step.id),
    }) + "\n",
  );
}

await cleanupOldService();
rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(projectRoot, { recursive: true });
prepareProject(gateLocale);
const port = await availablePort();
const origin = "http://127.0.0.1:" + String(port);
const emptyCodexHome = resolve(artifactRoot, "empty-codex-home");
mkdirSync(emptyCodexHome, { recursive: true });
const requirementsFixture = await startRequirementsServiceFixture();

const doctorNormal = runCapture(
  process.execPath,
  [
    tsxCli,
    doctorScript,
    "--json",
    "--codex-home",
    codexHome,
    "--codex-bin",
    codexBin,
    "--port",
    String(port),
  ],
  0,
);
writeFileSync(resolve(artifactRoot, "doctor-normal.json"), doctorNormal.stdout);
const doctorMissing = runCapture(
  process.execPath,
  [
    tsxCli,
    doctorScript,
    "--json",
    "--codex-home",
    emptyCodexHome,
    "--codex-bin",
    codexBin,
    "--port",
    String(port),
  ],
  1,
);
writeFileSync(resolve(artifactRoot, "doctor-no-config.json"), doctorMissing.stdout);

let context: BrowserContext | null = null;
let browser: Browser | null = null;

try {
  const installation = runCapture(
    process.execPath,
    [
      installScript,
      "--home",
      installHome,
      "--codex-home",
      codexHome,
      "--port",
      String(port),
      "--service-name",
      serviceName,
      "--no-enable",
    ],
    0,
  );
  writeFileSync(resolve(artifactRoot, "install.log"), installation.stdout + installation.stderr);
  const servicePath = resolve(
    installHome,
    ".config",
    "systemd",
    "user",
    serviceName,
  );
  const envPath = resolve(installHome, ".config", "suduo", "suduo.env");
  appendFileSync(envPath, `SUDUO_REQUIREMENTS_SERVICE_URL=${requirementsFixture.origin}\n`);
  // pr9：设置页要验「部署侧锁定审批上限」的表达。安装器只写固定 SUDUO_* 白名单，
  // 所以在这里追加——gate-c 拥有自己的 install-home，不影响用户真实部署。
  appendFileSync(envPath, "SUDUO_MAX_APPROVAL_MODE=auto\n");
  runCapture("systemctl", ["--user", "link", servicePath], 0);
  runCapture("systemctl", ["--user", "daemon-reload"], 0);
  runCapture("systemctl", ["--user", "enable", "--now", serviceName], 0);
  const verify = runCapture(
    "systemd-analyze",
    ["--user", "verify", servicePath],
    0,
  );
  writeFileSync(resolve(artifactRoot, "systemd-verify.log"), verify.stdout + verify.stderr);
  await waitForHttpReady(origin, 30_000);

  ensureBrowserLibraries();
  browser = await chromium.launch({
    headless: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [browserLibraryPath, process.env["LD_LIBRARY_PATH"] ?? ""]
        .filter(Boolean)
        .join(":"),
    },
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    // 默认按中文验收（中英双语技术设计 §五）：浏览器语言决定「跟随系统」时的界面语言。
    locale: browserLocaleOf(gateLocale),
  });
  if (gateLocale !== "zh-CN") {
    // 英文冒烟同时固定本机的界面语言偏好（设置 › 外观 › 语言），不只靠「跟随系统」：两条路都要是英文。
    // 每次导航前写入，整轮（含另开的窗口）都是这个偏好。键名同前端 i18n/locale.ts 的 LOCALE_STORAGE_KEY。
    await context.addInitScript((value) => {
      try {
        window.localStorage.setItem("suduo.locale", value);
      } catch {
        // 存不了时只剩浏览器语言这一条路，步骤里的英文断言会暴露出来。
      }
    }, gateLocale);
  }
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const gateContext: GateCStepContext = {
    locale: gateLocale,
    ui,
    untranslated: [],
    codexBin,
    artifactRoot,
    projectRoot,
    origin,
    page,
    browserContext: context,
    screenshots,
    pageErrors: [],
    completedSteps: new Set<string>(),
    remoteProjectId: null,
    localProjectId: null,
    sessionId: null,
    runtimePidBeforeCrash: null,
    runtimePidAfterCrash: null,
    requirementsFixture,
    runCapture,
  };
  page.on("pageerror", (error) => gateContext.pageErrors.push(error.message));
  await runGateCSteps(gateContext, selection.steps);
  // 子集模式只对实际跑过的步骤断言：全量收尾断言（路由状态 / supervisor 证据）
  // 只有在对应步骤真的跑过时才成立，否则会把「没跑」误报成「失败」。
  if (gateContext.completedSteps.has("v2-user-path")) {
    if (!gateContext.sessionId || !gateContext.localProjectId || !gateContext.remoteProjectId) {
      throw new Error("V2 user-path step did not retain required route state");
    }
  }
  if (gateContext.completedSteps.has("supervisor-recovery")) {
    if (gateContext.runtimePidBeforeCrash === null || gateContext.runtimePidAfterCrash === null) {
      throw new Error("supervisor recovery step did not retain runtime process evidence");
    }
  }

  await context.tracing.stop({ path: resolve(artifactRoot, "trace.zip") });
  await context.close();
  context = null;
  await browser.close();
  browser = null;

  writeFileSync(
    resolve(artifactRoot, "service-status.txt"),
    runCapture("systemctl", ["--user", "status", serviceName, "--no-pager"], 0).stdout,
  );
  writeFileSync(
    resolve(artifactRoot, "service-journal.log"),
    runCapture(
      "journalctl",
      ["--user", "-u", serviceName, "--no-pager", "-n", "120"],
      0,
    ).stdout,
  );
  runCapture("systemctl", ["--user", "stop", serviceName], 0);
  copyFileSync(
    resolve(installHome, ".local", "share", "suduo", "suduo.sqlite"),
    evidenceDatabase,
  );

  const database = openBetterSqlite3Database(evidenceDatabase);
  runMigrations(database);
  let eventCount = 0;
  let firstSeq = 0;
  let lastSeq = 0;
  let approvalCount = 0;
  try {
    // seq 是全库自增：多会话交错时单会话不连续是预期。先证明全库无丢失/无重复，
    // 再证明 Gate C 会话自己的事件严格递增。
    const allSeqs = database.prepare("select seq from events order by seq").all<{ seq: number }>()
      .map((event) => event.seq);
    for (let index = 1; index < allSeqs.length; index += 1) {
      const current = allSeqs[index];
      const previous = allSeqs[index - 1];
      if (current === undefined || previous === undefined || current !== previous + 1) {
        throw new Error("global event seq is not continuous or is duplicated");
      }
    }
    // 没有会话（例如 extension-seam 子集）时只保留全库检查。
    const ledgerSessionId = gateContext.sessionId;
    if (ledgerSessionId !== null) {
      const persisted = new EventRepository(database).listAfter(ledgerSessionId, 0, 20_000);
      const seqs = persisted.map((event) => event.seq);
      if (seqs.length === 0 || new Set(seqs).size !== seqs.length) {
        throw new Error("Gate C persisted event ledger is empty or duplicated");
      }
      for (let index = 1; index < seqs.length; index += 1) {
        const current = seqs[index];
        const previous = seqs[index - 1];
        if (current === undefined || previous === undefined || current <= previous) {
          throw new Error("Gate C session event seq is not strictly increasing");
        }
      }
      eventCount = persisted.length;
      firstSeq = seqs[0] ?? 0;
      lastSeq = seqs.at(-1) ?? 0;
      approvalCount = new ApprovalRepository(database).listBySession(ledgerSessionId).length;
    }
    // 英文冒烟里建的会话都应记下英文（中英双语 S7：交给 Codex 的文字按会话语言），由建会话请求的语言头决定。
    if (gateLocale !== "zh-CN") {
      const sessions = database.prepare("select id, locale from sessions").all<{ id: string; locale: string }>();
      const wrong = sessions.filter((row) => row.locale !== gateLocale);
      if (sessions.length === 0 || wrong.length > 0) {
        throw new Error(
          `英文冒烟建的会话应都记为 ${gateLocale}：共 ${String(sessions.length)} 个，不符的有 ${JSON.stringify(wrong)}`,
        );
      }
    }
  } finally {
    database.close();
  }

  const uninstall = runCapture(
    process.execPath,
    [
      uninstallScript,
      "--home",
      installHome,
      "--service-name",
      serviceName,
      "--purge-data",
    ],
    0,
  );
  writeFileSync(resolve(artifactRoot, "uninstall.log"), uninstall.stdout + uninstall.stderr);

  // 英文冒烟：各页面的漏翻检查跑完一起判（中文验收时恒为空）。放在最后，trace、日志与账本检查都已留下。
  const untranslated = untranslatedSummary(gateContext.untranslated);
  if (untranslated !== null) throw new Error(untranslated);

  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        status: "PASS",
        locale: gateLocale,
        codexHome,
        route: {
          remoteProjectId: gateContext.remoteProjectId,
          localProjectId: gateContext.localProjectId,
          sessionId: gateContext.sessionId,
        },
        mode: selection.subset ? "subset" : "full",
        requestedSteps: selection.requested,
        gateSteps: [...gateContext.completedSteps],
        screenshots,
        browserTrace: "trace.zip",
        doctor: {
          configured: JSON.parse(doctorNormal.stdout),
          noConfig: JSON.parse(doctorMissing.stdout),
        },
        install: {
          serviceName,
          serviceEnabledDuringE2e: true,
          requirementsFixture: requirementsFixture.origin,
          outputTail: installation.stdout.slice(-1200),
          uninstallOutput: uninstall.stdout.trim(),
        },
        files: {
          acceptedExists: existsSync(resolve(projectRoot, "GATE_C_ACCEPT.md")),
          declinedExists: existsSync(resolve(projectRoot, "GATE_C_DECLINE.md")),
          pastedAttachmentDirectory: existsSync(resolve(projectRoot, ".suduo", "attachments")),
        },
        // 子集模式下只声明实际跑过的链路；全量时每一项仍为 true，输出不变。
        flows: {
          v2LoginProjectMappingSession: gateContext.completedSteps.has("v2-user-path"),
          skillTriggered: gateContext.completedSteps.has("assistant-approval"),
          approvalAcceptAndDecline: gateContext.completedSteps.has("assistant-approval"),
          imagePasteSent: gateContext.completedSteps.has("assistant-attachment"),
          pageReopenReplay: gateContext.completedSteps.has("interrupt-and-reopen"),
          diffPreview: gateContext.completedSteps.has("changes-and-diff"),
          attributionBadge: gateContext.completedSteps.has("attribution-badge"),
          queueAutoDispatch: gateContext.completedSteps.has("queue-auto-dispatch"),
          stopPausesQueue: gateContext.completedSteps.has("stop-pauses-queue"),
          interrupt: gateContext.completedSteps.has("final-interrupt"),
        },
        supervisor: {
          killedRuntimePid: gateContext.runtimePidBeforeCrash,
          resumedRuntimePid: gateContext.runtimePidAfterCrash,
          unattendedResume:
            gateContext.runtimePidBeforeCrash !== gateContext.runtimePidAfterCrash,
        },
        events: { count: eventCount, firstSeq, lastSeq },
        approvals: approvalCount,
        windowsNative: {
          status: "BLOCKED",
          reason:
            `当前执行环境是 Linux（WSL2 或本机虚拟机）；需要 Windows 原生 Node/pnpm、systemd 等价常驻机制和 Codex ${CODEX_VERSION} 配置机器。`,
        },
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      gate: "C",
      status: "passed",
      locale: gateLocale,
      mode: selection.subset ? "subset" : "full",
      steps: [...gateContext.completedSteps],
      resultPath,
    }) + "\n",
  );
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  await requirementsFixture.close().catch(() => undefined);
  await cleanupOldService();
}

function prepareProject(locale: Locale): void {
  mkdirSync(resolve(projectRoot, "materials"), { recursive: true });
  writeFileSync(
    resolve(projectRoot, "materials", "brief.md"),
    "# 8 月工作台素材\n\n- 目标：验证 V2 需求服务登录、映射与会话工作流\n- 输入：req skill、审批、图片\n",
  );
  writeFileSync(
    resolve(projectRoot, "materials", "reference.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const skillDirectory = resolve(projectRoot, ".codex", "skills", "gate-c");
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(resolve(skillDirectory, "SKILL.md"), locale === "zh-CN" ? chineseSkill() : englishSkill());
}

/** 中文全量用的 skill（与改动前逐字相同）。 */
function chineseSkill(): string {
  return [
    "---",
    "name: gate-c-workflow",
    "description: Gate C 浏览器端到端文件审批验证 skill",
    "---",
    "",
    "# Gate C workflow",
    "",
    "- 当用户要求 accept 阶段时，必须实际执行 shell 命令：",
    "  `printf '# Gate C Accepted\\n\\nCreated by the gate-c skill.\\n' > GATE_C_ACCEPT.md`",
    "- 当用户要求 decline 阶段时，必须实际执行 shell 命令：",
    "  `printf 'must not exist' > GATE_C_DECLINE.md`",
    "- 当用户要求 wait 阶段时，必须实际执行 shell 命令：",
    "  `printf 'started' > GATE_C_WAIT_STARTED && sleep 45`",
    "- 不要改用纯文本回答绕过命令；命令完成或被拒后再简短说明。",
    "",
  ].join("\n");
}

/**
 * 英文冒烟用的 skill：同名、同样三条命令，说明写成英文。skill 是用户写的内容，
 * 用英文是为了让 Codex 也用英文作答（截图与漏翻检查更接近英文用户看到的样子）。
 */
function englishSkill(): string {
  return [
    "---",
    "name: gate-c-workflow",
    "description: Gate C end-to-end browser approval workflow skill",
    "---",
    "",
    "# Gate C workflow",
    "",
    "- When the user asks for the accept stage, you must actually run this shell command:",
    "  `printf '# Gate C Accepted\\n\\nCreated by the gate-c skill.\\n' > GATE_C_ACCEPT.md`",
    "- When the user asks for the decline stage, you must actually run this shell command:",
    "  `printf 'must not exist' > GATE_C_DECLINE.md`",
    "- When the user asks for the wait stage, you must actually run this shell command:",
    "  `printf 'started' > GATE_C_WAIT_STARTED && sleep 45`",
    "- Do not answer in plain text to avoid running the command; after the command finishes or is declined, reply briefly in English.",
    "",
  ].join("\n");
}

async function waitForHttpReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl + "/api/v1/projects");
      if (response.status === 200) return;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("timeout waiting for installed suduo service");
}

function runCapture(
  command: string,
  args: string[],
  expectedStatus: number,
): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      SUDUO_CODEX_HOME: codexHome,
      SUDUO_REQUIREMENTS_SERVICE_URL: requirementsFixture.origin,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${command} ${args.join(" ")} expected ${String(expectedStatus)}, got ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function ensureBrowserLibraries(): void {
  const library = resolve(browserLibraryPath, "libasound.so.2");
  // 优先用系统库：Gate C 的 Chromium 已验证可直接加载它，不应因缺少测试缓存而访问网络。
  if (systemBrowserLibraries.some((path) => existsSync(path))) return;
  if (existsSync(library)) return;
  const debDirectory = resolve(workspaceRoot, ".cache", "playwright-debs");
  const extractionRoot = resolve(workspaceRoot, ".cache", "playwright-libs");
  mkdirSync(debDirectory, { recursive: true });
  mkdirSync(extractionRoot, { recursive: true });
  const downloaded = spawnSync("apt-get", ["download", "libasound2t64"], {
    cwd: debDirectory,
    encoding: "utf8",
  });
  if (downloaded.status !== 0) {
    throw new Error(
      "Chromium 缺少 libasound.so.2：系统路径均不存在（" +
        systemBrowserLibraries.join(", ") +
        "），且 apt-get download 用户态网络兜底失败: " +
        downloaded.stderr,
    );
  }
  const archive = readdirSync(debDirectory).find(
    (name) => name.startsWith("libasound2t64_") && name.endsWith(".deb"),
  );
  if (!archive) throw new Error("apt-get download 未生成 libasound2t64 deb");
  const extracted = spawnSync(
    "dpkg-deb",
    ["-x", resolve(debDirectory, archive), extractionRoot],
    { encoding: "utf8" },
  );
  if (extracted.status !== 0 || !existsSync(library)) {
    throw new Error("无法解压 Chromium 用户态依赖: " + extracted.stderr);
  }
}

async function cleanupOldService(): Promise<void> {
  spawnSync("systemctl", ["--user", "disable", "--now", serviceName], { stdio: "ignore" });
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate Gate C port");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}
