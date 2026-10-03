/**
 * 客户端侧的语言约定（中英双语技术设计 §4.1）。语言类型与解析在 `@suduo/cloud-contracts`，这里重新导出，
 * 再加上只在本机前后端之间用到的常量。
 */
export {
  LOCALES,
  LOCALE_PREFERENCES,
  isLocale,
  isLocalePreference,
  localeFromAcceptLanguage,
  localeFromTag,
  plural,
  resolveLocale,
} from "@suduo/cloud-contracts";
export type { Locale, LocalePreference, PluralForms } from "@suduo/cloud-contracts";

/** 前端发往本机服务的每个请求都带上界面语言，本机服务按它生成错误与提示。 */
export const LOCALE_HEADER = "X-SuDuo-Locale";

/**
 * git 检查点的提交说明末尾加一行标记（git trailer），识别检查点只看这一行，不看会随语言变化的标题。
 * turn-start = 回合开始前自动存档；manual = 手动检查点（含还原时生成的那两次提交）。
 */
export const CHECKPOINT_TRAILER = "SuDuo-Checkpoint";
export const CHECKPOINT_KINDS = ["turn-start", "manual"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

/**
 * 加标记行之前写下的检查点只能靠中文标题前缀识别。这两条是旧数据兼容常量，不是界面文字，不要翻译。
 */
// eslint-disable-next-line no-restricted-syntax -- 旧数据兼容：识别 0.7 及以前写下的自动存档标题
export const LEGACY_CHECKPOINT_AUTO_SUBJECT = "SuDuo 自动存档：回合开始前";
// eslint-disable-next-line no-restricted-syntax -- 旧数据兼容：识别 0.7 及以前写下的手动检查点标题前缀
export const LEGACY_CHECKPOINT_MANUAL_PREFIX = "SuDuo 检查点：";
