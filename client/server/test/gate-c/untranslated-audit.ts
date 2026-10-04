/// <reference lib="dom" />
/**
 * 英文冒烟的「漏翻检查」（中英双语技术设计 §五）：英文界面里不该出现系统写的中文。
 *
 * 查什么：整页可见文字（按块收集：同一个块里的行内文字拼成一段，免得高亮、加粗把一句话拆碎），
 * 加上任何可见元素上的 aria-label、title、placeholder、alt。按钮、标题、表头、横幅（role=status / alert）、
 * 会话里的运行提示、诊断页本机服务生成的检查项标题与说明都在里面。只整块跳过下面「内容区域」。
 *
 * 区分「漏翻」与「本来就该原样显示的中文」：
 * - 人写的内容与 AI 回复原样显示（用户确认的原则）。Markdown 渲染的正文（需求描述、评论、讨论消息、Codex 回复、
 *   思考过程）、用户消息、计划、代码与命令、文件预览所在的区域整块不看；
 * - 其余位置出现的人写 / AI 文字逐字放过：夹具里的项目名、人名、需求标题、材料名、评论、讨论消息，
 *   gate-c 自己输入的会话名，本机会话列表里的消息预览，会话事件里 Codex 写的思考摘要（标题会进「思考：…」）
 *   与审批理由，用户自己配置的模型名，以及各语言用自己写法显示的语言名（「简体中文」）；
 * - 界面用脚本截断的长文字：只放过「允许文字的前缀（至少 4 个字）紧跟省略号」这一种形状。
 *   CSS 截断不改 DOM 里的文字，不需要放宽；单独出现的常用词（「删除」「需求」……）一律算漏翻。
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

/** 任何可见元素上都该是界面语言的属性。 */
const TEXT_ATTRIBUTES = ["aria-label", "title", "placeholder", "alt"] as const;

/** 人写内容与 AI 产出所在的区域：整块不看。`.md` 是 Markdown 渲染的正文（ui/markdown.tsx）。 */
const CONTENT_REGIONS = [
  ".md",
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

/** 截断的人写文字至少要有这么长的前缀才放过（太短的前缀和常用词分不开）。 */
const MIN_TRUNCATED_PREFIX = 4;
const ELLIPSES = ["…", "..."] as const;

export interface TextSample {
  /** 文字所在块的简短描述（标签、角色、最近的 data-testid、来自哪个属性）。 */
  where: string;
  text: string;
  /** 所在块及其祖先上的全部 data-testid（核对「该查的区域真的查到了」）。 */
  testIds?: string[];
}

export interface UntranslatedFinding extends TextSample {
  /** 去掉允许的文字后剩下的中文片段。 */
  residue: string[];
}

/**
 * 纯函数：在样本里找漏翻。`allowed` 是允许原样出现的文字（不含中文的条目会被忽略）。
 * 先去掉「允许文字的前缀 + 省略号」（界面截断的长文字），再整段去掉允许的文字（都是长的先去），剩下的中文都算漏翻。
 */
export function findUntranslated(
  samples: readonly TextSample[],
  allowed: readonly string[],
): UntranslatedFinding[] {
  const allow = [...new Set(allowed.map((item) => item.trim()).filter(containsCjk))].sort(
    (left, right) => right.length - left.length,
  );
  let truncated: string[] | null = null;
  const findings: UntranslatedFinding[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (!containsCjk(sample.text)) continue;
    let rest = sample.text;
    if (ELLIPSES.some((ellipsis) => rest.includes(ellipsis))) {
      truncated ??= truncatedForms(allow);
      for (const item of truncated) rest = rest.split(item).join(" ");
    }
    for (const item of allow) rest = rest.split(item).join(" ");
    const residue = rest.match(CJK_RUNS) ?? [];
    if (residue.length === 0) continue;
    const key = `${sample.where}\n${sample.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ where: sample.where, text: sample.text, residue });
  }
  return findings;
}

/** 允许文字被截断后的样子：含中文、至少 MIN_TRUNCATED_PREFIX 个字的前缀紧跟省略号。长的在前。 */
function truncatedForms(allow: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const item of allow) {
    const chars = Array.from(item);
    for (let length = chars.length - 1; length >= MIN_TRUNCATED_PREFIX; length -= 1) {
      const prefix = chars.slice(0, length).join("").trimEnd();
      if (Array.from(prefix).length < MIN_TRUNCATED_PREFIX || !containsCjk(prefix)) continue;
      for (const ellipsis of ELLIPSES) forms.add(prefix + ellipsis);
    }
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

/**
 * 在页面里收集整页可见文字（按块）与可见元素的文字属性，跳过内容区域。
 *
 * 一段文字归到离它最近的「非行内」祖先（display 不是 inline）：`看板<mark>草稿</mark>一` 合成一段。
 * 注意：传给 page.evaluate 的函数里不能再定义具名函数（含赋给常量的箭头函数）——gate-c 经 tsx 运行，
 * esbuild 会给它们包一层 `__name(...)`，到了浏览器里没有这个辅助函数，直接报错。
 */
export async function collectPageTexts(page: Page): Promise<TextSample[]> {
  return page.evaluate(
    ({ attributes, regions }) => {
      const regionSelector = regions.join(",");
      const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
      const blocks = new Map<Element, string[]>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? "";
        const parent = node.parentElement;
        if (value.trim() === "" || parent === null || skipTags.has(parent.tagName)) continue;
        if (parent.closest(regionSelector) !== null) continue;
        if (!parent.checkVisibility({ visibilityProperty: true })) continue;
        let block: Element = parent;
        while (block.parentElement !== null && block !== document.body && getComputedStyle(block).display === "inline") {
          block = block.parentElement;
        }
        const parts = blocks.get(block) ?? [];
        parts.push(value);
        blocks.set(block, parts);
      }
      const entries: [Element, string, string | null][] = [];
      for (const [block, parts] of blocks) entries.push([block, parts.join(""), null]);
      for (const element of document.querySelectorAll(attributes.map((name) => `[${name}]`).join(","))) {
        if (element.closest(regionSelector) !== null || !element.checkVisibility({ visibilityProperty: true })) continue;
        for (const name of attributes) {
          const value = element.getAttribute(name);
          if (value !== null) entries.push([element, value, name]);
        }
      }
      const samples: { where: string; text: string; testIds: string[] }[] = [];
      for (const [element, raw, attribute] of entries) {
        const text = raw.replace(/\s+/gu, " ").trim();
        if (text === "") continue;
        const testIds: string[] = [];
        for (let current: Element | null = element; current !== null; current = current.parentElement) {
          const id = current.getAttribute("data-testid");
          if (id !== null) testIds.push(id);
        }
        const role = element.getAttribute("role");
        const where =
          element.tagName.toLowerCase() +
          (role === null ? "" : `[role=${role}]`) +
          (testIds[0] === undefined ? "" : ` @${testIds[0]}`) +
          (attribute === null ? "" : ` ${attribute}`);
        samples.push({ where, text, testIds });
      }
      return samples;
    },
    { attributes: [...TEXT_ATTRIBUTES], regions: [...CONTENT_REGIONS] },
  );
}

/**
 * 这一轮里用户与 Codex 写下、会出现在内容区域之外的文字（经本机服务取）：会话列表的消息预览、
 * 会话事件里的思考摘要与审批理由、用户配置的模型服务与模型名。
 */
export async function runtimeHumanTexts(page: Page): Promise<string[]> {
  const raw = await page.evaluate(async (urls) => {
    const bodies: unknown[] = [];
    for (const url of urls) {
      try {
        const response = await fetch(url);
        bodies.push(response.ok ? ((await response.json()) as unknown) : null);
      } catch {
        bodies.push(null);
      }
    }
    // 各会话的事件（分页取完；上限 40 页，足够 gate-c 的会话）。
    const events: unknown[] = [];
    const list = bodies[0] as { items?: { id?: unknown }[] } | null;
    for (const item of list?.items ?? []) {
      if (typeof item.id !== "string") continue;
      let after = 0;
      for (let round = 0; round < 40; round += 1) {
        let chunk: unknown[];
        try {
          const response = await fetch(
            `/api/v1/sessions/${encodeURIComponent(item.id)}/events/backfill?after=${String(after)}&until=${String(Number.MAX_SAFE_INTEGER)}&limit=500`,
          );
          chunk = response.ok ? ((await response.json()) as unknown[]) : [];
        } catch {
          chunk = [];
        }
        events.push(...chunk);
        const last = chunk.at(-1) as { seq?: unknown } | undefined;
        if (chunk.length < 500 || typeof last?.seq !== "number") break;
        after = last.seq;
      }
    }
    return { bodies, events };
  }, ["/api/v1/sessions?state=all&limit=50", "/api/v1/codex/models", "/api/v1/settings/model-provider"]);
  const [sessions, models, provider] = raw.bodies;
  const texts: string[] = [];
  for (const item of arrayField(sessions, "items")) texts.push(...stringFields(field(item, "preview"), ["text"]));
  texts.push(...arrayField(models, "models").filter((item): item is string => typeof item === "string"));
  for (const item of arrayField(models, "items")) texts.push(...stringFields(item, ["id", "model", "displayName", "description"]));
  texts.push(...stringFields(provider, ["providerId", "providerName", "baseUrl", "model"]));
  texts.push(...aiTextsFromEvents(raw.events));
  return texts.filter((text) => text !== "");
}

/**
 * 纯函数：会话事件里 Codex 写的、会显示在内容区域之外的文字。
 * - 思考摘要：按 itemId 拼起来（与前端 event-projection/timeline.ts 同一做法），整段与开头的 **标题**
 *   （步骤标题显示成「思考：标题」）；
 * - 审批理由（审批卡里的说明）。
 */
export function aiTextsFromEvents(events: readonly unknown[]): string[] {
  const reasoning = new Map<string, string[]>();
  const texts: string[] = [];
  for (const event of events) {
    const type = field(event, "type");
    const payload = field(event, "payload");
    if (type === "approval.requested") {
      texts.push(...stringFields(field(payload, "request"), ["reason"]));
      continue;
    }
    if (type === "reasoning.summary-delta" || type === "reasoning.summary-part-added") {
      const itemId = field(payload, "itemId");
      if (typeof itemId !== "string") continue;
      const parts = reasoning.get(itemId) ?? [];
      const index = field(payload, "summaryIndex");
      const at = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : Math.max(parts.length - 1, 0);
      while (parts.length <= at) parts.push("");
      const delta = field(payload, "delta");
      if (type === "reasoning.summary-delta" && typeof delta === "string") parts[at] += delta;
      reasoning.set(itemId, parts);
      continue;
    }
    if (type === "item.started" || type === "item.completed") {
      const item = field(payload, "item");
      const summary = field(item, "summary");
      if (field(item, "type") !== "reasoning" || !Array.isArray(summary) || summary.length === 0) continue;
      const id = field(item, "id") ?? field(payload, "itemId");
      if (typeof id === "string") reasoning.set(id, summary.map(String));
    }
  }
  for (const parts of reasoning.values()) {
    const text = parts.filter((part) => part.trim() !== "").join("\n\n");
    if (text === "") continue;
    texts.push(text);
    const heading = /^\s*\*\*(.+?)\*\*/u.exec(text)?.[1]?.trim();
    if (heading) texts.push(heading);
  }
  return texts;
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

/** 纯函数：`mustCover` 里的哪些区域（data-testid）一段文字都没收到。 */
export function uncoveredRegions(samples: readonly TextSample[], mustCover: readonly string[]): string[] {
  return mustCover.filter((id) => !samples.some((sample) => sample.testIds?.includes(id) ?? false));
}

export interface AuditOptions {
  /** 这一步自己输入的人写内容（消息、草稿等）。 */
  allowed?: readonly string[];
  /**
   * 这一页必须收到文字的区域（data-testid）。步骤说要查哪些服务端文字，就把它们所在区域列在这里：
   * 一段都没收到说明检查漏掉了它们（选择器、可见性或页面状态不对），当场失败。
   */
  mustCover?: readonly string[];
}

/**
 * 检查当前页面并记下结果（artifacts/gate-c/untranslated/<name>.json）。有漏翻时不在这里中断：
 * 记进 `context.untranslated`，整轮跑完由 gate-c.real.ts 统一判失败——一次运行就能看到所有页面的漏翻。
 * `mustCover` 的区域没收到文字是检查本身的问题，当场失败。只在非中文验收时有意义；中文验收直接跳过。
 */
export async function auditUntranslatedText(
  context: GateCStepContext,
  name: string,
  options: AuditOptions = {},
): Promise<void> {
  if (context.locale === "zh-CN") return;
  const samples = await collectPageTexts(context.page);
  const allowed = [...staticAllowedTexts(context), ...(await runtimeHumanTexts(context.page)), ...(options.allowed ?? [])];
  const findings = findUntranslated(samples, allowed);
  const uncovered = uncoveredRegions(samples, options.mustCover ?? []);
  const outDir = resolve(context.artifactRoot, "untranslated");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, `${name}.json`),
    JSON.stringify(
      {
        page: name,
        url: context.page.url(),
        findings,
        uncovered,
        // 含中文但被放过的样本，方便人工复核放过得对不对。
        allowedCjk: samples
          .filter(
            (sample) =>
              containsCjk(sample.text) &&
              !findings.some((item) => item.where === sample.where && item.text === sample.text),
          )
          .map((sample) => ({ where: sample.where, text: sample.text })),
        sampleCount: samples.length,
      },
      null,
      2,
    ) + "\n",
  );
  if (uncovered.length > 0) {
    throw new Error(
      `${name}：漏翻检查没收到这些区域的文字：${uncovered.join(", ")}（页面状态或检查范围不对，详见 untranslated/${name}.json）`,
    );
  }
  if (findings.length === 0) return;
  context.untranslated.push({ page: name, findings });
  console.warn(
    `[untranslated] ${name}：英文界面里有 ${String(findings.length)} 处中文（详见 untranslated/${name}.json）`,
  );
}

/** 整轮结束时的结论：有任何页面漏翻就失败，逐页列出前几处。 */
export function untranslatedSummary(pages: readonly { page: string; findings: readonly UntranslatedFinding[] }[]): string | null {
  if (pages.length === 0) return null;
  return (
    `英文界面有 ${String(pages.length)} 个页面出现了系统写的中文（详见 artifacts/gate-c/untranslated/*.json）：\n` +
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
