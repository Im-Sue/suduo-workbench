import {
  LOCALE_HEADER,
  isLocale,
  localeFromAcceptLanguage,
  type Locale,
} from "@suduo/client-contracts";
import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** 这个请求要用的语言（中英双语技术设计 §4.1）；错误与提示按它生成。 */
    locale: Locale;
  }
}

/** 没有任何线索时的语言：命令行、脚本直接请求本机服务时多半不是中文环境。 */
export const FALLBACK_LOCALE: Locale = "en";

/**
 * 请求语言的回退链：请求头（前端每个请求都带）→ 前端最近一次用过的语言（EventSource 这类带不了头的请求）
 * → Accept-Language → en。
 */
export function resolveRequestLocale(input: {
  header: unknown;
  stored: Locale | null;
  acceptLanguage: unknown;
}): Locale {
  if (isLocale(input.header)) return input.header;
  if (input.stored !== null) return input.stored;
  return localeFromAcceptLanguage(
    typeof input.acceptLanguage === "string" ? input.acceptLanguage : null,
  ) ?? FALLBACK_LOCALE;
}

/**
 * 给每个请求挂上 request.locale；请求头带了合法语言时顺手记下来，后台任务与带不了头的请求就能沿用。
 * 前端因此不用另发「同步语言」的请求：切换语言后的下一个请求就会更新它。
 */
export function registerRequestLocale(
  server: FastifyInstance,
  store: { locale(): Locale | null; rememberLocale(locale: Locale): void },
): void {
  const headerName = LOCALE_HEADER.toLowerCase();
  server.decorateRequest("locale", FALLBACK_LOCALE);
  server.addHook("onRequest", async (request) => {
    const header = request.headers[headerName];
    if (isLocale(header)) {
      try {
        store.rememberLocale(header);
      } catch {
        // 记不下来只影响后台任务的语言，不能让这个请求失败。
      }
    }
    request.locale = resolveRequestLocale({
      header,
      stored: store.locale(),
      acceptLanguage: request.headers["accept-language"],
    });
  });
}
