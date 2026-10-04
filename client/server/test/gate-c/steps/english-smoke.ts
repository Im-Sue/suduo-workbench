/// <reference lib="dom" />
/**
 * 英文冒烟（中英双语技术设计 §五，`SUDUO_GATE_LOCALE=en`）：登录、需求看板、需求详情、从需求开工、
 * 会话一轮、房间、设置。登录与第一次开工复用中文全量的 `v2-user-path`（文字按语言取），这里是其后的几步。
 *
 * 每一步做两件事：
 * 1. 用前端英文字典里的文字定位关键元素——定位得到，说明界面确实是英文、措辞与字典一致；
 * 2. 在每个页面上查「整页可见文字里有没有系统写的中文」（untranslated-audit.ts），人写内容与 AI 回复除外；
 *    每页列出必须查到的区域（mustCover），保证说要查的服务端文字真的进了检查范围。
 *    查到漏翻先记下、不中断，整轮跑完一起判失败，一次运行看全所有页面。
 * 另有一步在真实浏览器里中英来回切换（en-locale-switch），验草稿不丢、不多发消息。
 *
 * gate-c 输入的消息用英文写：它们是用户内容，用英文是为了让 Codex 也用英文作答，截图更接近英文用户看到的样子。
 */
import { resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { REQUIREMENT_STATUSES } from "@suduo/cloud-contracts";
import type { Locale } from "@suduo/client-contracts";
import { GATE_C_FIXTURE_IDS, GATE_C_FIXTURE_NUMBERS } from "../requirements-service-fixture.js";
import { browserLocaleOf, loadGateUiText, type GateUiText } from "../ui-text.js";
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
const SESSION_DRAFT = "Session draft that must survive the language switch.";
const ROOM_DRAFT = "Room draft that must survive the language switch.";

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
    await auditUntranslatedText(context, "my-work", { mustCover: ["app-nav", "workbench-actions"] });

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
    await auditUntranslatedText(context, "requirements-board", { mustCover: ["requirements-board"] });

    // 速览：点卡片打开，「Start session」在，Esc 关闭。
    await card.click();
    const peek = page.getByTestId("requirement-peek");
    await peek.getByRole("heading", { name: DETAIL_TITLE }).waitFor({ timeout: 20_000 });
    await peek.getByRole("button", { name: text.peekStartSession, exact: true }).waitFor();
    await auditUntranslatedText(context, "requirement-peek", { mustCover: ["requirement-peek"] });
    await page.keyboard.press("Escape");
    await peek.waitFor({ state: "detached", timeout: 10_000 });

    // 列表视图：表头英文较长（S3 记过截断风险），漏翻检查也覆盖表头。
    await openKeyPage(page, {
      name: "requirements-list",
      url: projectUrl + "/requirements?view=list",
      ready: "requirements-list",
    });
    await auditUntranslatedText(context, "requirements-list", { mustCover: ["requirements-list"] });

    // 详情：标题是人写的（夹具中文），框架是英文。
    await openKeyPage(page, {
      name: "requirement-detail",
      url: `${projectUrl}/requirements/${String(GATE_C_FIXTURE_NUMBERS.reqDraft1)}`,
      ready: "requirement-detail",
    });
    await page.getByRole("heading", { level: 1, name: DETAIL_TITLE }).waitFor();
    await page.getByRole("list", { name: text.activityList, exact: true }).waitFor({ timeout: 20_000 });
    await capture(context, "en-03-requirement-detail.png");
    await auditUntranslatedText(context, "requirement-detail", { mustCover: ["requirement-detail", "materials-panel"] });

    // 从需求开工：详情页「Start session」→ 开始会话对话框（项目已关联目录，直接准备）→ 进入会话。
    await page
      .getByTestId("requirement-detail")
      .getByRole("button", { name: text.detailStartSession, exact: true })
      .click();
    const sessionId = await completeStartSessionDialog(context);
    await page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
    console.info(`[en-requirements] 从需求详情开工，进入 /sessions/${sessionId}`);
    await capture(context, "en-04-requirement-session.png");
    await auditUntranslatedText(context, "requirement-session", { mustCover: ["sessions-rail", "message-input"] });

    await openKeyPage(page, {
      name: "overview",
      url: projectUrl + "/overview",
      ready: "overview-status-funnel",
    });
    await auditUntranslatedText(context, "overview", { mustCover: ["overview-status-funnel"] });
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
    // 回合进行中：审批卡与输入框上方的运行提示（等你确认）也要是英文。
    await page
      .getByTestId("run-status-line")
      .waitFor({ timeout: 10_000 })
      .catch((error: unknown) => {
        throw new Error(`等你确认时输入框上方应有运行提示（run-status-line）：${String(error)}`);
      });
    await auditUntranslatedText(context, "session-approval", {
      allowed: [ACCEPT_PROMPT],
      mustCover: ["approval-card", "run-status-line"],
    });
    await page.getByTestId("approval-accept").click();
    await waitForFile(resolve(context.projectRoot, "GATE_C_ACCEPT.md"), true, 60_000);
    await card.waitFor({ state: "hidden", timeout: 60_000 });
    await waitForTurnTerminal(page, MODEL_WRAP_UP_TIMEOUT_MS);
    await capture(context, "en-06-session-turn.png");
    await auditUntranslatedText(context, "session", {
      allowed: [ACCEPT_PROMPT],
      mustCover: ["conversation-stream", "tool-card", "message-input"],
    });
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
    await auditUntranslatedText(context, "rooms", {
      allowed: [ROOM_MESSAGE],
      mustCover: ["room-header", "room-message-stream", "room-composer"],
    });
  },
};

/**
 * 在真实浏览器里切换语言（S9：切换语言不丢输入）。
 *
 * 标签页 A：会话页的输入框留一段草稿，再从悬浮入口打开项目讨论窗口、在窗口里留一段草稿。
 * 1. 另开标签页 B，设置 → 外观 → 语言切到简体中文：B 立即变中文；A 跟着变（别的标签页改了语言要跟），
 *    <html lang> 与界面文字都是中文，两段草稿都还在。再在 B 切回 English，A 跟回英文，草稿还在。
 * 2. 在 A 本身切：讨论窗口开着、经主导航进设置 → 外观（应用内跳转，窗口不关），切到简体中文再切回，窗口里的草稿还在。
 * 全程不该多发任何消息：讨论夹具收到的消息数、会话里提交的消息与开始的回合数都不变，草稿也没被发出去。
 * 文字都从前端字典取（中英各一份）。
 */
export const englishLocaleSwitchStep: GateCStep = {
  id: "en-locale-switch",
  async run(context) {
    const sessionId = context.sessionId;
    if (sessionId === null) throw new Error("en-locale-switch 需要 v2-user-path 建立的会话");
    requireProject(context, "en-locale-switch");
    const en = context.ui;
    const zh = await loadGateUiText("zh-CN");
    const page = context.page;

    await page.goto(`${context.origin}/sessions/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
    await page.getByTestId("message-input").fill(SESSION_DRAFT);
    await page.getByTestId("room-launcher").click();
    await page.getByTestId("room-launcher-item").filter({ hasText: PROJECT_NAME }).first().click();
    const roomWindow = page.getByTestId("room-window");
    await roomWindow.waitFor({ timeout: 20_000 });
    await roomWindow.getByTestId("room-composer-input").fill(ROOM_DRAFT);
    const before = await sentCounts(context, sessionId);

    const settingsTab = await context.browserContext.newPage();
    try {
      await openKeyPage(settingsTab, {
        name: "settings-appearance",
        url: context.origin + "/settings/appearance",
        ready: "settings-locale",
      });
      await switchLocale(settingsTab, en, "zh-CN");
      await expectAppearanceIn(settingsTab, zh);
      await expectDraftsIn(page, zh, { session: true });
      await capture(context, "en-08-locale-switch-other-tab-zh.png");

      await switchLocale(settingsTab, zh, "en");
      await expectAppearanceIn(settingsTab, en);
      await expectDraftsIn(page, en, { session: true });
    } finally {
      await settingsTab.close();
    }

    // 同一个标签页里切：讨论窗口开着进设置（会话输入框随页面离开，不再查它）。
    await openSection(page, en.nav.settings);
    await page.getByTestId("settings-page").waitFor({ timeout: 20_000 });
    await page
      .getByRole("navigation", { name: en.settings.navLabel })
      .getByRole("link", { name: new RegExp(`^${escapeRegExp(en.settings.sections.appearance)}`, "u") })
      .click();
    await page.getByTestId("settings-locale").waitFor({ timeout: 20_000 });
    await switchLocale(page, en, "zh-CN");
    await expectAppearanceIn(page, zh);
    await expectDraftsIn(page, zh, { session: false });
    await capture(context, "en-09-locale-switch-same-tab-zh.png");
    await switchLocale(page, zh, "en");
    await expectAppearanceIn(page, en);
    await expectDraftsIn(page, en, { session: false });

    const after = await sentCounts(context, sessionId);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`切换语言前后发出的消息数变了：之前 ${JSON.stringify(before)}，之后 ${JSON.stringify(after)}`);
    }
    if (context.requirementsFixture.roomMessageBodies().includes(ROOM_DRAFT)) {
      throw new Error("讨论窗口里的草稿被发出去了");
    }
  },
};

/** 在设置 → 外观的语言控件里选一种语言（用键盘选，免得被悬浮窗口挡住点不到），等 <html lang> 变过去。 */
async function switchLocale(page: Page, current: GateUiText, target: Locale): Promise<void> {
  await page
    .getByTestId("settings-locale")
    .getByRole("radio", { name: current.settings.localeOption[target], exact: true })
    .press("Enter");
  try {
    await page.waitForFunction((lang) => document.documentElement.lang === lang, target, { timeout: 15_000 });
  } catch (error) {
    // 没有打开的对话框、没有没保存的编辑，不该先弹确认框。
    const confirm = page.getByTestId("confirm-dialog");
    if (await confirm.isVisible().catch(() => false)) {
      throw new Error(`切换语言时弹出了确认框：${((await confirm.textContent()) ?? "").trim()}`, { cause: error });
    }
    throw error;
  }
}

/** 外观页已是这种语言：<html lang>、分组标题、主导航、语言控件选中这一项。 */
async function expectAppearanceIn(page: Page, texts: GateUiText): Promise<void> {
  await page.waitForFunction((lang) => document.documentElement.lang === lang, texts.locale, { timeout: 15_000 });
  await page.getByRole("heading", { level: 2, name: texts.settings.sections.appearance, exact: true }).waitFor({ timeout: 15_000 });
  await page
    .getByTestId("app-nav")
    .getByRole("link", { name: new RegExp(`^${escapeRegExp(texts.nav.myWork)}`, "u") })
    .first()
    .waitFor({ timeout: 15_000 });
  const checked = await page
    .getByTestId("settings-locale")
    .getByRole("radio", { name: texts.settings.localeOption[texts.locale], exact: true })
    .getAttribute("aria-checked");
  if (checked !== "true") {
    throw new Error(`语言控件应选中「${texts.settings.localeOption[texts.locale]}」，实际 aria-checked=${String(checked)}`);
  }
}

/** 标签页 A 已跟到这种语言，草稿都还在：会话输入框（在会话页时）与讨论窗口的输入框。 */
async function expectDraftsIn(page: Page, texts: GateUiText, options: { session: boolean }): Promise<void> {
  await page.waitForFunction((lang) => document.documentElement.lang === lang, texts.locale, { timeout: 15_000 });
  await page
    .getByTestId("app-nav")
    .getByRole("link", { name: new RegExp(`^${escapeRegExp(texts.nav.myWork)}`, "u") })
    .first()
    .waitFor({ timeout: 15_000 });
  if (options.session) {
    const composer = page.getByLabel(texts.session.messageLabel, { exact: true });
    await composer.waitFor({ timeout: 15_000 });
    const draft = await composer.inputValue();
    if (draft !== SESSION_DRAFT) throw new Error(`切到 ${texts.locale} 后会话输入框的草稿变了：「${draft}」`);
    await expectText(page.getByTestId("side-tab-changes"), texts.session.tabs.changes, `切到 ${texts.locale} 后检查面板「改动」标签`);
  }
  const roomInput = page
    .getByTestId("room-window")
    .getByRole("combobox", { name: texts.rooms.composerLabel(PROJECT_NAME), exact: true });
  await roomInput.waitFor({ timeout: 15_000 });
  const roomDraft = await roomInput.inputValue();
  if (roomDraft !== ROOM_DRAFT) throw new Error(`切到 ${texts.locale} 后讨论窗口的草稿变了：「${roomDraft}」`);
}

/** 发出去的东西：讨论夹具收到的消息数，会话里提交的消息与开始的回合数。 */
async function sentCounts(
  context: GateCStepContext,
  sessionId: string,
): Promise<{ roomMessages: number; submitted: number; turns: number }> {
  const session = await context.page.evaluate(async (id) => {
    let after = 0;
    let submitted = 0;
    let turns = 0;
    for (let round = 0; round < 40; round += 1) {
      const response = await fetch(
        `/api/v1/sessions/${encodeURIComponent(id)}/events/backfill?after=${String(after)}&until=${String(Number.MAX_SAFE_INTEGER)}&limit=500`,
      );
      const chunk = (await response.json()) as { seq: number; type: string }[];
      submitted += chunk.filter((event) => event.type === "message.submitted").length;
      turns += chunk.filter((event) => event.type === "turn.started").length;
      const last = chunk.at(-1);
      if (chunk.length < 500 || last === undefined) break;
      after = last.seq;
    }
    return { submitted, turns };
  }, sessionId);
  return { roomMessages: context.requirementsFixture.roomMessageBodies().length, ...session };
}

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
    await capture(context, "en-10-settings-appearance.png");
    await auditUntranslatedText(context, "settings-appearance", { mustCover: ["settings-theme", "settings-locale"] });

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
    await capture(context, "en-11-settings-model.png");
    await auditUntranslatedText(context, "settings-model", { mustCover: ["model-config-warning", "model-api-key-masked"] });

    // gate-c 的服务以 SUDUO_MAX_APPROVAL_MODE=auto 启动：锁定说明是英文模板。
    await nav.getByRole("link", { name: new RegExp(`^${escapeRegExp(text.sections.execution)}`, "u") }).click();
    await page.getByRole("heading", { level: 2, name: text.sections.execution, exact: true }).waitFor();
    const reason = (await page.getByTestId("settings-lock-reason").first().textContent()) ?? "";
    const [before, after] = text.lockReason;
    if (!reason.includes(before.trim()) || !reason.includes(after.trim())) {
      throw new Error(`锁定说明应按英文模板「${before}…${after}」，实际为：${reason}`);
    }
    await auditUntranslatedText(context, "settings-execution", { mustCover: ["settings-lock-reason"] });

    // 诊断：各项结论与处理建议来自本机服务（按请求语言生成），等全部检查落定再查。
    await nav.getByRole("link", { name: new RegExp(`^${escapeRegExp(text.sections.diagnostics)}`, "u") }).click();
    await page.getByRole("list", { name: text.healthTitle, exact: true }).waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="health-item"][data-status="checking"]').length === 0,
      undefined,
      { timeout: 60_000 },
    );
    await page.getByTestId("settings-doctor-checks").waitFor({ timeout: 60_000 });
    await capture(context, "en-12-settings-diagnostics.png");
    // 检查项标题与说明是本机服务按请求语言生成的：这两块必须真的进了检查范围。
    await auditUntranslatedText(context, "settings-diagnostics", { mustCover: ["health-item", "settings-doctor-checks"] });
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
