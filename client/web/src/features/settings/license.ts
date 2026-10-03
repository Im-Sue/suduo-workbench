import type { Locale } from "@suduo/client-contracts";
import { currentLocale } from "../../i18n/locale.js";

/**
 * 许可信息：只展示，不做任何检查（ADR-0011）。
 * 说明文档按界面语言链到对应版本（英文主文件 + .zh-CN.md）；许可证原文只有英文版，中文是参考译文。
 */
export const LICENSE_NAME = "PolyForm Noncommercial 1.0.0";

const REPOSITORY_FILES = "https://github.com/Im-Sue/suduo-workbench/blob/main";

export function licenseLinks(locale: Locale = currentLocale()) {
  return {
    /** 许可证原文（英文，具有法律效力）。 */
    license: `${REPOSITORY_FILES}/LICENSE`,
    licenseTranslation: `${REPOSITORY_FILES}/LICENSE.zh-CN.md`,
    commercial: `${REPOSITORY_FILES}/${locale === "zh-CN" ? "COMMERCIAL.zh-CN.md" : "COMMERCIAL.md"}`,
    thirdParty: `${REPOSITORY_FILES}/THIRD_PARTY_NOTICES.md`,
  } as const;
}
