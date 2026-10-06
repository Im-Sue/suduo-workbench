// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  listRequirementAttachments: vi.fn(),
  listArtifactVersions: vi.fn(),
  getArtifactVersion: vi.fn(),
  requirementAttachmentDownloadUrl: (id: string) => `/api/v2/attachments/${id}/content`,
  artifactVersionFileDownloadUrl: (versionId: string, fileId: string) => `/api/v2/artifact-versions/${versionId}/files/${fileId}`,
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks, REQUIREMENT_ATTACHMENT_MAX_BYTES: 1_000 }));

const { applyLocalePreference } = await import("../src/i18n/locale.js");
const { MaterialsPreview } = await import("../src/features/requirements/sections/Materials.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 需求抽屉里的「材料」：图片附件可以点开大图预览，PDF 等能预览的在新标签页打开，其余只给下载。
 * 之前抽屉没有接预览，图片只能下载、点文件名也没反应。
 */
const REQ_ID = "0f6b1b3e-0a6d-4c3e-9c2e-3a1c2b4d5e6f";
const SAM = { id: "u2", displayName: "Sam Lee" };
const attachment = (id: string, fileName: string, contentType: string) => ({
  id,
  requirementId: REQ_ID,
  fileName,
  contentType,
  sizeBytes: 2048,
  sha256: id,
  uploadedBy: SAM,
  createdAt: "2026-10-06T01:00:00.000Z",
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    });
  }
}

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>));
  await settle();
  return container;
}

beforeEach(() => {
  applyLocalePreference("zh-CN");
  apiMocks.listRequirementAttachments.mockResolvedValue({
    items: [
      attachment("a1", "下单页截图.png", "image/png"),
      attachment("a2", "接口说明.pdf", "application/pdf"),
      attachment("a3", "原型.sketch", "application/octet-stream"),
    ],
    requirementVersion: 3,
  });
  apiMocks.listArtifactVersions.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("需求抽屉里的材料预览", () => {
  it("点图片的文件名或小眼睛都能打开大图预览", async () => {
    const node = await render(<MaterialsPreview requirementId={REQ_ID} />);
    const name = [...node.querySelectorAll("button")].find((button) => button.textContent === "下单页截图.png");
    expect(name).toBeDefined();
    await act(async () => name?.click());
    await settle();
    const image = document.body.querySelector<HTMLImageElement>("[role='dialog'] img");
    expect(image?.getAttribute("src")).toBe("/api/v2/attachments/a1/content?disposition=inline");
    expect(document.body.querySelector("[role='dialog']")?.textContent).toContain("下单页截图.png");

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>("[role='dialog'] button[data-slot='dialog-close'], [role='dialog'] button[aria-label]")?.click();
    });
    await settle();
    const eye = node.querySelector<HTMLButtonElement>("button[aria-label='预览「下单页截图.png」']");
    expect(eye).not.toBeNull();
    await act(async () => eye?.click());
    await settle();
    expect(document.body.querySelector("[role='dialog'] img")?.getAttribute("src")).toBe("/api/v2/attachments/a1/content?disposition=inline");
  });

  it("PDF 的文件名是新标签页链接；不能预览的文件名只是文字，仍可下载", async () => {
    const node = await render(<MaterialsPreview requirementId={REQ_ID} />);
    const pdf = [...node.querySelectorAll("a")].find((link) => link.textContent === "接口说明.pdf");
    expect(pdf?.getAttribute("href")).toBe("/api/v2/attachments/a2/content?disposition=inline");
    expect(pdf?.getAttribute("target")).toBe("_blank");
    const sketch = [...node.querySelectorAll("span")].find((span) => span.textContent === "原型.sketch");
    expect(sketch).toBeDefined();
    expect([...node.querySelectorAll("button, a")].some((element) => element.textContent === "原型.sketch")).toBe(false);
    expect(node.querySelector("a[aria-label='下载「原型.sketch」']")?.getAttribute("href")).toBe("/api/v2/attachments/a3/content");
  });
});
