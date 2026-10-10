import type { DesktopLocale } from "../i18n/index.js";

/** 帮助链接（外链一律交给系统浏览器）。使用说明按外壳语言给中文或英文版。 */
export function helpUrl(kind: "website" | "guide" | "issues", locale: DesktopLocale): string {
  switch (kind) {
    case "website":
      return locale === "zh-CN" ? "https://suduo.dev/zh/" : "https://suduo.dev/";
    case "guide":
      return `https://github.com/Im-Sue/suduo-workbench/blob/main/client/README${locale === "zh-CN" ? ".zh-CN" : ""}.md`;
    case "issues":
      return "https://github.com/Im-Sue/suduo-workbench/issues";
  }
}
