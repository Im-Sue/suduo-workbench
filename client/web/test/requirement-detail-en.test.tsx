// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import type { CommentDto, RequirementActivityEntryDto } from "@suduo/cloud-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  requirementsSettings: vi.fn(),
  getRequirementByNumber: vi.fn(),
  getRequirement: vi.fn(),
  listRequirementAttachments: vi.fn(),
  listArtifactVersions: vi.fn(),
  getArtifactVersion: vi.fn(),
  listRequirementActivity: vi.fn(),
  listRequirementsSessions: vi.fn(),
  listRequirementsMappings: vi.fn(),
  inspectLocalDir: vi.fn(),
  markRequirementRead: vi.fn(),
  listUsers: vi.fn(),
  requirementAttachmentDownloadUrl: (id: string) => `/api/v2/attachments/${id}/content`,
  artifactVersionFileDownloadUrl: (versionId: string, fileId: string) => `/api/v2/artifact-versions/${versionId}/files/${fileId}`,
}));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  REQUIREMENT_ATTACHMENT_MAX_BYTES: 1_000,
  ApiClientError: class ApiClientError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
// 开始会话与需求讨论区各有自己的测试，这里只看详情页本身的文字。
vi.mock("../src/app/shell/SessionLauncher.js", () => ({ useSessionLauncher: () => ({ launch: vi.fn() }) }));
vi.mock("../src/features/rooms/sections/RequirementRooms.js", () => ({ RequirementRooms: () => null }));

const { applyLocalePreference } = await import("../src/i18n/locale.js");
const { RequirementDetailPage } = await import("../src/features/requirements/RequirementDetailPage.js");
const { ActivityFeed } = await import("../src/features/requirements/sections/ActivityFeed.js");
const { MaterialsPanel } = await import("../src/features/requirements/sections/Materials.js");
const { commentText, presentActivity } = await import("../src/features/requirements/activity.js");
const { enqueueUploads, precheck, resetUploadQueues } = await import("../src/features/requirements/upload-queue.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const REQ_ID = "0f6b1b3e-0a6d-4c3e-9c2e-3a1c2b4d5e6f";
const ALEX = { id: "u1", displayName: "Alex Chen" };
const SAM = { id: "u2", displayName: "Sam Lee" };

const requirement = {
  id: REQ_ID,
  projectId: "proj-1",
  number: 7,
  title: "Checkout redesign",
  summary: "",
  status: "in_development" as const,
  assignee: null,
  commentCount: 2,
  attachmentCount: 2,
  createdBy: ALEX,
  updatedBy: SAM,
  createdAt: "2026-09-29T08:00:00.000Z",
  updatedAt: "2026-09-29T09:00:00.000Z",
  version: 3,
  localSessionCount: 1,
};

const attachment = (id: string, fileName: string, createdAt: string) => ({
  id,
  requirementId: REQ_ID,
  fileName,
  contentType: "application/pdf",
  sizeBytes: 2048,
  sha256: id,
  uploadedBy: SAM,
  createdAt,
});

const VERSION = {
  id: "v2",
  requirementId: REQ_ID,
  versionNumber: 2,
  publishedBy: SAM,
  publishedAt: "2026-09-29T10:00:00.000Z",
  fileCount: 1,
};

function entry(
  patch: Partial<RequirementActivityEntryDto> & Pick<RequirementActivityEntryDto, "id" | "action" | "createdAt">,
): RequirementActivityEntryDto {
  return {
    requirementId: REQ_ID,
    actor: SAM,
    resourceType: "requirement",
    resourceId: REQ_ID,
    changes: [],
    comment: null,
    attachment: null,
    artifactVersion: null,
    ...patch,
  };
}

/** 系统代写的发布评论：正文是云端存的中文兜底句，渲染时应按 system 走字典。 */
const SYSTEM_COMMENT = {
  id: "c3",
  body: "发布了产物 v3，含 2 个文件。",
  system: { kind: "artifact_published", params: { versionNumber: 3, fileCount: 2 } },
} as RequirementActivityEntryDto["comment"];

// 最新在前（与接口一致）。
const ACTIVITY: RequirementActivityEntryDto[] = [
  entry({ id: "a5", action: "comment.created", resourceType: "comment", resourceId: "c3", createdAt: "2026-09-29T12:00:00.000Z", comment: SYSTEM_COMMENT }),
  entry({ id: "a4", action: "comment.created", resourceType: "comment", resourceId: "c2", createdAt: "2026-09-29T11:00:00.000Z", comment: { id: "c2", body: "看起来不错" } }),
  entry({
    id: "a3",
    action: "artifact_version.published",
    resourceType: "artifact_version",
    resourceId: "v2",
    createdAt: "2026-09-29T10:00:00.000Z",
    artifactVersion: { id: "v2", versionNumber: 2, fileCount: 1, note: null },
  }),
  entry({ id: "a2", action: "requirement.status_changed", createdAt: "2026-09-29T09:00:00.000Z", changes: [{ field: "status", from: "draft", to: "in_development" }] }),
  entry({ id: "a1", action: "requirement.created", actor: ALEX, createdAt: "2026-09-29T08:00:00.000Z" }),
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>));
  await settle();
  return container;
}

function DetailRoute() {
  const { projectId, number } = useParams({ strict: false }) as { projectId: string; number: string };
  return <RequirementDetailPage projectId={projectId} numberRef={number} />;
}

async function renderDetail(): Promise<HTMLDivElement> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/p/$projectId/requirements/$number", component: DetailRoute }),
    createRoute({ getParentRoute: () => rootRoute, path: "/p/$projectId/requirements", component: () => <div /> }),
    createRoute({ getParentRoute: () => rootRoute, path: "/sessions/$sessionId", component: () => <div /> }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/p/proj-1/requirements/7"] }) });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  applyLocalePreference("en");
  apiMocks.requirementsSettings.mockResolvedValue({ session: { user: ALEX } });
  apiMocks.getRequirementByNumber.mockResolvedValue(requirement);
  apiMocks.getRequirement.mockResolvedValue(requirement);
  apiMocks.listRequirementAttachments.mockResolvedValue({
    items: [attachment("f1", "spec.pdf", "2026-09-29T09:30:00.000Z"), attachment("f2", "notes.pdf", "2026-09-29T11:30:00.000Z")],
    requirementVersion: 3,
  });
  apiMocks.listArtifactVersions.mockResolvedValue({ items: [VERSION] });
  apiMocks.getArtifactVersion.mockResolvedValue({
    ...VERSION,
    files: [{ id: "vf1", artifactVersionId: "v2", attachmentId: "f1", fileName: "spec.pdf", sizeBytes: 2048, sha256: "f1" }],
  });
  apiMocks.listRequirementActivity.mockResolvedValue({ items: ACTIVITY, nextCursor: null });
  apiMocks.listRequirementsSessions.mockResolvedValue({
    items: [{ session: { id: "s1", title: "", lastActivityAt: null, updatedAt: Date.parse("2026-09-29T11:00:00.000Z") }, requirement: { remoteRequirementId: REQ_ID } }],
  });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [{ remoteProjectId: "proj-1", rootPath: "/Users/alex/code/shop" }] });
  apiMocks.inspectLocalDir.mockResolvedValue({ exists: true, readable: true, writable: true, isGitRepo: true, branch: "main" });
  apiMocks.markRequirementRead.mockResolvedValue(undefined);
  apiMocks.listUsers.mockResolvedValue({ items: [ALEX, SAM] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  resetUploadQueues();
  vi.clearAllMocks();
  applyLocalePreference("system");
  window.localStorage.clear();
});

const textOf = (node: ParentNode, selector: string) => node.querySelector(selector)?.textContent ?? null;

describe("英文界面：需求详情", () => {
  it("页头、侧栏字段名、本机代码目录与本机会话", async () => {
    const node = await renderDetail();
    expect(node.querySelector("[data-testid='start-session']")?.textContent).toBe("Start session");
    expect(node.querySelector("nav")?.getAttribute("aria-label")).toBe("Breadcrumb");
    const rail = node.querySelector("aside[aria-label='Requirement properties']");
    expect([...(rail?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent)).toEqual(["Status", "Assignee", "ID", "Created", "Updated"]);
    expect(rail?.textContent).toContain("Unassigned");
    expect(rail?.querySelector("button[aria-label='Assignee: Unassigned, click to change']")).not.toBeNull();
    expect(rail?.textContent).toContain("Local folder");
    expect(rail?.textContent).toContain("Can read and write · Branch main");
    expect(rail?.textContent).toContain("Local sessions");
    expect(rail?.textContent).toContain("Untitled session");
    const addDescription = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Add a description: background, goals, acceptance criteria… Markdown is supported",
    );
    await act(async () => addDescription?.click());
    const editor = node.querySelector("[data-testid='description-editor']");
    expect(editor?.textContent).toContain("Markdown is supported · ⌘⏎ to save · Esc to discard");
    expect([...(editor?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual(["Discard", "Save"]);
  });

  it("材料与确认版", async () => {
    const node = await renderDetail();
    const panel = node.querySelector("[data-testid='materials-panel']");
    expect(textOf(panel ?? node, "#materials-heading")).toBe("Materials and confirmed versions");
    const version = panel?.querySelector("[data-testid='artifact-version']");
    expect(version?.textContent).toContain("Confirmed version 2");
    expect(version?.textContent).toContain("Sam Lee published");
    expect(panel?.textContent).toContain("Other materials");
    expect(panel?.querySelector("a[aria-label='Download “notes.pdf”']")).not.toBeNull();
    expect(panel?.querySelector("button[aria-label='Delete “notes.pdf”']")).not.toBeNull();
    expect(panel?.textContent).toContain("Drag files here to upload, or paste a screenshot");
  });

  it("发布确认版对话框", async () => {
    const node = await renderDetail();
    const publish = [...node.querySelectorAll("button")].find((button) => button.textContent === "Publish confirmed version");
    expect(publish).toBeDefined();
    await act(async () => publish?.click());
    await settle(2);
    const dialog = document.querySelector("[data-testid='publish-artifact-dialog']");
    expect(dialog?.querySelector("h2")?.textContent).toBe("Publish confirmed version 3");
    expect(dialog?.textContent).toContain("A confirmed version is the set of materials your team has agreed on.");
    // 默认沿用上一版 + 上一版之后新传的：两份都勾上，新传的标「New」。
    expect(dialog?.querySelector("legend")?.textContent).toBe("Included materials (2)");
    expect(dialog?.textContent).toContain("New");
    expect(dialog?.textContent).toContain("What changed in this version");
    expect(dialog?.querySelector("textarea")?.getAttribute("placeholder")).toBe("e.g. Added export limits and retention period");
    const buttons = [...(dialog?.querySelectorAll("button") ?? [])].map((button) => button.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Cancel", "Publish version 3"]));
  });

  it("活动：筛选、动作描述，系统代写的发布评论按当前语言显示", async () => {
    const node = await renderDetail();
    expect(textOf(node, "#activity-heading")).toBe("Activity");
    const filter = node.querySelector("[aria-label='Filter activity']");
    expect([...(filter?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual(["All", "Comments 2", "Changes"]);
    const feed = node.querySelector("ol[aria-label='Activity']");
    expect(feed?.textContent).toContain("Alex Chen created the requirement");
    expect(feed?.textContent).toContain("Sam Lee changed the status");
    expect(feed?.textContent).toContain("Sam Lee published confirmed version 2 (1 file)");
    const comments = [...(feed?.querySelectorAll("[data-testid='activity-comment']") ?? [])].map((item) => item.textContent ?? "");
    expect(comments.some((text) => text.includes("Published confirmed version 3 with 2 files."))).toBe(true);
    expect(comments.some((text) => text.includes("发布了产物"))).toBe(false);
    // 用户写的评论原样显示，不翻译。
    expect(comments.some((text) => text.includes("看起来不错"))).toBe(true);
    expect(node.querySelector("#comment-composer")?.getAttribute("placeholder")).toBe("Write a comment (Markdown is supported)");
  });
});

describe("中文界面照旧", () => {
  it("侧栏字段名、材料区与描述编辑提示", async () => {
    applyLocalePreference("zh-CN");
    const node = await renderDetail();
    const rail = node.querySelector("aside[aria-label='需求属性']");
    expect([...(rail?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent)).toEqual(["状态", "负责人", "编号", "创建", "更新"]);
    expect(rail?.querySelector("button[aria-label='负责人：未指派，点击修改']")).not.toBeNull();
    expect(rail?.textContent).toContain("可以读写 · 分支 main");
    const version = node.querySelector("[data-testid='artifact-version']");
    expect(version?.textContent).toContain("确认版 · 第 2 版");
    expect(version?.textContent).toMatch(/^确认版 · 第 2 版Sam Lee 发布于 /);
    expect(node.textContent).toContain("Sam Lee 发布了确认版 · 第 2 版（1 个文件）");
    const filter = node.querySelector("[aria-label='活动筛选']");
    expect([...(filter?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual(["全部", "评论 2", "变更"]);
    const addDescription = [...node.querySelectorAll("button")].find((button) => button.textContent === "添加描述：背景、目标、验收标准……支持 Markdown");
    await act(async () => addDescription?.click());
    expect(node.querySelector("[data-testid='description-editor']")?.textContent).toContain("支持 Markdown · ⌘⏎ 保存 · Esc 放弃");
  });
});

describe("系统代写的评论", () => {
  const published = (versionNumber: number, fileCount: number): Pick<CommentDto, "body" | "system"> => ({
    body: `发布了产物 v${String(versionNumber)}，含 ${String(fileCount)} 个文件。`,
    system: { kind: "artifact_published", params: { versionNumber, fileCount } },
  });

  it("中文与存下的正文逐字一致；英文按单复数", () => {
    applyLocalePreference("zh-CN");
    expect(commentText(published(3, 2))).toBe("发布了产物 v3，含 2 个文件。");
    applyLocalePreference("en");
    expect(commentText(published(3, 2))).toBe("Published confirmed version 3 with 2 files.");
    expect(commentText(published(1, 1))).toBe("Published confirmed version 1 with 1 file.");
  });

  it("没有 system 的评论照常显示正文", () => {
    expect(commentText({ body: "Looks good" })).toBe("Looks good");
    expect(presentActivity(entry({ id: "x", action: "comment.created", createdAt: "2026-09-29T08:00:00.000Z", comment: { id: "c", body: "好的" } })).body).toBe("好的");
  });

  it("中文时间线里显示中文句子", async () => {
    applyLocalePreference("zh-CN");
    const node = await render(<ActivityFeed requirementId={REQ_ID} mode="timeline" />);
    const comments = [...node.querySelectorAll("[data-testid='activity-comment']")].map((item) => item.textContent ?? "");
    expect(comments.some((text) => text.includes("发布了产物 v3，含 2 个文件。"))).toBe(true);
    expect(node.textContent).toContain("Sam Lee 发布了确认版 · 第 2 版（1 个文件）");
  });
});

describe("英文界面：上传", () => {
  it("预检原因与失败行", async () => {
    expect(precheck(new File(["x".repeat(2_000)], "big.bin"), 10)).toBe("Over 300 MB and can't be uploaded");
    const node = await render(<MaterialsPanel requirementId={REQ_ID} />);
    await act(async () => enqueueUploads(new QueryClient(), REQ_ID, [new File(["x".repeat(2_000)], "big.bin")], 0));
    const row = node.querySelector("[data-testid='upload-row'][data-state='failed']");
    expect(row?.querySelector("[role='alert']")?.textContent).toBe("Over 300 MB and can't be uploaded. Other files aren't affected.");
    expect(row?.querySelector("button[aria-label='Remove “big.bin”']")).not.toBeNull();
  });
});
