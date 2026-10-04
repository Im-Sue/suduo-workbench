/// <reference lib="dom" />
/**
 * 英文冒烟（中英双语技术设计 §五，`SUDUO_GATE_LOCALE=en`）：登录、需求看板、需求详情、从需求开工、
 * 会话一轮、房间、设置。登录与第一次开工复用中文全量的 `v2-user-path`（文字按语言取），这里是其后的几步。
 *
 * 每一步做两件事：
 * 1. 用前端英文字典里的文字定位关键元素——定位得到，说明界面确实是英文、措辞与字典一致；
 * 2. 在每个页面上查「框架元素里有没有漏翻的中文」（untranslated-audit.ts），人写内容与 AI 回复除外。
 *    查到的先记下、不中断，整轮跑完一起判失败，一次运行看全所有页面。
 *
 * gate-c 输入的消息用英文写：它们是用户内容，用英文是为了让 Codex 也用英文作答，截图更接近英文用户看到的样子。
 */
import { resolve } from "node:path";
import type { Locator } from "playwright";
import { REQUIREMENT_STATUSES } from "@suduo/cloud-contracts";
import { GATE_C_FIXTURE_IDS, GATE_C_FIXTURE_NUMBERS } from "../requirements-service-fixture.js";
import { browserLocaleOf } from "../ui-text.js";
import { auditUntranslatedText } from "../untranslated-audit.js";
import { openKeyPage } from "../visual-baseline.js";
import {
  capture,
  completeStartSessionDialog,
  MODEL_WRAP_UP_TIMEOUT_MS,
  openSection,
  pickSkill,
  waitForFile,
  waitForTurnTerminal,
} from "./helpers.js";
import type { GateCStep, GateCStepContext } from "./types.js";

/** 夹具项目名（项目默认讨论房间同名）。 */
const PROJECT_NAME = "Gate C 远程项目";
/** 夹具需求「看板草稿一」：详情、开工都用它。 */
const DETAIL_TITLE = "看板草稿一";
const ACCEPT_PROMPT =
  "Run the accept stage: follow the skill instructions exactly, actually run the command that creates GATE_C_ACCEPT.md, then reply briefly.";
const ROOM_MESSAGE = "Hello from the Gate C English smoke test.";

/**
 * 我的工作：界面语言真的是英文（<html lang>、本机服务记下的语言）、主导航分区名。
 * 整轮固定了语言偏好（gate-c.real.ts 的 init script）；这里另开一个不写偏好、只有浏览器语言是英文的上下文，
 * 验「跟随系统」这条路也落到英文。
 */
export const englishMyWorkStep: GateCStep = {
  id: "en-my-work",
  async run(context) {
    const page = context.page;
    await openKeyPage(page, { name: "my", url: context.origin + "/my", ready: "workbench-actions" });
    const lang = await page.evaluate(() => document.documentElement.lang);
    if (lang !== context.locale) {
      throw new Error(`<html lang> 应为 ${context.locale}，实际为「${lang}」——界面语言偏好没有生效`);
    }
    // 本机服务从请求头 X-SuDuo-Locale 记下界面语言，后台任务（共享 Agent 等）按它出文字。
    const recorded = await page.evaluate(async () => {
      const response = await fetch("/api/v1/settings");
      return ((await response.json()) as { locale?: unknown }).locale ?? null;
    });
    if (recorded !== context.locale) {
      throw new Error(`本机服务记下的界面语言应为 ${context.locale}，实际为 ${String(recorded)}`);
    }
    await page.getByRole("heading", { level: 1, name: context.ui.myWork.title, exact: true }).waitFor();
    await page.getByTestId("workbench-actions").getByText(context.ui.myWork.attention).first().waitFor();
    const nav = page.getByTestId("app-nav");
    for (const label of Object.values(context.ui.nav)) {
      // 带待处理数时可访问名是「分区名, 数量」，按开头认。
      await nav.getByRole("link", { name: new RegExp(`^${escapeRegExp(label)}`, "u") }).first().waitFor({ timeout: 10_000 });
    }
    await capture(context, "en-01-my-work.png");
    await auditUntranslatedText(context, "my-work");

    const browser = context.browserContext.browser();
    if (browser === null) throw new Error("取不到浏览器实例，没法验「跟随系统」");
    const followSystem = await browser.newContext({ locale: browserLocaleOf(context.locale) });
    try {
      const probe = await followSystem.newPage();
      await probe.goto(context.origin + "/my", { waitUntil: "domcontentloaded" });
      await probe.getByRole("heading", { level: 1, name: context.ui.myWork.title, exact: true }).waitFor({ timeout: 30_000 });
      const preference = await probe.evaluate(() => window.localStorage.getItem("suduo.locale"));
      // 没选过语言时偏好为空，启动后会写成 system（跟随系统）；两种都是「跟随系统」，不能是固定语言。
      if (preference !== null && preference !== "system") {
        throw new Error(`「跟随系统」的上下文里不该有固定的语言偏好，实际为 ${preference}`);
      }
    } finally {
      await followSystem.close();
    }
  },
};

/** 需求：看板（七列英文状态名）、列表、速览、详情，从详情「Start session」开工，概览。 */
export const englishRequirementsStep: GateCStep = {
  id: "en-requirements",
  async run(context) {
    const projectId = requireProject(context, "en-requirements");
    const page = context.page;
    const text = context.ui.requirements;
    const projectUrl = `${context.origin}/p/${encodeURIComponent(projectId)}`;

    await openKeyPage(page, {
      name: "requirements",
      url: projectUrl + "/requirements?view=board",
      ready: "requirements-board",
    });
    for (const status of REQUIREMENT_STATUSES) {
      await page
        .locator(`[data-status-column="${status}"]`)
        .getByRole("heading", { level: 2, name: text.status[status], exact: true })
        .waitFor({ timeout: 20_000 });
    }
    await page.getByRole("textbox", { name: text.searchLabel }).waitFor();
    const card = page.locator(
      `[data-testid="requirement-card"][data-requirement-id="${GATE_C_FIXTURE_IDS.reqDraft1}"]`,
    );
    await card.waitFor({ timeout: 20_000 });
    await capture(context, "en-02-requirements-board.png");
    await auditUntranslatedText(context, "requirements-board");

    // 速览：点卡片打开，「Start session」在，Esc 关闭。
    await card.click();
    const peek = page.getByTestId("requirement-peek");
    await peek.getByRole("heading", { name: DETAIL_TITLE }).waitFor({ timeout: 20_000 });
    await peek.getByRole("button", { name: text.peekStartSession, exact: true }).waitFor();
    await auditUntranslatedText(context, "requirement-peek");
    await page.keyboard.press("Escape");
    await peek.waitFor({ state: "detached", timeout: 10_000 });

    // 列表视图：表头英文较长（S3 记过截断风险），漏翻检查也覆盖表头。
    await openKeyPage(page, {
      name: "requirements-list",
      url: projectUrl + "/requirements?view=list",
      ready: "requirements-list",
    });
    await auditUntranslatedText(context, "requirements-list");

    // 详情：标题是人写的（夹具中文），框架是英文。
    await openKeyPage(page, {
      name: "requirement-detail",
      url: `${projectUrl}/requirements/${String(GATE_C_FIXTURE_NUMBERS.reqDraft1)}`,
      ready: "requirement-detail",
    });
    await page.getByRole("heading", { level: 1, name: DETAIL_TITLE }).waitFor();
    await page.getByRole("list", { name: text.activityList, exact: true }).waitFor({ timeout: 20_000 });
    await capture(context, "en-03-requirement-detail.png");
    await auditUntranslatedText(context, "requirement-detail");

    // 从需求开工：详情页「Start session」→ 开始会话对话框（项目已关联目录，直接准备）→ 进入会话。
    await page
      .getByTestId("requirement-detail")
      .getByRole("button", { name: text.detailStartSession, exact: true })
      .click();
    const sessionId = await completeStartSessionDialog(context);
    await page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
    console.info(`[en-requirements] 从需求详情开工，进入 /sessions/${sessionId}`);
    await capture(context, "en-04-requirement-session.png");
    await auditUntranslatedText(context, "requirement-session");

    await openKeyPage(page, {
      name: "overview",
      url: projectUrl + "/overview",
      ready: "overview-status-funnel",
    });
    await auditUntranslatedText(context, "overview");
  },
};

/** 会话一轮：在项目会话里经 skill 跑一条要审批的命令，批准后等回合结束（与中文 assistant-approval 同一套机制）。 */
export const englishSessionTurnStep: GateCStep = {
  id: "en-session-turn",
  async run(context) {
    const sessionId = context.sessionId;
    if (sessionId === null) throw new Error("en-session-turn 需要 v2-user-path 建立的会话");
    const page = context.page;
    const text = context.ui.session;
    await page.goto(`${context.origin}/sessions/${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
    await page.getByLabel(text.messageLabel, { exact: true }).waitFor();
    await expectText(page.getByTestId("side-tab-changes"), text.tabs.changes, "检查面板「改动」标签");
    await expectText(page.getByTestId("side-tab-files"), text.tabs.files, "检查面板「文件」标签");

    await pickSkill(page, "gate-c-workflow");
    await page.getByTestId("message-input").fill(ACCEPT_PROMPT);
    await page.getByTestId("send-message").click();
    const card = page.getByTestId("approval-card");
    await card.waitFor({ timeout: 180_000 });
    await expectText(page.getByTestId("approval-accept"), text.approve, "审批卡的批准按钮");
    await expectText(page.getByTestId("approval-decline"), text.decline, "审批卡的拒绝按钮");
    await capture(context, "en-05-approval-card.png");
    await page.getByTestId("approval-accept").click();
    await waitForFile(resolve(context.projectRoot, "GATE_C_ACCEPT.md"), true, 60_000);
    await card.waitFor({ state: "hidden", timeout: 60_000 });
    await waitForTurnTerminal(page, MODEL_WRAP_UP_TIMEOUT_MS);
    await capture(context, "en-06-session-turn.png");
    await auditUntranslatedText(context, "session", [ACCEPT_PROMPT]);
  },
};

/** 房间：主导航进入项目讨论，消息流与输入框是英文，发一条消息并确认经 BFF 到了远程。 */
export const englishRoomsStep: GateCStep = {
  id: "en-rooms",
  async run(context) {
    requireProject(context, "en-rooms");
    const page = context.page;
    const text = context.ui.rooms;
    await openSection(page, context.ui.nav.rooms);
    // 不带房间时进项目默认房间。
    await page.waitForURL(
      (url) => url.pathname.endsWith(`/rooms/${GATE_C_FIXTURE_IDS.projectRoom}`),
      { timeout: 20_000 },
    );
    await page.getByTestId("room-view").waitFor({ timeout: 30_000 });
    await page.getByTestId("room-header").getByText(text.projectScope, { exact: true }).waitFor();
    await page.getByTestId("room-message").first().waitFor({ timeout: 20_000 });

    const input = page.getByRole("combobox", { name: text.composerLabel(PROJECT_NAME), exact: true });
    await input.fill(ROOM_MESSAGE);
    await page.getByTestId("room-composer").getByRole("button", { name: text.send, exact: true }).click();
    await page.getByTestId("room-message").filter({ hasText: ROOM_MESSAGE }).waitFor({ timeout: 20_000 });
    if (!context.requirementsFixture.roomMessageBodies().includes(ROOM_MESSAGE)) {
      throw new Error("界面上出现了刚发的讨论消息，但远程夹具没收到");
    }
    await capture(context, "en-07-rooms.png");
    await auditUntranslatedText(context, "rooms", [ROOM_MESSAGE]);
  },
};

/** 设置：外观（语言选项，当前为 English）、模型服务（Codex 配置提醒）、执行与安全（锁定说明）、诊断。 */
export const englishSettingsStep: GateCStep = {
  id: "en-settings",
  async run(context) {
    const page = context.page;
    const text = context.ui.settings;
    const nav = page.getByRole("navigation", { name: text.navLabel });

    await openKeyPage(page, {
      name: "settings-appearance",
      url: context.origin + "/settings/appearance",
      ready: "settings-theme",
    });
    await page.getByRole("heading", { level: 2, name: text.sections.appearance, exact: true }).waitFor();
    // 语言一行：选项是「跟随系统」加各语言（各用自己的写法），当前偏好 English 被选中。
    const localeControl = page.getByTestId("settings-locale");
    await localeControl.waitFor({ timeout: 10_000 }).catch((error: unknown) => {
      throw new Error(`设置 · 外观里没有语言选项（界面语言里应已有 en）：${String(error)}`);
    });
    for (const option of Object.values(text.localeOption)) {
      await localeControl.getByRole("radio", { name: option, exact: true }).waitFor();
    }
    const selected = await localeControl
      .getByRole("radio", { name: text.localeOption.en, exact: true })
      .getAttribute("aria-checked");
    if (selected !== "true") {
      throw new Error(`语言选项应选中「${text.localeOption.en}」，实际 aria-checked=${String(selected)}`);
    }
    await capture(context, "en-08-settings-appearance.png");
    await auditUntranslatedText(context, "settings-appearance");

    await openKeyPage(page, {
      name: "settings-model",
      url: context.origin + "/settings/model",
      ready: "settings-page",
    });
    await page.getByRole("heading", { level: 2, name: text.sections.model, exact: true }).waitFor();
    // 与中文 settings-codex 同一个前提：gate-c 的 CODEX_HOME 确定性地触发 Codex 配置提醒（gate-c-vm.sh 会加探针键）。
    const warning = page.getByTestId("model-config-warning");
    await warning.waitFor({ timeout: 30_000 });
    await expectText(warning, text.configWarningTitle, "模型服务的 Codex 配置提醒");
    await page.getByTestId("model-api-key-masked").waitFor();
    await capture(context, "en-09-settings-model.png");
    await auditUntranslatedText(context, "settings-model");

    // gate-c 的服务以 SUDUO_MAX_APPROVAL_MODE=auto 启动：锁定说明是英文模板。
    await nav.getByRole("link", { name: new RegExp(`^${escapeRegExp(text.sections.execution)}`, "u") }).click();
    await page.getByRole("heading", { level: 2, name: text.sections.execution, exact: true }).waitFor();
    const reason = (await page.getByTestId("settings-lock-reason").first().textContent()) ?? "";
    const [before, after] = text.lockReason;
    if (!reason.includes(before.trim()) || !reason.includes(after.trim())) {
      throw new Error(`锁定说明应按英文模板「${before}…${after}」，实际为：${reason}`);
    }
    await auditUntranslatedText(context, "settings-execution");

    // 诊断：各项结论与处理建议来自本机服务（按请求语言生成），等全部检查落定再查。
    await nav.getByRole("link", { name: new RegExp(`^${escapeRegExp(text.sections.diagnostics)}`, "u") }).click();
    await page.getByRole("list", { name: text.healthTitle, exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="health-item"][data-status="checking"]').length === 0,
      undefined,
      { timeout: 60_000 },
    );
    await page.getByTestId("settings-doctor-checks").waitFor({ timeout: 60_000 });
    await capture(context, "en-10-settings-diagnostics.png");
    await auditUntranslatedText(context, "settings-diagnostics");
  },
};

function requireProject(context: GateCStepContext, step: string): string {
  if (context.remoteProjectId === null) throw new Error(`${step} 需要 v2-user-path 选定的远程项目`);
  return context.remoteProjectId;
}

async function expectText(locator: Locator, expected: string, what: string): Promise<void> {
  await locator.waitFor({ timeout: 20_000 });
  const actual = ((await locator.textContent()) ?? "").replace(/\s+/gu, " ").trim();
  if (!actual.includes(expected)) {
    throw new Error(`${what}应包含「${expected}」，实际为「${actual}」`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
