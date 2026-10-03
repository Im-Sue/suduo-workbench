// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  runDoctor: vi.fn(),
  openCodexConfigFile: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { LICENSE_LINKS, LICENSE_NAME } from "../src/features/settings/license.js";
import { AboutSection } from "../src/features/settings/sections/AboutSection.js";
import { searchSettings } from "../src/features/settings/sections.js";

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

async function renderAbout(): Promise<HTMLDivElement> {
  apiMocks.runDoctor.mockResolvedValue({ checks: [] });
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
    // 关于分组本来只查自检（读 Codex 版本）；许可行不能引入任何校验或上报。
    expect(apiMocks.runDoctor).toHaveBeenCalledTimes(1);
    expect(apiMocks.openCodexConfigFile).not.toHaveBeenCalled();
  });

  it("设置搜索能找到许可", () => {
    expect(searchSettings("商用").map((item) => item.anchor)).toContain("license");
    expect(searchSettings("license").map((item) => item.anchor)).toContain("license");
  });
});
