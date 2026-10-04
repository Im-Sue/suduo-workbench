/* global document, window */
/* 首屏主题、密度与语言：在样式表生效前写入根元素，避免闪白/闪黑。
   必须是同源外部脚本（服务端 CSP 为 script-src 'self'，不允许内联）。
   键名与 src/ui/theme.ts、src/ui/density.ts、src/i18n/locale.ts 保持一致。 */
(function () {
  var root = document.documentElement;
  try {
    var pref = localStorage.getItem("suduo.theme");
    // 与 theme.ts 的 v5 迁移一致：旧版自动写入的 "dark" 视为未选择，跟随系统。
    if (localStorage.getItem("suduo.theme.v5") === null && pref === "dark") pref = "system";
    var dark =
      pref === "dark" ||
      (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.setAttribute(
      "data-density",
      localStorage.getItem("suduo.density") === "compact" ? "compact" : "comfortable",
    );
  } catch {
    root.setAttribute("data-theme", "light");
    root.setAttribute("data-density", "comfortable");
  }
  // 界面语言：与 src/i18n/locale.ts 的 resolveUiLocale 一致——固定了就用；「跟随系统」（或没选过、读不到存储）时
  // 浏览器语言以 zh 开头用中文，其他用英文，取不到浏览器语言时用中文。单独 try：主题那段出错也照样写 lang。
  // src/i18n/locale.ts 启动时会再写一次。
  var lang;
  try {
    lang = localStorage.getItem("suduo.locale");
  } catch {
    lang = null;
  }
  if (lang !== "zh-CN" && lang !== "en") {
    var tag;
    try {
      tag = String(navigator.language || "").trim().toLowerCase();
    } catch {
      tag = "";
    }
    lang = tag === "" || tag === "zh" || tag.indexOf("zh-") === 0 || tag.indexOf("zh_") === 0 ? "zh-CN" : "en";
  }
  root.setAttribute("lang", lang);
})();
