/**
 * 许可信息：只展示，不做任何检查（ADR-0011）。
 * 说明文档链接指向公开仓库里的中文版；界面做中英双语时按语言换成英文版。许可证原文只有英文版。
 */
export const LICENSE_NAME = "PolyForm Noncommercial 1.0.0";

const REPOSITORY_FILES = "https://github.com/Im-Sue/suduo-workbench/blob/main";

export const LICENSE_LINKS = {
  /** 许可证原文（英文，具有法律效力）。 */
  license: `${REPOSITORY_FILES}/LICENSE`,
  licenseTranslation: `${REPOSITORY_FILES}/LICENSE.zh-CN.md`,
  commercial: `${REPOSITORY_FILES}/COMMERCIAL.zh-CN.md`,
  thirdParty: `${REPOSITORY_FILES}/THIRD_PARTY_NOTICES.md`,
} as const;
