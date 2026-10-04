export type ScriptLocale = "zh-CN" | "en";

/** 消息表里的一条：固定文字，或按参数生成文字的函数。 */
export type ScriptMessage = string | ((...args: readonly (string | number | null)[]) => string);

export type ScriptMessages = Readonly<Record<string, Readonly<Record<string, ScriptMessage>>>>;

export function cliLocale(
  env: Readonly<Record<string, string | undefined>>,
  systemLocale?: () => string | undefined,
): ScriptLocale;

export function scriptMessages(locale: ScriptLocale): ScriptMessages;
