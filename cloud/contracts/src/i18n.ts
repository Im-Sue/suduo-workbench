/**
 * 产品语言（中英双语技术设计 §4.1）。云端只出英文与错误码；这里的定义给两端共用，
 * 客户端经 `@suduo/client-contracts` 重新导出，依赖方向仍是客户端 → 云端。
 */
export const LOCALES = ["zh-CN", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/** 界面语言偏好：跟随系统，或固定一种语言。 */
export type LocalePreference = "system" | Locale;

export const LOCALE_PREFERENCES: readonly LocalePreference[] = ["system", ...LOCALES];

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en";
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || isLocale(value);
}

/**
 * 把一个语言标签（navigator.language、Accept-Language 里的一项）归到产品语言：
 * 以 zh 开头的取 zh-CN，其余取 en；空值返回 null，由调用方决定兜底。
 */
export function localeFromTag(tag: string | null | undefined): Locale | null {
  const value = tag?.trim().toLowerCase();
  if (!value) return null;
  return value === "zh" || value.startsWith("zh-") || value.startsWith("zh_") ? "zh-CN" : "en";
}

/**
 * 偏好 → 实际语言。固定语言直接用；跟随系统时按语言标签判断。
 * `available` 是界面已经能用的语言（前端的 `UI_LOCALES`）：跟随系统只会落到这里面的语言，取不到时用第一项。
 */
export function resolveLocale(
  preference: LocalePreference,
  systemTag: string | null | undefined,
  available: readonly Locale[] = LOCALES,
): Locale {
  if (preference !== "system") return preference;
  const fromSystem = localeFromTag(systemTag);
  if (fromSystem !== null && available.includes(fromSystem)) return fromSystem;
  return available[0] ?? "zh-CN";
}

/**
 * 解析 HTTP Accept-Language（如 `en-US,en;q=0.9,zh-CN;q=0.8`），按权重取第一个能归到产品语言的项。
 * `*` 与空头返回 null。
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((item) => item.tag !== "" && item.tag !== "*" && item.weight > 0)
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  for (const item of ranked) {
    const locale = localeFromTag(item.tag);
    if (locale !== null) return locale;
  }
  return null;
}

export interface PluralForms {
  one?: string;
  other: string;
}

/** 单复数：按 Intl.PluralRules 取 one / other；中文只有 other。 */
export function plural(locale: Locale, count: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(locale).select(count);
  return category === "one" && forms.one !== undefined ? forms.one : forms.other;
}
