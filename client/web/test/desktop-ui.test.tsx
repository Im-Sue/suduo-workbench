// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DesktopPreferencesDto, DesktopUpdateState, SuDuoDesktopBridge } from "@suduo/client-contracts";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 桌面应用 D2 的界面：「桌面应用」设置分组（只在安装版）、用 ChatGPT 账号登录 Codex、语言告知外壳。 */

const apiMocks = vi.hoisted(() => ({
  codexAccount: vi.fn(),
  startCodexLogin: vi.fn(),
  codexLoginStatus: vi.fn(),
  cancelCodexLogin: vi.fn(),
  codexLogout: vi.fn(),
}));
const ApiClientError = vi.hoisted(
  () =>
    class ApiClientError extends Error {
      constructor(
        readonly status: number,
        readonly code: string,
        message: string,
      ) {
        super(message);
      }
    },
);
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError }));

const { settingsSections } = await import("../src/features/settings/sections.js");
const { DesktopSection } = await import("../src/features/settings/sections/DesktopSection.js");
const { ChatGptAccountRow } = await import("../src/features/settings/sections/ChatGptAccount.js");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { useAttentionSignals } = await import("../src/features/sessions/attention.js");
const { UpdateBanner } = await import("../src/app/shell/UpdateBanner.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>));
  await settle();
}
async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function installBridge(preferences: Omit<DesktopPreferencesDto, "autoCheckUpdates"> & { autoCheckUpdates?: boolean }, update: DesktopUpdateState = { kind: "idle" }): SuDuoDesktopBridge & { calls: unknown[]; push(state: DesktopUpdateState): void } {
  const calls: unknown[] = [];
  let current: DesktopPreferencesDto = { autoCheckUpdates: true, ...preferences };
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  let updateState = update;
  const bridge = {
    calls,
    info: vi.fn(async () => ({ version: "0.11.0", platform: "darwin" as const, arch: "arm64", baseUrl: "http://127.0.0.1:8790/", dataDir: "/d", logDir: "/l" })),
    setLocale: vi.fn((locale: string) => calls.push(["setLocale", locale])),
    getPreferences: vi.fn(async () => current),
    setPreferences: vi.fn(async (patch: Partial<DesktopPreferencesDto>) => {
      calls.push(["setPreferences", patch]);
      current = { ...current, ...patch, openAtLoginStatus: patch.openAtLogin === true ? "requiresApproval" : "disabled" };
      return current;
    }),
    openDirectory: vi.fn(async (kind: string) => {
      calls.push(["openDirectory", kind]);
    }),
    showWindow: vi.fn(() => calls.push(["showWindow"])),
    getUpdateState: vi.fn(async () => updateState),
    checkForUpdates: vi.fn(async () => {
      calls.push(["checkForUpdates"]);
      return updateState;
    }),
    installUpdate: vi.fn(async () => {
      calls.push(["installUpdate"]);
    }),
    onUpdateState: vi.fn((listener: (state: DesktopUpdateState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    push(state: DesktopUpdateState) {
      updateState = state;
      for (const listener of listeners) listener(state);
    },
  };
  (window as unknown as { suDuoDesktop?: unknown }).suDuoDesktop = bridge;
  return bridge;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  delete (window as unknown as { suDuoDesktop?: unknown }).suDuoDesktop;
  vi.clearAllMocks();
});

describe("「桌面应用」设置分组", () => {
  it("浏览器里不列出；安装版里列出", () => {
    expect(settingsSections().map((section) => section.id)).not.toContain("desktop");
    installBridge({ openAtLogin: false, openAtLoginStatus: "disabled" });
    expect(settingsSections().map((section) => section.id)).toContain("desktop");
  });

  it("开机自启开关经桥保存；Mac 要在系统设置里允许时说明；本机地址、版本、打开目录", async () => {
    const bridge = installBridge({ openAtLogin: false, openAtLoginStatus: "disabled" });
    await render(<DesktopSection />);
    expect(q("desktop-address")?.textContent).toBe("http://127.0.0.1:8790/");
    expect(q("desktop-version")?.textContent).toContain("SuDuo 0.11.0");
    await act(async () => q("desktop-open-at-login")?.click());
    await settle();
    expect(bridge.calls).toContainEqual(["setPreferences", { openAtLogin: true }]);
    expect(q("desktop-open-at-login-note")?.textContent).toContain("登录项");
    await act(async () => q("desktop-open-logs")?.click());
    expect(bridge.calls).toContainEqual(["openDirectory", "logs"]);
  });

  it("浏览器里直接打开这个分组：说明只在桌面应用里有", async () => {
    await render(<DesktopSection />);
    expect(document.body.textContent).toContain("只在 SuDuo 桌面应用里有");
  });
});

describe("用 ChatGPT 账号登录 Codex", () => {
  it("没登录：点登录拿到授权地址并在新窗口打开，轮询到成功后刷新状态", async () => {
    apiMocks.codexAccount.mockResolvedValueOnce({ mode: "none", email: null, plan: null, requiresOpenaiAuth: true });
    apiMocks.codexAccount.mockResolvedValue({ mode: "chatgpt", email: "a@b.c", plan: "plus", requiresOpenaiAuth: true });
    apiMocks.startCodexLogin.mockResolvedValue({ loginId: "L1", authUrl: "https://auth.openai.com/x" });
    apiMocks.codexLoginStatus.mockResolvedValue({ status: "succeeded", error: null });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await render(<ChatGptAccountRow />);
      expect(q("model-chatgpt-status")?.textContent).toBe("还没登录");
      await act(async () => q("model-chatgpt-sign-in")?.click());
      await settle();
      expect(open).toHaveBeenCalledWith("https://auth.openai.com/x", "_blank", "noopener,noreferrer");
      expect(q("model-chatgpt-waiting")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(2_100);
      });
      await settle();
      expect(apiMocks.codexLoginStatus).toHaveBeenCalledWith("L1");
      expect(q("model-chatgpt-waiting")).toBeNull();
      expect(q("model-chatgpt-status")?.textContent).toBe("已用 ChatGPT 账号登录：a@b.c（plus）");
    } finally {
      vi.useRealTimers();
      open.mockRestore();
    }
  });

  it("等待中这次登录已经不在了（本机服务重启过）：收起等待；失败原因换成界面文字", async () => {
    apiMocks.codexAccount.mockResolvedValue({ mode: "apiKey", email: null, plan: null, requiresOpenaiAuth: true });
    apiMocks.startCodexLogin.mockResolvedValue({ loginId: "L9", authUrl: "https://auth.openai.com/x" });
    apiMocks.codexLoginStatus.mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "gone"));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await render(<ChatGptAccountRow />);
      expect(q("model-chatgpt")?.textContent).toContain("会替换现在的 API Key 登录");
      await act(async () => q("model-chatgpt-sign-in")?.click());
      await settle();
      expect(q("model-chatgpt-waiting")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(2_100);
      });
      await settle();
      expect(q("model-chatgpt-waiting")).toBeNull();
    } finally {
      vi.useRealTimers();
      open.mockRestore();
    }
  });

  it("已登录可退出；用自定义模型服务时说明 ChatGPT 登录不起作用", async () => {
    apiMocks.codexAccount.mockResolvedValue({ mode: "chatgpt", email: null, plan: null, requiresOpenaiAuth: false });
    apiMocks.codexLogout.mockResolvedValue({ mode: "none", email: null, plan: null, requiresOpenaiAuth: false });
    await render(<ChatGptAccountRow />);
    expect(q("model-chatgpt")?.textContent).toContain("自定义模型服务");
    await act(async () => q("model-chatgpt-sign-out")?.click());
    await settle();
    expect(apiMocks.codexLogout).toHaveBeenCalled();
  });
});

describe("系统通知", () => {
  it("会话在后台等你确认时发通知；点通知请外壳把窗口带到前面", async () => {
    const bridge = installBridge({ openAtLogin: false, openAtLoginStatus: "disabled" });
    window.localStorage.setItem("suduo.notify.system", "on");
    const created: Array<{ title: string; onclick: (() => void) | null; close: () => void }> = [];
    class FakeNotification {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(readonly title: string) {
        created.push(this as never);
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    let setStatus: (status: "running" | "approval") => void = () => undefined;
    function Probe() {
      const [status, set] = useState<"running" | "approval">("running");
      setStatus = set;
      useAttentionSignals(status, "导出订单");
      return null;
    }
    try {
      await render(<Probe />);
      hidden = true;
      await act(async () => setStatus("approval"));
      expect(created).toHaveLength(1);
      created[0]!.onclick?.();
      expect(bridge.calls).toContainEqual(["showWindow"]);
    } finally {
      vi.unstubAllGlobals();
      window.localStorage.removeItem("suduo.notify.system");
    }
  });
});

describe("应用内更新", () => {
  it("有新版本时顶部提示（Mac 写「去下载」、Windows 写「更新」）；点了交给外壳；「稍后」这个版本不再提示", async () => {
    const bridge = installBridge({ openAtLogin: false, openAtLoginStatus: "disabled" }, { kind: "available", version: "1.2.0", notesUrl: "https://x/v1.2.0", canInstall: false });
    window.localStorage.removeItem("suduo.update.dismissed");
    await render(<UpdateBanner />);
    expect(q("update-banner")?.textContent).toContain("SuDuo 1.2.0 可用");
    expect(q("update-install")?.textContent).toBe("去下载");
    await act(async () => q("update-install")?.click());
    expect(bridge.calls).toContainEqual(["installUpdate"]);
    await act(async () => bridge.push({ kind: "available", version: "1.2.0", notesUrl: "https://x/v1.2.0", canInstall: true }));
    expect(q("update-install")?.textContent).toBe("更新");
    await act(async () => q("update-later")?.click());
    expect(q("update-banner")).toBeNull();
    await act(async () => bridge.push({ kind: "available", version: "1.3.0", notesUrl: "https://x/v1.3.0", canInstall: true }));
    expect(q("update-banner")?.textContent).toContain("1.3.0");
    window.localStorage.removeItem("suduo.update.dismissed");
  });

  it("下载中显示进度；下载失败说明原因；浏览器里不出现", async () => {
    const bridge = installBridge({ openAtLogin: false, openAtLoginStatus: "disabled" }, { kind: "downloading", version: "1.2.0", percent: 40 });
    await render(<UpdateBanner />);
    expect(q("update-banner")?.textContent).toContain("40%");
    await act(async () => bridge.push({ kind: "failed", message: "没能更新：disk full" }));
    expect(q("update-banner")?.textContent).toContain("disk full");
    await act(async () => bridge.push({ kind: "available", version: "1.2.0", notesUrl: "https://x/v1.2.0", canInstall: true }));
    expect(q("update-banner")?.textContent).toContain("SuDuo 1.2.0 可用");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    delete (window as unknown as { suDuoDesktop?: unknown }).suDuoDesktop;
    await render(<UpdateBanner />);
    expect(q("update-banner")).toBeNull();
  });

  it("「桌面应用」里：自动检查开关经桥保存；点「检查更新」交给外壳并显示结果", async () => {
    const bridge = installBridge({ openAtLogin: false, openAtLoginStatus: "disabled" });
    await render(<DesktopSection />);
    await act(async () => q("desktop-auto-update")?.click());
    await settle();
    expect(bridge.calls).toContainEqual(["setPreferences", { autoCheckUpdates: false }]);
    await act(async () => q("desktop-check-update")?.click());
    await act(async () => bridge.push({ kind: "upToDate" }));
    expect(bridge.calls).toContainEqual(["checkForUpdates"]);
    expect(q("desktop-update-status")?.textContent).toBe("已是最新版本。");
  });
});
