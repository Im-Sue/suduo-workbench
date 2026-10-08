// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createRequirement: vi.fn(),
  createRequirementsProjectSession: vi.fn(),
  createRequirementsSession: vi.fn(),
  inspectLocalDir: vi.fn(),
  listLocalDirs: vi.fn(),
  listRequirementsMappings: vi.fn(),
  listRequirementsSessions: vi.fn(),
  listUsers: vi.fn(),
  requirementsSettings: vi.fn(),
  saveRequirementsMapping: vi.fn(),
  testRequirementsSettings: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  REQUIREMENT_ATTACHMENT_MAX_BYTES: 314_572_800,
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

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));

const { ApiClientError } = await import("../src/api/client.js");
const { StartSessionDialog } = await import("../src/features/requirements/components/StartSessionDialog.js");
const { CreateRequirementDialog } = await import("../src/features/requirements/components/CreateRequirementDialog.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix 的开关用 ResizeObserver 量尺寸；jsdom 没有。
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const session = (id: string, title = "会话") => ({
  id,
  projectId: "local-1",
  title,
  state: "active",
  purpose: "general",
  approvalMode: "on-request",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 3,
  version: 1,
  threads: [],
});
const mapping = { remoteProjectId: "p1", localProjectId: "local-1", rootPath: "/code/p1", localProjectName: "p1", lastValidatedAt: 1 };

async function render(view: ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<StrictMode><QueryClientProvider client={client}>{view}</QueryClientProvider></StrictMode>));
  await settle();
}

async function settle(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const button = (name: string) =>
  Array.from(document.body.querySelectorAll("button")).find((element) => element.textContent?.trim() === name);

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [mapping] });
  apiMocks.listRequirementsSessions.mockResolvedValue({ items: [] });
  apiMocks.createRequirementsSession.mockResolvedValue(session("s-new", "新会话"));
  apiMocks.createRequirementsProjectSession.mockResolvedValue(session("s-project"));
  apiMocks.listLocalDirs.mockResolvedValue({ path: "/Users/me", parent: "/Users", home: "/Users/me", entries: [], truncated: false, recent: [] });
  apiMocks.inspectLocalDir.mockResolvedValue({ path: "/code/p1", exists: true, isDirectory: true, readable: true, writable: true, isGitRepo: true, branch: "main" });
  apiMocks.saveRequirementsMapping.mockResolvedValue(mapping);
  // 缺省：没配云端，云端功能（优先级）一律不显示。
  apiMocks.requirementsSettings.mockResolvedValue({ configured: false });
  apiMocks.listUsers.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("开始会话对话框", () => {
  it("已关联目录、需求还没有会话：直接准备并就绪，StrictMode 下也只建一个会话", async () => {
    const onReady = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "requirement", remoteProjectId: "p1", requirementId: "r1" }}
        subject="REQ-6 订单导出"
        onClose={() => undefined}
        onReady={onReady}
      />,
    );
    expect(apiMocks.createRequirementsSession).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" }), false);
  });

  it("需求已有会话：先问「继续 / 新开」，选继续不会新建", async () => {
    apiMocks.listRequirementsSessions.mockResolvedValue({
      items: [
        { session: session("s-old", "拆分导出任务"), requirement: { remoteRequirementId: "r1", requirementVersion: 1, createdAt: 1 } },
        { session: session("s-other"), requirement: { remoteRequirementId: "r2", requirementVersion: 1, createdAt: 1 } },
      ],
    });
    const onReady = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "requirement", remoteProjectId: "p1", requirementId: "r1" }}
        subject="REQ-6"
        onClose={() => undefined}
        onReady={onReady}
      />,
    );
    expect(document.body.textContent).toContain("这个需求已经有 1 个本机会话");
    await act(async () => Array.from(document.body.querySelectorAll("button")).find((element) => element.textContent?.includes("拆分导出任务"))?.click());
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: "s-old" }), false);
    expect(apiMocks.createRequirementsSession).not.toHaveBeenCalled();
  });

  it("未关联目录：先选目录，保存后继续准备", async () => {
    apiMocks.listRequirementsMappings.mockResolvedValueOnce({ items: [] });
    const onReady = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={() => undefined}
        onReady={onReady}
      />,
    );
    expect(document.body.textContent).toContain("选择本机代码目录");
    await act(async () => button("手动输入路径")?.click());
    const input = document.body.querySelector<HTMLInputElement>("#directory-manual");
    await act(async () => typeInto(input!, "/code/p1"));
    await settle();
    expect(document.body.textContent).toContain("可以读写 · 是 Git 仓库 · 当前分支 main");
    await act(async () => button("使用这个目录")?.click());
    await settle();
    expect(apiMocks.saveRequirementsMapping).toHaveBeenCalledWith("p1", "/code/p1");
    expect(apiMocks.createRequirementsProjectSession).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: "s-project" }), false);
  });

  it("检查中关掉对话框：不会在后台继续建会话", async () => {
    let resolveMappings: (value: unknown) => void = () => undefined;
    apiMocks.listRequirementsMappings.mockReturnValueOnce(new Promise((resolve) => (resolveMappings = resolve)));
    const onClose = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={onClose}
        onReady={() => undefined}
      />,
    );
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click());
    expect(onClose).toHaveBeenCalled();
    await act(async () => resolveMappings({ items: [mapping] }));
    await settle();
    expect(apiMocks.createRequirementsProjectSession).not.toHaveBeenCalled();
  });

  it("准备失败停在失败步骤，重试成功后进入", async () => {
    apiMocks.createRequirementsProjectSession.mockRejectedValueOnce(new ApiClientError(503, "UPSTREAM_UNAVAILABLE", "需求服务暂时不可用"));
    const onReady = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={() => undefined}
        onReady={onReady}
      />,
    );
    expect(document.body.querySelector('[data-testid="region-error"]')?.textContent).toContain("没能开始会话");
    await act(async () => button("重试")?.click());
    await settle();
    expect(apiMocks.createRequirementsProjectSession).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: "s-project" }), false);
  });

  it("目录关联已失效：回到选目录并说明原因", async () => {
    apiMocks.createRequirementsProjectSession.mockRejectedValueOnce(
      new ApiClientError(409, "WORKSPACE_MAPPING_REQUIRED", "本机工作目录映射已失效，请重新配置"),
    );
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={() => undefined}
        onReady={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("这个项目在本机的代码目录关联已失效。请重新选择。");
    expect(document.body.textContent).not.toContain("映射");
  });

  it("关联的目录已被删除：检查时就回到选目录，不先去建会话", async () => {
    apiMocks.inspectLocalDir.mockResolvedValueOnce({ path: "/code/p1", exists: false, isDirectory: false, readable: false, writable: false, isGitRepo: false, branch: null });
    await render(
      <StartSessionDialog
        request={{ kind: "requirement", remoteProjectId: "p1", requirementId: "r1" }}
        subject="REQ-6"
        onClose={() => undefined}
        onReady={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("之前关联的目录 /code/p1 已经不存在了");
    expect(apiMocks.listRequirementsSessions).not.toHaveBeenCalled();
    expect(apiMocks.createRequirementsSession).not.toHaveBeenCalled();
  });

  it("建会话时目录校验不通过（目录刚失去权限）：回到选目录，而不是停在重试无效的失败页", async () => {
    apiMocks.createRequirementsProjectSession.mockRejectedValueOnce(
      new ApiClientError(400, "VALIDATION_ERROR", "rootPath 必须是存在且具备读取、写入与执行权限的本机目录"),
    );
    apiMocks.inspectLocalDir
      .mockResolvedValueOnce({ path: "/code/p1", exists: true, isDirectory: true, readable: true, writable: true, isGitRepo: true, branch: "main" })
      .mockResolvedValueOnce({ path: "/code/p1", exists: true, isDirectory: true, readable: true, writable: false, isGitRepo: true, branch: "main" });
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={() => undefined}
        onReady={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("SuDuo 读写不了之前关联的目录 /code/p1");
    expect(document.body.textContent).not.toContain("rootPath");
  });

  it("目录复查期间转到后台：仍告知失败并撤掉「后台准备中」，不会永久卡住", async () => {
    apiMocks.createRequirementsProjectSession.mockRejectedValueOnce(
      new ApiClientError(400, "VALIDATION_ERROR", "rootPath 必须是存在且具备读取、写入与执行权限的本机目录"),
    );
    let resolveInspect: (value: unknown) => void = () => undefined;
    apiMocks.inspectLocalDir
      .mockResolvedValueOnce({ path: "/code/p1", exists: true, isDirectory: true, readable: true, writable: true, isGitRepo: true, branch: "main" })
      .mockReturnValueOnce(new Promise((resolve) => (resolveInspect = resolve)));
    const onClose = vi.fn();
    const onBackgroundFailed = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={onClose}
        onReady={() => undefined}
        onBackgroundFailed={onBackgroundFailed}
      />,
    );
    await act(async () => button("在后台继续")?.click());
    expect(onClose).toHaveBeenCalledWith(true);
    await act(async () => resolveInspect({ path: "/code/p1", exists: true, isDirectory: true, readable: true, writable: true, isGitRepo: true, branch: "main" }));
    await settle();
    expect(onBackgroundFailed).toHaveBeenCalledTimes(1);
  });

  it("登录过期：放弃这次开始会话，不记成后台准备中", async () => {
    apiMocks.createRequirementsProjectSession.mockRejectedValueOnce(new ApiClientError(401, "AUTH_REQUIRED", "请重新登录"));
    const onClose = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={onClose}
        onReady={() => undefined}
      />,
    );
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("准备中转到后台：onClose 带上 background，失败时另行告知", async () => {
    let rejectCreate: (cause: unknown) => void = () => undefined;
    apiMocks.createRequirementsProjectSession.mockReturnValueOnce(new Promise((_resolve, reject) => (rejectCreate = reject)));
    const onClose = vi.fn();
    const onBackgroundFailed = vi.fn();
    await render(
      <StartSessionDialog
        request={{ kind: "project", remoteProjectId: "p1" }}
        subject="订单中心"
        onClose={onClose}
        onReady={() => undefined}
        onBackgroundFailed={onBackgroundFailed}
      />,
    );
    await act(async () => button("在后台继续")?.click());
    expect(onClose).toHaveBeenCalledWith(true);
    await act(async () => rejectCreate(new ApiClientError(503, "UPSTREAM_UNAVAILABLE", "需求服务暂时不可用")));
    await settle();
    expect(onBackgroundFailed).toHaveBeenCalledTimes(1);
  });
});

describe("新建需求对话框", () => {
  const created = {
    id: "r9",
    projectId: "p1",
    number: 12,
    title: "新需求",
    summary: "",
    status: "in_testing",
    assignee: null,
    commentCount: 0,
    attachmentCount: 0,
    localSessionCount: 0,
    createdBy: { id: "u1", displayName: "陈思远" },
    updatedBy: { id: "u1", displayName: "陈思远" },
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    version: 1,
  };

  it("标题为空时提示必填，不发请求", async () => {
    await render(
      <CreateRequirementDialog
        open
        onOpenChange={() => undefined}
        projectId="p1"
        projectName="订单中心"
        initialStatus="draft"
        currentUser={null}
        onView={() => undefined}
      />,
    );
    await act(async () => button("创建需求⌘⏎")?.click());
    expect(document.body.textContent).toContain("写一个标题，方便大家在看板上认出它");
    expect(apiMocks.createRequirement).not.toHaveBeenCalled();
  });

  it("按入口预填状态、负责人默认自己；⌘⏎ 创建，描述可不填", async () => {
    apiMocks.createRequirement.mockResolvedValue(created);
    const onOpenChange = vi.fn();
    await render(
      <CreateRequirementDialog
        open
        onOpenChange={onOpenChange}
        projectId="p1"
        projectName="订单中心"
        initialStatus="in_testing"
        currentUser={{ id: "u1", displayName: "陈思远" }}
        onView={() => undefined}
      />,
    );
    expect(document.body.querySelector('[aria-label="状态：测试中"]')).not.toBeNull();
    const title = document.body.querySelector<HTMLInputElement>("#new-requirement-title");
    await act(async () => typeInto(title!, "  新需求  "));
    await act(async () => {
      title!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    await settle();
    expect(apiMocks.createRequirement).toHaveBeenCalledWith("p1", { title: "新需求", status: "in_testing", assigneeId: "u1" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 云端没声明支持优先级：不显示优先级。
    expect(document.body.querySelector('[aria-label^="优先级："]')).toBeNull();
  });

  it("云端支持优先级时可选优先级（数字键 1 = 紧急），创建时带上", async () => {
    apiMocks.requirementsSettings.mockResolvedValue({ configured: true, baseUrl: "http://cloud.test" });
    apiMocks.testRequirementsSettings.mockResolvedValue({
      baseUrl: "http://cloud.test",
      reachable: true,
      message: "",
      version: "0.9.0",
      features: ["requirement_priority"],
    });
    apiMocks.createRequirement.mockResolvedValue({ ...created, priority: "urgent" });
    await render(
      <CreateRequirementDialog
        open
        onOpenChange={() => undefined}
        projectId="p1"
        projectName="订单中心"
        initialStatus="draft"
        currentUser={null}
        onView={() => undefined}
      />,
    );
    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="优先级：无优先级，点击修改"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("紧急");
    await act(async () => {
      menu!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    await settle();
    expect(document.body.querySelector('[aria-label="优先级：紧急，点击修改"]')).not.toBeNull();
    const title = document.body.querySelector<HTMLInputElement>("#new-requirement-title");
    await act(async () => typeInto(title!, "紧急需求"));
    await act(async () => {
      title!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    await settle();
    expect(apiMocks.createRequirement).toHaveBeenCalledWith("p1", {
      title: "紧急需求",
      status: "draft",
      assigneeId: null,
      priority: "urgent",
    });
  });
});
