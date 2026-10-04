// 构建之前就要跑的脚本（pnpm start、install:m1、uninstall:m1）的语言判定与消息表（中英双语 S8）。
// 这些脚本不能依赖构建产物，所以不引 @suduo/client-contracts，只用 Node 内置能力按同一规则各写一份。
import { en } from "./messages/en.mjs";
import { zhCN } from "./messages/zh-CN.mjs";

const MESSAGES = { "zh-CN": zhCN, en };

/**
 * 命令行与启动输出的语言，与 client/contracts/src/i18n.ts 的 `cliLocale` 同一规则（改一处必须改另一处，
 * server/test/script-i18n.test.ts 逐条比对两者）：
 * `SUDUO_LOCALE`（zh-CN / en，显式指定）→ `LC_ALL` → `LC_MESSAGES` → `LANG`（第一个非空的说了算；
 * 以 zh 开头为中文，`C` / `POSIX` 与其它为英文）→ 都没设时看系统区域（Windows 一般不设 LANG）→ 还取不到为英文。
 * @param {Readonly<Record<string, string | undefined>>} env 一般传 `process.env`
 * @param {() => string | undefined} [systemLocale]
 * @returns {"zh-CN" | "en"}
 */
export function cliLocale(env, systemLocale = defaultSystemLocale) {
  const explicit = env["SUDUO_LOCALE"];
  if (explicit === "zh-CN" || explicit === "en") return explicit;
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = env[name]?.trim();
    if (value) return localeFromTag(value.split(".")[0]) ?? "en";
  }
  return localeFromTag(systemLocale()) ?? "en";
}

/** 按语言取消息表；用法 `const t = scriptMessages(cliLocale(process.env)).start`。 */
export function scriptMessages(locale) {
  return MESSAGES[locale] ?? en;
}

function defaultSystemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/** 同 cloud/contracts/src/i18n.ts 的 `localeFromTag`：以 zh 开头的取 zh-CN，其余取 en；空值返回 null。 */
function localeFromTag(tag) {
  const value = tag?.trim().toLowerCase();
  if (!value) return null;
  return value === "zh" || value.startsWith("zh-") || value.startsWith("zh_") ? "zh-CN" : "en";
}
