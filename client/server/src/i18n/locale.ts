import {
  LOCALE_HEADER,
  isLocale,
  localeFromAcceptLanguage,
  type Locale,
} from "@suduo/client-contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** 这个请求要用的语言（中英双语技术设计 §4.1）；错误与提示按它生成。 */
    locale: Locale;
  }
}

/** 没有任何线索时的语言：命令行、脚本直接请求本机服务时多半不是中文环境。 */
export const FALLBACK_LOCALE: Locale = "en";

/**
 * 带不了请求头的请求（浏览器的 EventSource）把界面语言放在地址上：`?locale=zh-CN`。
 * 前端在 web/src/i18n/locale.ts 的 withLocaleParam 里拼，两处的参数名要一致。
 */
export const LOCALE_QUERY_PARAM = "locale";

/**
 * 请求语言的回退链：请求头（前端每个请求都带）→ 地址上的 `?locale=`（EventSource 带不了头）
 * → 前端最近一次用过的语言（两者都没带的请求）→ Accept-Language → en。
 */
export function resolveRequestLocale(input: {
  header: unknown;
  query: unknown;
  stored: Locale | null;
  acceptLanguage: unknown;
}): Locale {
  if (isLocale(input.header)) return input.header;
  if (isLocale(input.query)) return input.query;
  if (input.stored !== null) return input.stored;
  return localeFromAcceptLanguage(
    typeof input.acceptLanguage === "string" ? input.acceptLanguage : null,
  ) ?? FALLBACK_LOCALE;
}

/**
 * 当场按请求解析语言，不记录（错误处理用：LoopbackGuard 等更早的钩子拒绝请求时，request.locale 还没被设置）。
 */
export function requestLocaleOf(
  request: FastifyRequest,
  store: { locale(): Locale | null },
): Locale {
  return resolveRequestLocale({
    header: request.headers[LOCALE_HEADER.toLowerCase()],
    query: queryLocaleOf(request),
    stored: store.locale(),
    acceptLanguage: request.headers["accept-language"],
  });
}

/** 地址上的 `?locale=`；重复给了多个值时不认（不是合法语言）。 */
function queryLocaleOf(request: FastifyRequest): unknown {
  const query: unknown = request.query;
  return typeof query === "object" && query !== null
    ? (query as Record<string, unknown>)[LOCALE_QUERY_PARAM]
    : undefined;
}

/**
 * 给每个请求挂上 request.locale；请求头带了合法语言时顺手记下来，后台任务与两者都没带的请求就能沿用。
 * 前端因此不用另发「同步语言」的请求：切换语言后的下一个请求就会更新它。
 *
 * 地址上的 `?locale=` 只决定这一个请求的语言，不记下来：
 * - 切换语言后前端会马上重取所有查询，请求头已经把新语言记下了，地址参数不会让它更早；
 * - EventSource 的地址在建连接时就定了，断线后浏览器原样重连，记它反而可能把旧语言写回去；
 * - 地址可以手敲、可以被脚本请求，不该顺带改掉后台任务用的语言（与 `/doctor?lang=` 一样只管这一页）。
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
      query: queryLocaleOf(request),
      stored: store.locale(),
      acceptLanguage: request.headers["accept-language"],
    });
  });
}
