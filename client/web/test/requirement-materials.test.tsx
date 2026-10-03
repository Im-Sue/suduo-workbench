// @vitest-environment jsdom

import type { SessionContextDto } from "@suduo/client-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getRequirement: vi.fn(),
  listRequirementAttachments: vi.fn(),
  requirementAttachmentDownloadUrl: (id: string) => `/api/v2/attachments/${id}/content`,
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { RequirementMaterials, requirementPageHref, type SessionContextState } from "../src/components/RequirementMaterials.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  await settle();
  return container;
}

const UUID = "0f6b1b3e-0a6d-4c3e-9c2e-3a1c2b4d5e6f";

const requirementContext = (overrides: Partial<SessionContextDto> = {}): SessionContextDto => ({
  sessionId: "s1",
  kind: "requirement",
  contextMode: "tools",
  remoteProjectId: "proj-1",
  requirement: { remoteRequirementId: UUID, number: 7, title: "订单详情优化", startVersion: 2, startedAt: 1 },
  ...overrides,
});

const ready = (value: SessionContextDto): SessionContextState => ({ status: "ready", value });

beforeEach(() => {
  apiMocks.getRequirement.mockResolvedValue({ id: UUID, number: 7, title: "订单详情优化（改）", status: "in_development", version: 4 });
  apiMocks.listRequirementAttachments.mockResolvedValue({
    items: [
      { id: "a1", requirementId: UUID, fileName: "需求问题截图.png", contentType: "image/png", sizeBytes: 921_600, sha256: "x", uploadedBy: { id: "u", displayName: "李娜" }, createdAt: "2026-09-30T01:00:00Z" },
      { id: "a2", requirementId: UUID, fileName: "原型.sketch", contentType: "application/octet-stream", sizeBytes: 2048, sha256: "y", uploadedBy: { id: "u", displayName: "李娜" }, createdAt: "2026-09-30T01:00:00Z" },
    ],
    requirementVersion: 4,
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const q = (node: ParentNode, testId: string) => node.querySelector<HTMLElement>(`[data-testid='${testId}']`);
const qa = (node: ParentNode, testId: string) => [...node.querySelectorAll<HTMLElement>(`[data-testid='${testId}']`)];

describe("会话右栏「需求」标签：需求概要", () => {
  it("显示编号、标题、状态、开工时与现在的版本、附件，以及在需求页打开；不出现「拉取」「已观测」", async () => {
    const onNavigate = vi.fn();
    const node = await render(<RequirementMaterials context={ready(requirementContext())} onRetryContext={vi.fn()} onNavigate={onNavigate} />);
    expect(apiMocks.getRequirement).toHaveBeenCalledWith(UUID);
    expect(apiMocks.listRequirementAttachments).toHaveBeenCalledWith(UUID);
    expect(node.textContent).toContain("REQ-7");
    expect(q(node, "requirement-material-title")?.textContent).toBe("订单详情优化（改）");
    expect(q(node, "requirement-material-status")?.textContent).toBe("开发中");
    expect(q(node, "requirement-material-version")?.textContent).toContain("开工时第 2 版，现在第 4 版");
    expect(q(node, "requirement-material-version")?.textContent).toContain("开工后需求改过");
    const rows = qa(node, "requirement-material-attachment");
    expect(rows).toHaveLength(2);
    // 图片可在线看：点名字在新标签页打开 inline 地址；其它类型点名字下载。
    const image = rows[0]?.querySelector("a");
    expect(image?.getAttribute("href")).toBe("/api/v2/attachments/a1/content?disposition=inline");
    expect(image?.getAttribute("target")).toBe("_blank");
    const other = rows[1]?.querySelector("a");
    expect(other?.getAttribute("href")).toBe("/api/v2/attachments/a2/content");
    expect(other?.hasAttribute("download")).toBe(true);
    expect(rows[0]?.textContent).toContain("900 KB");
    expect(node.textContent).not.toMatch(/拉取|已观测|UUID/);
    expect(node.textContent).not.toContain(UUID);

    const open = q(node, "requirement-material-open") as HTMLAnchorElement | null;
    expect(open?.getAttribute("href")).toBe("/p/proj-1/requirements/7");
    await act(async () => open?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(onNavigate).toHaveBeenCalledWith("/p/proj-1/requirements/7");
  });

  it("附件查询失败：说「查不到：原因」并可重试，不说「没有附件」", async () => {
    apiMocks.listRequirementAttachments.mockRejectedValueOnce(new Error("需求服务连不上"));
    const node = await render(<RequirementMaterials context={ready(requirementContext())} onRetryContext={vi.fn()} onNavigate={vi.fn()} />);
    const error = node.querySelector<HTMLElement>("[data-testid='requirement-material-error'][data-part='attachments']");
    expect(error?.textContent).toContain("查不到附件：");
    expect(node.textContent).not.toContain("没有附件");
    const retry = [...(error?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("重试"));
    await act(async () => retry?.click());
    await settle();
    expect(apiMocks.listRequirementAttachments).toHaveBeenCalledTimes(2);
    expect(qa(node, "requirement-material-attachment")).toHaveLength(2);
  });

  it("需求详情查不到：版本写「查不到」并给重试，标题退回会话记下的标题", async () => {
    apiMocks.getRequirement.mockRejectedValueOnce(new Error("登录过期"));
    const node = await render(<RequirementMaterials context={ready(requirementContext())} onRetryContext={vi.fn()} onNavigate={vi.fn()} />);
    expect(q(node, "requirement-material-title")?.textContent).toBe("订单详情优化");
    expect(q(node, "requirement-material-version")?.textContent).toContain("现在的版本查不到");
    expect(node.querySelector("[data-testid='requirement-material-error'][data-part='detail']")?.textContent).toContain("查不到需求详情：");
    expect(q(node, "requirement-material-status")).toBeNull();
  });

  it("附件确实为空：说「这条需求没有附件」", async () => {
    apiMocks.listRequirementAttachments.mockResolvedValueOnce({ items: [], requirementVersion: 4 });
    const node = await render(<RequirementMaterials context={ready(requirementContext())} onRetryContext={vi.fn()} onNavigate={vi.fn()} />);
    expect(node.textContent).toContain("这条需求没有附件");
  });

  it("会话上下文三态：读取中 / 查不到（可重试）/ 未关联需求", async () => {
    const onRetry = vi.fn();
    const loading = await render(<RequirementMaterials context={{ status: "loading" }} onRetryContext={onRetry} onNavigate={vi.fn()} />);
    expect(loading.textContent).toContain("正在读取关联需求");
    await act(async () => root?.render(<RequirementMaterials context={{ status: "error", message: "本机服务没响应" }} onRetryContext={onRetry} onNavigate={vi.fn()} />));
    expect(container?.textContent).toContain("查不到关联需求：本机服务没响应");
    expect(container?.textContent).not.toContain("未关联");
    const retry = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("重试"));
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () =>
      root?.render(
        <RequirementMaterials
          context={ready({ sessionId: "s1", kind: "project", contextMode: null, remoteProjectId: "proj-1", requirement: null })}
          onRetryContext={onRetry}
          onNavigate={vi.fn()}
        />,
      ),
    );
    expect(q(container as HTMLElement, "requirement-materials")?.getAttribute("data-linked")).toBe("false");
    expect(container?.textContent).toContain("项目会话");
    expect(apiMocks.getRequirement).not.toHaveBeenCalled();
  });
});

describe("需求页地址", () => {
  it("有编号用编号；没有编号用需求 ID；没有远程项目时不给链接", () => {
    expect(requirementPageHref(requirementContext())).toBe("/p/proj-1/requirements/7");
    expect(
      requirementPageHref(requirementContext({ requirement: { remoteRequirementId: UUID, number: null, title: null, startVersion: 1, startedAt: 1 } })),
    ).toBe(`/p/proj-1/requirements/${UUID}`);
    expect(requirementPageHref(requirementContext({ remoteProjectId: null }))).toBeNull();
  });
});
