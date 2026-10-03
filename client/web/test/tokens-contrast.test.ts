import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 令牌对比度（WCAG AA，正文 4.5:1）：文字色 × 它会落在的表面。
 * gate-c 的 axe 检查只能看到当前页面上出现的组合，这里把令牌层的组合一次核完，改令牌时就能发现。
 * 只核十六进制取值（暗色的柔和底色是半透明色，由 axe 在真实页面上核）。
 */
const css = readFileSync(new URL("../src/design/tokens.css", import.meta.url), "utf8");
const darkStart = css.indexOf(':root[data-theme="dark"]');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((match) => [match[1]!, match[2]!]));
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const TEXT = ["foreground", "muted-foreground", "subtle-foreground", "primary-text", "success", "warning", "danger"];
/** 实底 + 字色的组合（按钮、徽标、步骤圆点）：[底色令牌, 字色令牌或固定色]。 */
const FILLS: [string, string][] = [
  ["primary", "primary-foreground"],
  ["destructive", "destructive-foreground"],
  ["success", "background"],
  ["warning", "background"],
  ["foreground", "background"],
];
const SURFACES = ["background", "card", "muted", "muted-strong", "popover"];
const TONE_ON_SOFT: [string, string][] = [
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["primary-text", "primary-soft"],
];

describe.each([
  ["亮色", tokens(css.slice(0, darkStart))],
  ["暗色", tokens(css.slice(darkStart))],
])("%s令牌对比度", (_theme, values) => {
  it("文字色在各层表面上都不低于 4.5:1", () => {
    const failures: string[] = [];
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        const fg = values[text];
        const bg = values[surface];
        // 令牌改了名就该让这里失败，而不是悄悄跳过。
        if (fg === undefined || bg === undefined) {
          failures.push(`缺少令牌：${fg === undefined ? text : surface}`);
          continue;
        }
        const ratio = contrast(fg, bg);
        if (ratio < 4.5) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("实底上的字色不低于 4.5:1（按钮、徽标、步骤圆点）", () => {
    const failures: string[] = [];
    for (const [fill, text] of FILLS) {
      const bg = values[fill];
      const fg = text.startsWith("#") ? text : values[text];
      if (bg === undefined || fg === undefined) {
        failures.push(`缺少令牌：${bg === undefined ? fill : text}`);
        continue;
      }
      const ratio = contrast(fg, bg);
      if (ratio < 4.5) failures.push(`${text} on ${fill}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it("语义色在自己的柔和底色上不低于 4.5:1（徽章、提示条）", () => {
    const failures: string[] = [];
    for (const [text, soft] of TONE_ON_SOFT) {
      const fg = values[text];
      const bg = values[soft];
      // 暗色的柔和底色是半透明色（不是十六进制），交给 axe 在真实页面上核。
      if (fg === undefined || bg === undefined) continue;
      const ratio = contrast(fg, bg);
      if (ratio < 4.5) failures.push(`${text} on ${soft}: ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });
});
