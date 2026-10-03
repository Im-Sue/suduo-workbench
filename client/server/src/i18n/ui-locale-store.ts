import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isLocale, type Locale } from "@suduo/client-contracts";

/**
 * 前端最近一次使用的界面语言（本机服务从请求头记下）。单独存一个小文件，不碰 settings.json：
 * 它在请求路径上被动写入，不能因为 settings.json 被手改坏、读成默认值，就顺手把用户的设置覆盖掉。
 * 写入先写临时文件再改名；写不进去只记日志，不影响请求本身。
 */
export class UiLocaleStore {
  private value: Locale | null;

  constructor(private readonly filePath: string) {
    this.value = readStoredLocale(filePath);
  }

  locale(): Locale | null {
    return this.value;
  }

  rememberLocale(locale: Locale): void {
    if (this.value === locale) return;
    this.value = locale;
    const temporary = `${this.filePath}.${String(process.pid)}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ locale }), { mode: 0o600 });
      renameSync(temporary, this.filePath);
    } catch (error) {
      console.warn(JSON.stringify({
        event: "settings.ui_locale_write_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

/** 设置文件旁边的语言文件：settings.json → settings.locale.json。 */
export function uiLocalePathFor(settingsFile: string): string {
  return settingsFile.replace(/\.json$/i, "") + ".locale.json";
}

function readStoredLocale(filePath: string): Locale | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { locale?: unknown };
    return isLocale(parsed.locale) ? parsed.locale : null;
  } catch {
    return null;
  }
}
