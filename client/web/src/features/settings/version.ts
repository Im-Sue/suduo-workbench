declare const __SUDUO_VERSION__: string | undefined;

/** SuDuo 版本号：构建时由 vite 从 client/package.json 注入；开发与测试环境没有注入时显示「开发版」。 */
export function appVersion(): string {
  return typeof __SUDUO_VERSION__ === "string" && __SUDUO_VERSION__ !== "" ? __SUDUO_VERSION__ : "开发版";
}
