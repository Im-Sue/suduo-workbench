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

/**
 * 可以使用桥（IPC）的本机服务页面：同源，且不是 /api/ 下的接口响应。
 * 接口里有原样返回项目文件的（例如 /api/v1/projects/:id/files/raw 会以 text/html 返回项目里的 .html），
 * 窗口万一导航过去，那个页面不能拿到桥。
 */
export function isAppPageUrl(url: string, baseUrl: string | null): boolean {
  if (!isAppUrl(url, baseUrl)) return false;
  try {
    return !new URL(url).pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * 外壳自带的启动页（忽略查询串与锚点）。按解码后的路径比较：Chromium 会把 Windows 盘符规范成大写、转义方式也可能与
 * Node 的 pathToFileURL 不同，所以 Windows 上不分大小写；必须是本机文件（host 为空，排除 file://server/share 这类地址）。
 */
export function isStartupUrl(url: string, startupPageUrl: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const target = new URL(url);
    const startup = new URL(startupPageUrl);
    if (target.protocol !== "file:" || target.host !== "" || startup.host !== "") return false;
    const normalize = (pathname: string) => {
      const decoded = decodeURIComponent(pathname).replace(/\\/g, "/");
      return platform === "win32" ? decoded.toLowerCase() : decoded;
    };
    return normalize(target.pathname) === normalize(startup.pathname);
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
