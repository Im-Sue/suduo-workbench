/**
 * 桌面外壳自己的文字（菜单、托盘、提示框、启动页与失败页）。中文为样板，英文须同形（test/i18n.test.ts）。
 * 界面里的文字仍在前端字典里；这里只放网页之外、由外壳画出来的部分。
 */
export const zhCN = {
  startup: {
    title: "SuDuo",
    starting: "正在启动本机服务…",
    readingEnvironment: "正在读取终端环境…",
    stopping: "正在停止本机服务…",
    failedTitle: "SuDuo 没能启动",
    logHint: (path: string) => `日志：${path}`,
    retry: "重试",
    openLogs: "打开日志目录",
    runDoctor: "运行自检",
    doctorRunning: "正在自检…",
    reasons: {
      portsBusy: (first: number, last: number) =>
        `端口 ${String(first)}–${String(last)} 都被其他程序占用，本机服务没有可用的端口。关掉占用这些端口的程序后重试。`,
      exited: (detail: string) => `本机服务启动后退出了（${detail}）。`,
      timeout: (seconds: number) => `本机服务在 ${String(seconds)} 秒内没有就绪。`,
      spawnFailed: (message: string) => `没能启动本机服务：${message}`,
      crashedRepeatedly: "本机服务多次意外退出，已停止自动重启。",
      orphanNotStopped: (port: number) => `端口 ${String(port)} 上还有上次留下的 SuDuo 本机服务，没能停掉它。`,
    },
    exitCode: (code: number) => `退出码 ${String(code)}`,
    exitSignal: (signal: string) => `信号 ${signal}`,
  },
  tray: {
    tooltip: "SuDuo",
    open: "打开 SuDuo",
    openInBrowser: "在浏览器中打开",
    quit: "退出 SuDuo",
  },
  menu: {
    about: "关于 SuDuo",
    services: "服务",
    hide: "隐藏 SuDuo",
    hideOthers: "隐藏其他",
    showAll: "全部显示",
    quit: "退出 SuDuo",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "拷贝",
    paste: "粘贴",
    pasteAndMatchStyle: "粘贴并匹配样式",
    selectAll: "全选",
    view: "显示",
    reload: "重新载入",
    toggleDevTools: "开发者工具",
    resetZoom: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    toggleFullScreen: "切换全屏",
    window: "窗口",
    minimize: "最小化",
    zoom: "缩放",
    close: "关闭窗口",
    front: "前置全部窗口",
    openInBrowser: "在浏览器中打开",
  },
  quitConfirm: {
    message: (count: number) => `有 ${String(count)} 个会话正在进行`,
    detail: "退出 SuDuo 会中断它们，进行中的回合不会继续。",
    quit: "退出",
    cancel: "取消",
  },
  backgroundHint: {
    title: "SuDuo 仍在后台运行",
    body: (where: string) => `进行中的会话不会中断，房间里共享的 Agent 继续响应。可以从${where}的图标打开或退出。`,
    whereMac: "菜单栏",
    whereWindows: "任务栏通知区域",
  },
};

export type DesktopMessages = typeof zhCN;
