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
  testRequirementsSettings: vi.fn(),
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
  uploadCommentFile: vi.fn(),
  createRequirementComment: vi.fn(),
  saveCommentFileAsAttachment: vi.fn(),
  getCommentFile: vi.fn(),
  uploadRequirementAttachment: vi.fn(),
  commentFileUrl: (id: string, disposition?: string) => `/api/v2/comment-files/${id}/content${disposition === "inline" ? "?disposition=inline" : ""}`,
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

const { ApiClientError } = await import("../src/api/client.js");
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

/** 系统代写的发布评论：正文是云端存的英文兜底句，渲染时应按 system 走字典（中文界面也显示中文）。 */
const SYSTEM_COMMENT = {
  id: "c3",
  body: "Published confirmed version 3 with 2 files.",
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
  apiMocks.inspectLocalDir.mockResolvedValue({ exists: true, readable: true, writable: true, isGitRepo: true, branch: "main", linkedRemoteProjectIds: [] });
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
  it("云端支持优先级时，侧栏多一项优先级（默认无优先级）", async () => {
    apiMocks.requirementsSettings.mockResolvedValue({ configured: true, baseUrl: "http://cloud.test", session: { user: ALEX } });
    apiMocks.testRequirementsSettings.mockResolvedValue({
      baseUrl: "http://cloud.test",
      reachable: true,
      message: "",
      version: "0.9.0",
      features: ["requirement_priority"],
    });
    const node = await renderDetail();
    const rail = node.querySelector("aside[aria-label='Requirement properties']");
    expect([...(rail?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent)).toEqual([
      "Status",
      "Priority",
      "Assignee",
      "ID",
      "Created",
      "Updated",
    ]);
    expect(rail?.querySelector("button[aria-label='Priority: No priority, click to change']")).not.toBeNull();
  });

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

  it("附件：最新在前、都能删；没有发布入口；历史确认版收起、只读", async () => {
    const node = await renderDetail();
    const panel = node.querySelector("[data-testid='materials-panel']");
    expect(textOf(panel ?? node, "#materials-heading")).toBe("Attachments");
    const names = [...(panel?.querySelectorAll("ul[aria-label='Attachments'] a[download]") ?? [])].map((link) =>
      link.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Download “notes.pdf”", "Download “spec.pdf”"]);
    expect(panel?.querySelector("button[aria-label='Delete “notes.pdf”']")).not.toBeNull();
    expect(panel?.querySelector("button[aria-label='Delete “spec.pdf”']")).not.toBeNull();
    expect(panel?.textContent).toContain("Drag files here to upload, or paste a screenshot");
    expect([...node.querySelectorAll("button")].some((button) => button.textContent?.includes("Publish"))).toBe(false);

    const history = panel?.querySelector("[data-testid='historical-versions']");
    const toggle = history?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle?.textContent).toBe("Past confirmed versions (1)");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    await settle(2);
    expect(history?.textContent).toContain(
      "Confirmed versions have been retired. Versions published earlier are kept here for viewing and download only.",
    );
    expect(history?.textContent).toContain("Version 2");
    expect(history?.textContent).toContain("Sam Lee published");
    expect(history?.querySelector("a[aria-label='Download “spec.pdf”']")).not.toBeNull();
    expect(history?.querySelector("button[aria-label^='Delete']")).toBeNull();
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

describe("评论带文件（云端支持时）", () => {
  const commentFile = (id: string, fileName: string, contentType: string, kind: "image" | "file") => ({
    id,
    requirementId: REQ_ID,
    commentId: null,
    fileName,
    contentType,
    kind,
    sizeBytes: 4,
    sha256: id,
    uploadedBy: ALEX,
    createdAt: "2026-09-29T12:30:00.000Z",
  });
  const enableCommentFiles = () => {
    apiMocks.requirementsSettings.mockResolvedValue({ configured: true, baseUrl: "http://cloud.test", session: { user: ALEX } });
    apiMocks.testRequirementsSettings.mockResolvedValue({
      baseUrl: "http://cloud.test",
      reachable: true,
      message: "",
      version: "0.9.0",
      features: ["comment_files"],
    });
  };
  const paste = async (target: Element, files: File[]) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files, items: [], types: ["Files"], getData: () => "" } });
    await act(async () => {
      target.dispatchEvent(event);
    });
  };
  const typeInto = (input: HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("粘贴截图只进待发列表、不传成附件；点发送才上传；上传失败不发评论，再发只补传失败的", async () => {
    enableCommentFiles();
    const uploaded = commentFile("cf-1", "Screenshot.png", "image/png", "image");
    apiMocks.uploadCommentFile
      .mockResolvedValueOnce(uploaded)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(commentFile("cf-2", "log.txt", "text/plain", "file"));
    apiMocks.createRequirementComment.mockResolvedValue({ id: "c9", requirementId: REQ_ID, artifactVersionId: null, body: "It breaks", author: ALEX, createdAt: "2026-09-29T13:00:00.000Z", files: [] });
    const node = await renderDetail();
    const composer = node.querySelector<HTMLTextAreaElement>("#comment-composer")!;
    expect([...node.querySelectorAll("button")].some((button) => button.textContent === "Add files")).toBe(true);

    await paste(composer, [new File(["png"], "image.png", { type: "image/png" })]);
    const input = node.querySelector<HTMLInputElement>("[data-testid='comment-composer'] input[type='file']")!;
    Object.defineProperty(input, "files", { value: [new File(["log"], "log.txt", { type: "text/plain" })], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle(2);
    const pending = () => [...node.querySelectorAll("[data-testid='comment-pending-files'] li")];
    expect(pending()).toHaveLength(2);
    expect(pending()[0]?.textContent).toMatch(/^Screenshot-.+\.png/u);
    // 页面级粘贴监听看到评论框已经收下，不再传成附件；选文件时也还没上传。
    expect(apiMocks.uploadRequirementAttachment).not.toHaveBeenCalled();
    expect(apiMocks.uploadCommentFile).not.toHaveBeenCalled();

    await act(async () => typeInto(composer, "It breaks"));
    const send = () => [...node.querySelectorAll("button")].find((button) => button.textContent === "Comment⌘⏎")!;
    await act(async () => send().click());
    await settle(4);
    expect(apiMocks.uploadCommentFile).toHaveBeenCalledTimes(2);
    expect(apiMocks.createRequirementComment).not.toHaveBeenCalled();
    expect(node.textContent).toContain("Some files weren't uploaded, so the comment wasn't sent.");
    expect(pending()[1]?.getAttribute("data-state")).toBe("failed");

    await act(async () => send().click());
    await settle(4);
    expect(apiMocks.uploadCommentFile).toHaveBeenCalledTimes(3);
    expect(apiMocks.uploadCommentFile.mock.calls[2]?.[1]).toBeInstanceOf(File);
    expect((apiMocks.uploadCommentFile.mock.calls[2]?.[1] as File).name).toBe("log.txt");
    expect(apiMocks.createRequirementComment).toHaveBeenCalledWith(REQ_ID, { body: "It breaks", fileIds: ["cf-1", "cf-2"] });
    expect(pending()).toHaveLength(0);
    expect(composer.value).toBe("");
  });

  it("上传途中再加的文件留到下一次；评论其实已发出（响应丢了）时告知并不重复发", async () => {
    enableCommentFiles();
    let finishFirst: (value: unknown) => void = () => undefined;
    apiMocks.uploadCommentFile.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirst = resolve;
    }));
    apiMocks.createRequirementComment.mockResolvedValueOnce({ id: "c9", requirementId: REQ_ID, artifactVersionId: null, body: "first", author: ALEX, createdAt: "2026-09-29T13:00:00.000Z", files: [] });
    const node = await renderDetail();
    const composer = node.querySelector<HTMLTextAreaElement>("#comment-composer")!;
    const pending = () => [...node.querySelectorAll("[data-testid='comment-pending-files'] li")].map((item) => item.textContent ?? "");
    const send = () => [...node.querySelectorAll("button")].find((button) => button.textContent === "Comment⌘⏎")!;
    await paste(composer, [new File(["a"], "a.png", { type: "image/png" })]);
    await act(async () => typeInto(composer, "first"));
    await act(async () => send().click());
    await settle(2);
    // 上传中：输入框只读；这时再粘贴的文件进列表，但不属于这一条。
    expect(composer.readOnly).toBe(true);
    await paste(composer, [new File(["b"], "b.png", { type: "image/png" })]);
    await act(async () => finishFirst(commentFile("cf-a", "a.png", "image/png", "image")));
    await settle(4);
    expect(apiMocks.createRequirementComment).toHaveBeenCalledWith(REQ_ID, { body: "first", fileIds: ["cf-a"] });
    expect(pending()).toHaveLength(1);
    expect(pending()[0]).toMatch(/^b\.png/u);
    expect(composer.readOnly).toBe(false);

    // 第二条：文件传上去了，发评论却被拒；查下来文件已挂在评论上 → 当作已发出，告知、不放回正文。
    apiMocks.uploadCommentFile.mockResolvedValueOnce(commentFile("cf-b", "b.png", "image/png", "image"));
    apiMocks.createRequirementComment.mockRejectedValueOnce(new ApiClientError(400, "VALIDATION_ERROR", "rejected"));
    apiMocks.getCommentFile.mockResolvedValueOnce({ ...commentFile("cf-b", "b.png", "image/png", "image"), commentId: "c10" });
    await act(async () => typeInto(composer, "second"));
    await act(async () => send().click());
    await settle(6);
    expect(apiMocks.getCommentFile).toHaveBeenCalledWith("cf-b");
    expect(node.querySelector("[data-testid='comment-notice']")?.textContent).toBe("That comment was actually sent. Activity has been refreshed.");
    expect(pending()).toHaveLength(0);
    expect(composer.value).toBe("");
  });

  it("评论里的文件：只带文件的评论不留空白气泡；图片缩略、文件卡片；可存为附件", async () => {
    enableCommentFiles();
    apiMocks.listRequirementActivity.mockResolvedValue({
      items: [
        entry({
          id: "a9",
          action: "comment.created",
          resourceType: "comment",
          resourceId: "c9",
          createdAt: "2026-09-29T13:00:00.000Z",
          comment: {
            id: "c9",
            body: "Attached 2 files: shot.png, log.zip",
            system: { kind: "comment_files", params: { fileCount: 2 } },
            files: [
              { ...commentFile("cf-1", "shot.png", "image/png", "image"), commentId: "c9" },
              { ...commentFile("cf-2", "log.zip", "application/zip", "file"), commentId: "c9" },
            ],
          },
        }),
      ],
      nextCursor: null,
    });
    apiMocks.saveCommentFileAsAttachment.mockResolvedValue({ attachment: { id: "att-9" }, requirementVersion: 3 });
    const node = await renderDetail();
    const item = node.querySelector("[data-testid='activity-comment']")!;
    expect(item.textContent).not.toContain("Attached 2 files");
    const files = item.querySelector("[data-testid='comment-files']")!;
    expect(files.querySelector("img")?.getAttribute("src")).toBe("/api/v2/comment-files/cf-1/content?disposition=inline");
    expect(files.querySelector("[data-testid='room-file-card']")?.textContent).toContain("log.zip");
    const save = files.querySelector<HTMLButtonElement>("button[aria-label='Save “log.zip” as an attachment']")!;
    await act(async () => save.click());
    await settle(2);
    expect(apiMocks.saveCommentFileAsAttachment).toHaveBeenCalledWith("cf-2");
  });
});

describe("中文界面照旧", () => {
  it("侧栏字段名、附件区与描述编辑提示", async () => {
    applyLocalePreference("zh-CN");
    const node = await renderDetail();
    const rail = node.querySelector("aside[aria-label='需求属性']");
    expect([...(rail?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent)).toEqual(["状态", "负责人", "编号", "创建", "更新"]);
    expect(rail?.querySelector("button[aria-label='负责人：未指派，点击修改']")).not.toBeNull();
    expect(rail?.textContent).toContain("可以读写 · 分支 main");
    expect(textOf(node, "#materials-heading")).toBe("附件");
    const history = node.querySelector("[data-testid='historical-versions']");
    const toggle = history?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle?.textContent).toBe("历史确认版（1）");
    await act(async () => toggle?.click());
    await settle(2);
    expect(history?.textContent).toMatch(/第 2 版Sam Lee 发布于 /);
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
