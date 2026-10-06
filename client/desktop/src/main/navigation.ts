/**
 * 窗口导航与 IPC 的信任判断（技术设计 §三 决策 9、§九「Electron 安全项」）。纯函数，便于测试。
 * 窗口只停留在两类页面：外壳自带的启动页（file://）和本机服务（http://127.0.0.1:<端口>/）。
 */

/** 与本机服务同源（协议、主机、端口都相同）。 */
export function isAppUrl(url: string, baseUrl: string | null): boolean {
  if (baseUrl === null) return false;
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** 外壳自带的启动页（含查询串与锚点）。 */
export function isStartupUrl(url: string, startupPageUrl: string): boolean {
  try {
    const target = new URL(url);
    const startup = new URL(startupPageUrl);
    return target.protocol === "file:" && target.pathname === startup.pathname;
  } catch {
    return false;
  }
}

/** 可以交给系统打开的外部地址：只认网页与邮件，不碰 file:、javascript: 和各种自定义协议。 */
export function isExternalOpenable(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

/** 网页内的权限请求：只放行系统通知与剪贴板写入，其余（摄像头、麦克风、定位等）一律拒绝。 */
export function isAllowedPermission(permission: string): boolean {
  return permission === "notifications" || permission === "clipboard-sanitized-write" || permission === "fullscreen";
}
