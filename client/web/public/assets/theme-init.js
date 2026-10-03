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
    // 固定了语言才提前写 lang；「跟随系统」要看界面已支持哪些语言，由 src/i18n/locale.ts 在启动时决定。
    var lang = localStorage.getItem("suduo.locale");
    if (lang === "zh-CN" || lang === "en") root.setAttribute("lang", lang);
  } catch {
    root.setAttribute("data-theme", "light");
    root.setAttribute("data-density", "comfortable");
  }
})();
