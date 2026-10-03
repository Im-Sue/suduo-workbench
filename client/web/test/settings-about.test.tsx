// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  runDoctor: vi.fn(),
  openCodexConfigFile: vi.fn(),
  requirementsSettings: vi.fn(),
  testRequirementsSettings: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { LICENSE_LINKS, LICENSE_NAME } from "../src/features/settings/license.js";
import { AboutSection } from "../src/features/settings/sections/AboutSection.js";
import { searchSettings } from "../src/features/settings/sections.js";
import { compareWithCloud } from "../src/features/settings/version.js";

let root: Root | null = null;
let node: HTMLDivElement | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  node?.remove();
  root = null;
  node = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const NOT_CONFIGURED = { configured: false, baseUrl: null, session: null, mappingCount: 0 };
const CONFIGURED = { configured: true, baseUrl: "http://192.168.1.10:4100", session: null, mappingCount: 0 };

async function renderAbout(settings: object = NOT_CONFIGURED): Promise<HTMLDivElement> {
  apiMocks.runDoctor.mockResolvedValue({ checks: [] });
  apiMocks.requirementsSettings.mockResolvedValue(settings);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AboutSection />
      </QueryClientProvider>,
    ),
  );
  // 云端版本是两段异步查询（先读设置，再探测云端）：等「云端」一格不再是骨架屏。
  await vi.waitFor(() => {
    expect(node?.querySelector('[data-testid="settings-cloud-version"] [data-slot="skeleton"], [data-testid="settings-cloud-version"] .animate-pulse')).toBeNull();
  });
  await act(async () => {});
  return node;
}

describe("设置 · 关于 · 许可", () => {
  it("展示许可证与说明外链（新标签页打开，读屏能听到提示），并说明企业 30 天内登记", async () => {
    const container = await renderAbout();
    const license = container.querySelector('[data-testid="settings-license"]');
    expect(license).not.toBeNull();

    const links = [...(license?.querySelectorAll("a") ?? [])].map((link) => ({
      text: link.textContent,
      href: link.getAttribute("href"),
      target: link.getAttribute("target"),
      rel: link.getAttribute("rel"),
    }));
    const newTab = "（在新标签页打开）";
    expect(links).toEqual([
      { text: LICENSE_NAME + newTab, href: LICENSE_LINKS.license, target: "_blank", rel: "noreferrer" },
      { text: "中文参考译文" + newTab, href: LICENSE_LINKS.licenseTranslation, target: "_blank", rel: "noreferrer" },
      { text: "查看登记说明" + newTab, href: LICENSE_LINKS.commercial, target: "_blank", rel: "noreferrer" },
      { text: "查看许可清单" + newTab, href: LICENSE_LINKS.thirdParty, target: "_blank", rel: "noreferrer" },
    ]);
    // 许可证名称指向具有法律效力的英文原文，而不是参考译文。
    expect(LICENSE_LINKS.license.endsWith("/LICENSE")).toBe(true);
    expect(container.textContent).toContain("企业使用请在开始使用后 30 天内登记");
  });

  it("只是展示：渲染许可信息不会发出额外请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await renderAbout();
    expect(fetchSpy).not.toHaveBeenCalled();
    // 关于分组只查自检（Codex 版本）与需求服务设置；许可行不能引入任何校验或上报。
    expect(apiMocks.runDoctor).toHaveBeenCalledTimes(1);
    expect(apiMocks.openCodexConfigFile).not.toHaveBeenCalled();
    // 没配置需求服务时不去探测云端。
    expect(apiMocks.testRequirementsSettings).not.toHaveBeenCalled();
  });

  it("云端版本与本机不同：显示云端版本并提示使用相同版本", async () => {
    // 本机版本由 vite 构建时的 define 注入；vitest 配置里没有 define，所以这里能用全局变量模拟。
    // 若以后在 vitest 配置里加上 define，这几个用例需要改用别的方式注入。
    vi.stubGlobal("__SUDUO_VERSION__", "0.7.0");
    apiMocks.testRequirementsSettings.mockResolvedValue({ baseUrl: CONFIGURED.baseUrl, reachable: true, message: "ok", version: "0.6.5" });
    const container = await renderAbout(CONFIGURED);
    expect(apiMocks.testRequirementsSettings).toHaveBeenCalledWith(CONFIGURED.baseUrl);
    expect(container.querySelector('[data-testid="settings-cloud-version"]')?.textContent).toBe("0.6.5");
    expect(container.querySelector('[data-testid="settings-version-mismatch"]')?.textContent).toContain("本机 0.7.0 与云端 0.6.5 版本不同");
  });

  it("版本相同不提示；较早的云端不报告版本时显示未知", async () => {
    vi.stubGlobal("__SUDUO_VERSION__", "0.7.0");
    apiMocks.testRequirementsSettings.mockResolvedValue({ baseUrl: CONFIGURED.baseUrl, reachable: true, message: "ok", version: "0.7.0" });
    let container = await renderAbout(CONFIGURED);
    expect(container.querySelector('[data-testid="settings-version-mismatch"]')).toBeNull();
    await act(async () => root?.unmount());
    node?.remove();
    root = null;

    apiMocks.testRequirementsSettings.mockResolvedValue({ baseUrl: CONFIGURED.baseUrl, reachable: true, message: "ok", version: null });
    container = await renderAbout(CONFIGURED);
    expect(container.querySelector('[data-testid="settings-cloud-version"]')?.textContent).toContain("未知");
    expect(container.querySelector('[data-testid="settings-version-mismatch"]')).toBeNull();
  });

  it("版本比对：任一方未知时不下结论", () => {
    expect(compareWithCloud("0.7.0", "0.7.0")).toBe("same");
    expect(compareWithCloud("0.7.0", "0.6.5")).toBe("different");
    expect(compareWithCloud(null, "0.6.5")).toBe("unknown");
    expect(compareWithCloud("0.7.0", null)).toBe("unknown");
    expect(compareWithCloud("0.7.0", "dev")).toBe("unknown");
  });

  it("云端连不上时显示「连不上」，不提示版本差异", async () => {
    vi.stubGlobal("__SUDUO_VERSION__", "0.7.0");
    apiMocks.testRequirementsSettings.mockRejectedValue(new Error("connection refused"));
    const container = await renderAbout(CONFIGURED);
    expect(container.querySelector('[data-testid="settings-cloud-version"]')?.textContent).toBe("连不上");
    expect(container.querySelector('[data-testid="settings-version-mismatch"]')).toBeNull();
  });

  it("设置搜索能找到许可", () => {
    expect(searchSettings("商用").map((item) => item.anchor)).toContain("license");
    expect(searchSettings("license").map((item) => item.anchor)).toContain("license");
  });
});
