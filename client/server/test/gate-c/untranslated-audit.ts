/// <reference lib="dom" />
/**
 * 英文冒烟的「漏翻检查」（中英双语技术设计 §五）：英文界面的框架元素里不该出现中文。
 *
 * 区分「漏翻」与「本来就该原样显示的中文」：
 * - 只看框架元素——标题、按钮、链接、标签页、菜单项、单选 / 开关、表头、表单标签、空态 / 报错 / 全局提示，
 *   以及任何可见元素上的 aria-label、title、placeholder、alt。正文段落不看。
 * - 人写的内容与 AI 回复原样显示（用户确认的原则）：夹具里的项目名、人名、需求标题、材料名、评论、讨论消息，
 *   gate-c 自己输入的会话名，本机会话列表里的消息预览（用户与 Codex 写的），用户自己配置的模型名，
 *   以及各语言用自己写法显示的语言名（「简体中文」）。先把这些整段去掉；剩下的中文片段如果只是它们的一截
 *   （界面截断了长文字），也算允许。
 * - 用户消息、Codex 回复、计划、代码与命令、文件预览所在的区域整块不看。
 *
 * 去掉允许的文字后还剩中文，就是漏翻：列出所在元素与原文，写进 artifacts/gate-c/untranslated/<页面>.json。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { GATE_C_FIXTURE_HUMAN_TEXTS } from "./requirements-service-fixture.js";
import type { GateCStepContext } from "./steps/types.js";
import { GATE_C_SESSION_TITLE } from "./steps/v2-user-path.js";

/** 与两端 eslint 的中文检测同一范围：CJK 文字与全角标点。 */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f],
  [0x3400, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];
const CJK_CLASS = CJK_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("");
const CJK = new RegExp(`[${CJK_CLASS}]`, "u");
const CJK_RUNS = new RegExp(`[${CJK_CLASS}]+`, "gu");

export function containsCjk(value: string): boolean {
  return CJK.test(value);
}

/** 框架元素：它们的文字（整段）都该是界面语言。 */
const CHROME_SELECTORS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "button",
  "[role=button]",
  "a[href]",
  "[role=link]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=menuitemradio]",
  "[role=menuitemcheckbox]",
  "[role=option]",
  "[role=radio]",
  "[role=switch]",
  "[role=checkbox]",
  "th",
  "[role=columnheader]",
  "label",
  "legend",
  "[role=tooltip]",
  '[data-testid="empty-state"]',
  '[data-testid="region-error"]',
  '[data-testid="inline-error"]',
  '[data-testid="global-message"]',
] as const;

/** 任何可见元素上都该是界面语言的属性。 */
const CHROME_ATTRIBUTES = ["aria-label", "title", "placeholder", "alt"] as const;

/** 人写内容与 AI 产出所在的区域：整块不看。 */
const CONTENT_REGIONS = [
  '[data-testid="user-message"]',
  '[data-testid="assistant-text"]',
  '[data-testid="plan-checklist"]',
  '[data-testid="file-preview"]',
  '[data-testid="diff-view"]',
  '[data-testid="patch-view"]',
  '[data-testid="monaco-surface"]',
  '[data-testid="sheet-table"]',
  "pre",
  "code",
] as const;

export interface TextSample {
  /** 元素的简短描述（标签、角色、最近的 data-testid、来自哪个属性）。 */
  where: string;
  text: string;
}

export interface UntranslatedFinding extends TextSample {
  /** 去掉允许的文字后剩下的中文片段。 */
  residue: string[];
}

/**
 * 纯函数：在样本里找漏翻。`allowed` 是允许原样出现的文字（不含中文的条目会被忽略）。
 * 先整段去掉允许的文字（长的先去）；剩下的中文片段若至少两个字且是某段允许文字的一截（界面截断），也放过。
 */
export function findUntranslated(
  samples: readonly TextSample[],
  allowed: readonly string[],
): UntranslatedFinding[] {
  const allow = [...new Set(allowed.map((item) => item.trim()).filter(containsCjk))].sort(
    (left, right) => right.length - left.length,
  );
  const findings: UntranslatedFinding[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (!containsCjk(sample.text)) continue;
    let rest = sample.text;
    for (const item of allow) rest = rest.split(item).join(" ");
    const residue = (rest.match(CJK_RUNS) ?? []).filter(
      (run) => !(Array.from(run).length >= 2 && allow.some((item) => item.includes(run))),
    );
    if (residue.length === 0) continue;
    const key = `${sample.where}\n${sample.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...sample, residue });
  }
  return findings;
}

/**
 * 在页面里收集框架元素的文字与属性（只收可见的，跳过内容区域）。
 * 注意：传给 page.evaluate 的函数里不能再定义具名函数（含赋给常量的箭头函数）——gate-c 经 tsx 运行，
 * esbuild 会给它们包一层 `__name(...)`，到了浏览器里没有这个辅助函数，直接报错。
 */
export async function collectChromeTexts(page: Page): Promise<TextSample[]> {
  return page.evaluate(
    ({ chrome, attributes, regions }) => {
      const regionSelector = regions.join(",");
      const candidates: [Element, string | null][] = [];
      for (const element of document.querySelectorAll(chrome.join(","))) candidates.push([element, null]);
      for (const element of document.querySelectorAll(attributes.map((name) => `[${name}]`).join(","))) {
        for (const name of attributes) if (element.hasAttribute(name)) candidates.push([element, name]);
      }
      const samples: { where: string; text: string }[] = [];
      for (const [element, attribute] of candidates) {
        if (element.closest(regionSelector) !== null || !element.checkVisibility({ visibilityProperty: true })) continue;
        const role = element.getAttribute("role");
        const testId = element.closest("[data-testid]")?.getAttribute("data-testid");
        const where =
          element.tagName.toLowerCase() +
          (role === null ? "" : `[role=${role}]`) +
          (testId ? ` @${testId}` : "") +
          (attribute === null ? "" : ` ${attribute}`);
        let text: string;
        if (attribute !== null) {
          text = element.getAttribute(attribute)?.trim() ?? "";
        } else {
          // 元素自己的可见文字：逐个文字节点取，跳过内容区域与看不见的部分。
          const parts: string[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const parent = node.parentElement;
            if (parent === null || parent.closest(regionSelector) !== null) continue;
            if (!parent.checkVisibility({ visibilityProperty: true })) continue;
            const value = node.nodeValue?.trim();
            if (value) parts.push(value);
          }
          text = parts.join(" ").replace(/\s+/gu, " ").trim();
        }
        if (text !== "") samples.push({ where, text });
      }
      return samples;
    },
    { chrome: [...CHROME_SELECTORS], attributes: [...CHROME_ATTRIBUTES], regions: [...CONTENT_REGIONS] },
  );
}

/**
 * 这一轮里用户与 Codex 写下的文字（经本机服务取）：会话列表的消息预览、用户配置的模型服务与模型名。
 * 它们会出现在会话行、我的工作的会话卡、模型选择上，原样显示，不算漏翻。
 */
export async function runtimeHumanTexts(page: Page): Promise<string[]> {
  const [sessions, models, provider] = await page.evaluate(async (urls) => {
    const bodies: unknown[] = [];
    for (const url of urls) {
      try {
        const response = await fetch(url);
        bodies.push(response.ok ? ((await response.json()) as unknown) : null);
      } catch {
        bodies.push(null);
      }
    }
    return bodies;
  }, ["/api/v1/sessions?state=all&limit=50", "/api/v1/codex/models", "/api/v1/settings/model-provider"]);
  const texts: string[] = [];
  for (const item of arrayField(sessions, "items")) texts.push(...stringFields(field(item, "preview"), ["text"]));
  texts.push(...arrayField(models, "models").filter((item): item is string => typeof item === "string"));
  for (const item of arrayField(models, "items")) texts.push(...stringFields(item, ["id", "model", "displayName", "description"]));
  texts.push(...stringFields(provider, ["providerId", "providerName", "baseUrl", "model"]));
  return texts.filter((text) => text !== "");
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  const item = field(value, key);
  return Array.isArray(item) ? (item as unknown[]) : [];
}

function stringFields(value: unknown, keys: readonly string[]): string[] {
  return keys.flatMap((key) => {
    const item = field(value, key);
    return typeof item === "string" ? [item] : [];
  });
}

/** 静态允许的中文：夹具演示数据、gate-c 自己起的会话名、各语言用自己写法显示的语言名。 */
export function staticAllowedTexts(context: Pick<GateCStepContext, "ui">): string[] {
  return [...GATE_C_FIXTURE_HUMAN_TEXTS, GATE_C_SESSION_TITLE, ...context.ui.nativeLocaleNames];
}

/**
 * 检查当前页面并记下结果（artifacts/gate-c/untranslated/<name>.json）。有漏翻时不在这里中断：
 * 记进 `context.untranslated`，整轮跑完由 gate-c.real.ts 统一判失败——一次运行就能看到所有页面的漏翻。
 * 只在非中文验收时有意义；中文验收直接跳过。
 */
export async function auditUntranslatedText(
  context: GateCStepContext,
  name: string,
  extraAllowed: readonly string[] = [],
): Promise<void> {
  if (context.locale === "zh-CN") return;
  const samples = await collectChromeTexts(context.page);
  const allowed = [...staticAllowedTexts(context), ...(await runtimeHumanTexts(context.page)), ...extraAllowed];
  const findings = findUntranslated(samples, allowed);
  const outDir = resolve(context.artifactRoot, "untranslated");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, `${name}.json`),
    JSON.stringify(
      {
        page: name,
        url: context.page.url(),
        findings,
        // 含中文但被放过的样本，方便人工复核放过得对不对。
        allowedCjk: samples.filter(
          (sample) =>
            containsCjk(sample.text) &&
            !findings.some((item) => item.where === sample.where && item.text === sample.text),
        ),
        sampleCount: samples.length,
      },
      null,
      2,
    ) + "\n",
  );
  if (findings.length === 0) return;
  context.untranslated.push({ page: name, findings });
  console.warn(
    `[untranslated] ${name}：英文界面的框架元素里有 ${String(findings.length)} 处中文（详见 untranslated/${name}.json）`,
  );
}

/** 整轮结束时的结论：有任何页面漏翻就失败，逐页列出前几处。 */
export function untranslatedSummary(pages: readonly { page: string; findings: readonly UntranslatedFinding[] }[]): string | null {
  if (pages.length === 0) return null;
  return (
    `英文界面有 ${String(pages.length)} 个页面的框架元素里出现了中文（详见 artifacts/gate-c/untranslated/*.json）：\n` +
    pages
      .map(
        (item) =>
          `${item.page}：\n` +
          item.findings
            .slice(0, 10)
            .map((finding) => `  - ${finding.where}：「${finding.text.slice(0, 160)}」→ ${finding.residue.join(" / ")}`)
            .join("\n"),
      )
      .join("\n")
  );
}
