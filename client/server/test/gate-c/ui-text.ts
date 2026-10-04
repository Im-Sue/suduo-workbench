/**
 * gate-c 按语言取界面文字（中英双语技术设计 §五）。
 *
 * 默认按中文跑；`SUDUO_GATE_LOCALE=en` 跑英文冒烟。步骤里定位按钮、标题、标签用的文字一律从前端字典
 * `client/web/src/i18n/messages/{zh-CN,en}` 取，不在测试里另写一份英文句子：措辞改了，冒烟跟着变。
 *
 * 前端字典引用了 React 类型与前端模块，不能并进本机服务的类型检查（rootDir、jsx 都不同），所以运行时动态载入，
 * 在这里按路径逐项取出并校验类型——键改名或删掉时，gate-c 在启动时（以及 `ui-text.test.ts`）立刻报出缺哪一项，
 * 不会跑到一半才因为找不到按钮超时。
 */
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REQUIREMENT_STATUSES, type RequirementStatus } from "@suduo/cloud-contracts";
import type { Locale } from "@suduo/client-contracts";

/** 前端字典入口（与本文件的相对位置固定：client/server/test/gate-c → client/web/src）。 */
const WEB_MESSAGES = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../web/src/i18n/messages/index.ts",
);

export const GATE_LOCALES: readonly Locale[] = ["zh-CN", "en"];

/** `SUDUO_GATE_LOCALE`：不设或空 = 中文（默认验收语言）；写错立刻失败，别先装服务、跑模型。 */
export function gateLocaleFromEnv(raw: string | undefined): Locale {
  const value = (raw ?? "").trim();
  if (value === "") return "zh-CN";
  const locale = GATE_LOCALES.find((item) => item === value);
  if (locale === undefined) {
    throw new Error(`SUDUO_GATE_LOCALE 只认 ${GATE_LOCALES.join(" / ")}，实际为「${value}」`);
  }
  return locale;
}

/** Playwright 浏览器上下文的 locale：决定「跟随系统」时的界面语言与 Intl 格式。 */
export function browserLocaleOf(locale: Locale): string {
  return locale === "en" ? "en-US" : "zh-CN";
}

/** gate-c 步骤用到的界面文字（只放步骤真正定位或断言的那些）。 */
export interface GateUiText {
  locale: Locale;
  /**
   * 设计上就不随界面语言变的外语文字：语言选项里各语言用自己的写法显示（英文界面里的「简体中文」）。
   * 英文界面检查漏翻时把它们当成允许出现的文字。
   */
  nativeLocaleNames: readonly string[];
  login: { title: string; loginName: string; password: string; submit: string };
  nav: {
    myWork: string;
    requirements: string;
    rooms: string;
    sessions: string;
    overview: string;
    settings: string;
  };
  projectSwitcher: (project: string) => string;
  palette: {
    title: string;
    startProjectSession: string;
    /** gate-c 在面板里输入的搜索词（相当于用户输入，不是界面文字）。 */
    query: string;
  };
  startSession: {
    directoryTitle: string;
    createNew: string;
    /** 「没能开始会话：原因」去掉原因与结尾标点的前半句。 */
    failed: string;
    manual: string;
    manualLabel: string;
    /** 目录可读写时的结论（不是 Git 仓库 / 是 Git 仓库，后者带分支时以它开头）。 */
    readable: readonly [notGitRepo: string, gitRepo: string];
    useDirectory: string;
  };
  myWork: { title: string; attention: string };
  requirements: {
    status: Readonly<Record<RequirementStatus, string>>;
    searchLabel: string;
    peekStartSession: string;
    detailStartSession: string;
    activityList: string;
  };
  session: {
    messageLabel: string;
    approve: string;
    decline: string;
    tabs: { changes: string; files: string };
  };
  rooms: {
    composerLabel: (room: string) => string;
    send: string;
    projectScope: string;
  };
  settings: {
    navLabel: string;
    sections: { appearance: string; model: string; execution: string; diagnostics: string };
    localeTitle: string;
    localeOption: Readonly<Record<"system" | Locale, string>>;
    configWarningTitle: string;
    /** 锁定说明的前后两段（中间是审批档名）。 */
    lockReason: readonly [string, string];
    healthTitle: string;
  };
}

/** 载入前端字典并取出 gate-c 用到的文字。 */
export async function loadGateUiText(locale: Locale): Promise<GateUiText> {
  const module = (await import(pathToFileURL(WEB_MESSAGES).href)) as { messagesFor?: unknown };
  if (typeof module.messagesFor !== "function") {
    throw new Error(`${WEB_MESSAGES} 没有导出 messagesFor`);
  }
  const messagesFor = module.messagesFor as (value: Locale) => unknown;
  return buildGateUiText(locale, messagesFor(locale));
}

function buildGateUiText(locale: Locale, dict: unknown): GateUiText {
  const text = (path: string) => readText(dict, path);
  const template = (path: string) => readTemplate(dict, path);
  const startProjectSession = text("shell.commandPalette.actions.startProjectSession");
  const localeOption = {
    system: text("common.localeOption.system"),
    "zh-CN": text("common.localeOption.zh-CN"),
    en: text("common.localeOption.en"),
  };
  return {
    locale,
    // 别的语言的语言名按它自己的写法显示；当前语言自己的名字照常要翻译。
    nativeLocaleNames: GATE_LOCALES.filter((item) => item !== locale).map((item) => localeOption[item]),
    login: {
      title: text("setup.login.title"),
      loginName: text("setup.loginForm.loginName"),
      password: text("setup.loginForm.password"),
      submit: text("setup.loginForm.submitLogin"),
    },
    nav: {
      myWork: text("shell.nav.myWork"),
      requirements: text("shell.nav.requirements"),
      rooms: text("shell.nav.rooms"),
      sessions: text("shell.nav.sessions"),
      overview: text("shell.nav.overview"),
      settings: text("shell.nav.settings"),
    },
    projectSwitcher: template("shell.projectSwitcher.trigger"),
    palette: {
      title: text("shell.commandPalette.title"),
      startProjectSession,
      // 中文沿用 gate-c 一直输入的「项目会话」；其他语言直接输入命令名。
      query: locale === "zh-CN" ? "项目会话" : startProjectSession,
    },
    startSession: {
      directoryTitle: text("requirements.startSession.directoryTitle"),
      createNew: text("requirements.startSession.choose.createNew"),
      failed: stripTrailingPunctuation(templateParts(template("requirements.startSession.failed"))[0]),
      manual: text("requirements.directoryPicker.manual"),
      manualLabel: text("requirements.directoryPicker.manualLabel"),
      readable: [
        text("requirements.directoryPicker.verdict.notGitRepo"),
        text("requirements.directoryPicker.verdict.ok"),
      ],
      useDirectory: text("requirements.startSession.directory.use"),
    },
    myWork: {
      title: text("myWork.header.title"),
      attention: text("myWork.attention.title"),
    },
    requirements: {
      status: Object.fromEntries(
        REQUIREMENT_STATUSES.map((status) => [status, text(`common.requirementStatus.${status}`)]),
      ) as Record<RequirementStatus, string>,
      searchLabel: text("requirements.page.searchLabel"),
      peekStartSession: text("requirements.peek.startSession"),
      detailStartSession: text("requirementDetail.page.startSession"),
      activityList: text("requirementDetail.activity.listLabel"),
    },
    session: {
      messageLabel: text("workbench.composer.messageLabel"),
      approve: text("conversation.approval.approve"),
      decline: text("conversation.approval.decline"),
      tabs: {
        changes: text("workbench.inspector.tabs.changes"),
        files: text("workbench.inspector.tabs.files"),
      },
    },
    rooms: {
      composerLabel: template("rooms.composer.messageLabel"),
      send: text("rooms.composer.send"),
      projectScope: text("rooms.header.projectScope"),
    },
    settings: {
      navLabel: text("settings.nav.label"),
      sections: {
        appearance: text("settings.sections.appearance"),
        model: text("settings.sections.model"),
        execution: text("settings.sections.execution"),
        diagnostics: text("settings.sections.diagnostics"),
      },
      localeTitle: text("settingsAgent.appearance.locale.title"),
      localeOption,
      configWarningTitle: text("settingsConnection.model.banner.warningTitle"),
      lockReason: templateParts(template("settingsAgent.execution.approval.lockReason")),
      healthTitle: text("settings.diagnostics.healthTitle"),
    },
  };
}

function readPath(root: unknown, path: string): unknown {
  let node = root;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null || !(key in node)) {
      throw new Error(`前端字典缺少 ${path}（gate-c/ui-text.ts 按路径取文字，字典改了键名要同步这里）`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function readText(root: unknown, path: string): string {
  const value = readPath(root, path);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`前端字典 ${path} 应为非空文字，实际为 ${typeof value}`);
  }
  return value;
}

function readTemplate(root: unknown, path: string): (value: string) => string {
  const value = readPath(root, path);
  if (typeof value !== "function") {
    throw new Error(`前端字典 ${path} 应为带一个参数的模板函数，实际为 ${typeof value}`);
  }
  return (argument) => {
    const result: unknown = (value as (input: string) => unknown)(argument);
    if (typeof result !== "string") throw new Error(`前端字典 ${path} 返回的不是文字`);
    return result;
  };
}

const SLOT = "<<gate-c-slot>>";

/** 单参数模板在参数前后的两段文字（参数恰好出现一次）。 */
export function templateParts(render: (value: string) => string): [string, string] {
  const parts = render(SLOT).split(SLOT);
  if (parts.length !== 2) throw new Error(`模板里参数出现了 ${String(parts.length - 1)} 次，只支持恰好一次`);
  return [parts[0] ?? "", parts[1] ?? ""];
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[\p{P}\s]+$/u, "");
}
