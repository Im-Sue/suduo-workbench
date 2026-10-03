/**
 * 视觉回归工具：关键页 × 亮 / 暗 × 两个视口截图与比对（UI/UX 重设计 P5 起），也保留 pr13 的三页口径。
 *
 * pr13 的原始判定法：
 * spec 把判定法写死了：删除 `styles.css` 的 `v2-*` 段**前后**，对需求页／会话页／
 * 设置页各截一组**同视口**截图做像素比对，差异逐处解释；不接受「看着没问题」。
 *
 * 这里只负责「截图 + 比对」这件机械事，判定与解释由归档记录承担。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";

export interface VisualShot {
  name: string;
  bytes: number;
  sha256: string;
}

const VIEWPORT = { width: 1440, height: 900 } as const;

/** 视觉基线的两个视口（技术设计 §十一）：常见桌面宽度与检查面板让位的临界宽度。 */
export const VISUAL_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
] as const;
export const VISUAL_THEMES = ["light", "dark"] as const;
export type VisualTheme = (typeof VISUAL_THEMES)[number];

export interface KeyPageTarget {
  name: string;
  url: string;
  ready: string;
}

/**
 * 关键页（视觉基线与无障碍检查共用）：我的工作、需求看板 / 列表 / 详情、会话、设置、概览。
 * 会话页直接用 /sessions/<id> 定位到已建立的会话，避免落到空态。
 */
export function keyPageTargets(input: {
  origin: string;
  remoteProjectId: string;
  sessionId: string;
  requirementNumber: number;
}): KeyPageTarget[] {
  const project = input.origin + "/p/" + encodeURIComponent(input.remoteProjectId);
  return [
    { name: "my", url: input.origin + "/my", ready: "workbench-actions" },
    { name: "requirements", url: project + "/requirements?view=board", ready: "requirements-board" },
    { name: "requirements-list", url: project + "/requirements?view=list", ready: "requirements-list" },
    { name: "requirement-detail", url: project + "/requirements/" + String(input.requirementNumber), ready: "requirement-detail" },
    { name: "sessions", url: input.origin + "/sessions/" + encodeURIComponent(input.sessionId), ready: "sessions-rail" },
    { name: "settings", url: input.origin + "/settings/account", ready: "settings-page" },
    { name: "overview", url: project + "/overview", ready: "overview-status-funnel" },
  ];
}

/** 切主题：本机偏好写 localStorage（首屏脚本读它，不闪），同时让系统配色一致、关掉动效。下一次导航生效。 */
export async function applyTheme(page: Page, theme: VisualTheme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.evaluate((value) => window.localStorage.setItem("suduo.theme", value), theme);
}

/**
 * 在切主题前记下当时的主题偏好，返回复位函数：步骤结束后还原，免得影响后面的步骤。
 * （浏览器上下文的配色与动效回到创建时的默认。）
 */
export async function rememberTheme(page: Page): Promise<() => Promise<void>> {
  const previous = await page.evaluate(() => window.localStorage.getItem("suduo.theme"));
  return async () => {
    await page.emulateMedia({ colorScheme: null, reducedMotion: null });
    await page.evaluate((value) => {
      if (value === null) window.localStorage.removeItem("suduo.theme");
      else window.localStorage.setItem("suduo.theme", value);
    }, previous);
  };
}

export async function openKeyPage(page: Page, target: KeyPageTarget): Promise<void> {
  // 不能用 networkidle：SSE 长连接常驻，网络永远不空闲。
  await page.goto(target.url, { waitUntil: "domcontentloaded" });
  await page.getByTestId(target.ready).first().waitFor({ timeout: 30_000 });
  // 就绪标记可能先于数据出现（区块先渲染骨架屏）：等内容区里的骨架屏与「加载中」都消失，
  // 否则无障碍检查只看到半截页面、截图每次不一样。等不到也继续（由截图与报告暴露）。
  await page
    .waitForFunction(
      () => {
        const main = document.getElementById("main-content") ?? document.body;
        return main.querySelector('[data-slot="skeleton"], [aria-busy="true"]') === null;
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(300);
}

export async function captureVisualSet(input: {
  page: Page;
  outDir: string;
  label: string;
  targets: KeyPageTarget[];
  /** 不传时只按 1440×900、当前主题截（pr13 口径）。 */
  matrix?: { themes: readonly VisualTheme[]; viewports: readonly { width: number; height: number }[] };
}): Promise<VisualShot[]> {
  mkdirSync(input.outDir, { recursive: true });
  const shots: VisualShot[] = [];
  const themes = input.matrix?.themes ?? [null];
  const viewports = input.matrix?.viewports ?? [VIEWPORT];
  const restoreTheme = input.matrix === undefined ? null : await rememberTheme(input.page);
  try {
    for (const theme of themes) {
      if (theme !== null) await applyTheme(input.page, theme);
      for (const viewport of viewports) {
        await input.page.setViewportSize({ ...viewport });
        for (const target of input.targets) {
          await openKeyPage(input.page, target);
          const name =
            input.matrix === undefined ? target.name : `${target.name}-${theme ?? "current"}-${viewport.width}x${viewport.height}`;
          const file = resolve(input.outDir, `${input.label}-${name}.png`);
          await input.page.screenshot({ path: file, fullPage: false });
          const bytes = readFileSync(file);
          shots.push({ name, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
        }
      }
    }
  } finally {
    await input.page.setViewportSize({ ...VIEWPORT });
    await restoreTheme?.();
  }
  writeFileSync(
    resolve(input.outDir, `${input.label}.json`),
    JSON.stringify(shots, null, 2) + "\n",
  );
  return shots;
}

/** 逐页比对：同 sha256 即像素完全一致；不一致则报出双方指纹供人工逐处解释。 */
export function compareVisualSets(
  before: VisualShot[],
  after: VisualShot[],
): { name: string; identical: boolean; before: string; after: string }[] {
  return before.map((shot) => {
    const other = after.find((item) => item.name === shot.name);
    return {
      name: shot.name,
      identical: other !== undefined && other.sha256 === shot.sha256,
      before: shot.sha256.slice(0, 16),
      after: other === undefined ? "(缺失)" : other.sha256.slice(0, 16),
    };
  });
}
