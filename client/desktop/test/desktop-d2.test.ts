import { describe, expect, it } from "vitest";
import { helpUrl } from "../src/main/help.js";
import { applyLoginItem, loginItemStatus, openedAtLogin, type LoginItemHost } from "../src/main/login-item.js";

/** 桌面应用 D2：开机自启（只在安装版改系统登录项，Windows 带 --hidden，Mac 认 wasOpenedAtLogin）与帮助链接。 */

function host(platform: NodeJS.Platform, packaged: boolean, state: { openAtLogin?: boolean; status?: string; wasOpenedAtLogin?: boolean; executableWillLaunchAtLogin?: boolean } = {}) {
  const sets: Array<{ openAtLogin: boolean; args?: string[] }> = [];
  const gets: Array<{ args?: string[] }> = [];
  const value: LoginItemHost & { sets: typeof sets; gets: typeof gets } = {
    platform,
    packaged,
    sets,
    gets,
    get: (options) => {
      gets.push(options);
      return {
        openAtLogin: state.openAtLogin ?? false,
        ...(state.status === undefined ? {} : { status: state.status }),
        ...(state.executableWillLaunchAtLogin === undefined ? {} : { executableWillLaunchAtLogin: state.executableWillLaunchAtLogin }),
        wasOpenedAtLogin: state.wasOpenedAtLogin ?? false,
      };
    },
    set: (settings) => {
      sets.push(settings);
    },
  };
  return value;
}

describe("开机自启", () => {
  it("开发态不改系统登录项，状态为不可用；安装版 Windows 带 --hidden，Mac 不带参数", () => {
    const dev = host("darwin", false);
    applyLoginItem(dev, true);
    expect(dev.sets).toEqual([]);
    expect(loginItemStatus(dev)).toBe("unavailable");
    const win = host("win32", true, { openAtLogin: true });
    applyLoginItem(win, true);
    expect(win.sets).toEqual([{ openAtLogin: true, args: ["--hidden"] }]);
    expect(loginItemStatus(win)).toBe("enabled");
    expect(win.gets).toEqual([{ args: ["--hidden"] }]);
    const mac = host("darwin", true);
    applyLoginItem(mac, false);
    expect(mac.sets).toEqual([{ openAtLogin: false }]);
  });

  it("Mac 的状态按 SMAppService：要在系统设置里允许的单独说明；读不到为 unknown", () => {
    expect(loginItemStatus(host("darwin", true, { status: "enabled" }))).toBe("enabled");
    expect(loginItemStatus(host("darwin", true, { status: "requires-approval" }))).toBe("requiresApproval");
    expect(loginItemStatus(host("darwin", true, { status: "not-registered" }))).toBe("disabled");
    // Windows：在「设置 → 启动应用」里停用后 openAtLogin 还是 true，不会真的启动。
    expect(loginItemStatus(host("win32", true, { openAtLogin: true, executableWillLaunchAtLogin: false }))).toBe("disabled");
    const broken: LoginItemHost = { platform: "darwin", packaged: true, get: () => { throw new Error("x"); }, set: () => undefined };
    expect(loginItemStatus(broken)).toBe("unknown");
  });

  it("开机拉起时不弹窗口：带 --hidden，或 Mac 安装版 wasOpenedAtLogin", () => {
    expect(openedAtLogin(["app", "--hidden"], host("win32", true))).toBe(true);
    expect(openedAtLogin(["app"], host("win32", true))).toBe(false);
    expect(openedAtLogin(["app"], host("darwin", true, { wasOpenedAtLogin: true }))).toBe(true);
    expect(openedAtLogin(["app"], host("darwin", false, { wasOpenedAtLogin: true }))).toBe(false);
  });
});

describe("帮助链接", () => {
  it("官网与使用说明按外壳语言；报告问题指向 GitHub Issues", () => {
    expect(helpUrl("website", "zh-CN")).toBe("https://suduo.dev/zh/");
    expect(helpUrl("website", "en")).toBe("https://suduo.dev/");
    expect(helpUrl("guide", "zh-CN")).toMatch(/client\/README\.zh-CN\.md$/u);
    expect(helpUrl("guide", "en")).toMatch(/client\/README\.md$/u);
    expect(helpUrl("issues", "en")).toBe("https://github.com/Im-Sue/suduo-workbench/issues");
  });
});
