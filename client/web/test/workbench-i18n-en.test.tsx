// @vitest-environment jsdom

import type { FileContentDto, SessionContextDto, SessionDto } from "@suduo/client-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  uploadAttachment: vi.fn(),
  fileIndex: vi.fn(),
  gitStatus: vi.fn(),
  gitCheckpoints: vi.fn(),
  gitCheckpoint: vi.fn(),
  gitRestore: vi.fn(),
  getRequirement: vi.fn(),
  listRequirementAttachments: vi.fn(),
  requirementAttachmentDownloadUrl: (id: string) => `/api/v2/attachments/${id}/content`,
}));

// 组件用假的接口；上传的本地报错走真实实现（只覆盖组件用到的几个方法）。
vi.mock("../src/api/client.js", async (importOriginal) => {
  const actual = await importOriginal<{ api: Record<string, unknown> }>();
  return { ...actual, api: { ...actual.api, ...apiMocks } };
});

import { api } from "../src/api/client.js";
import { ApprovalModeSwitcher } from "../src/components/ApprovalModeSwitcher.js";
import { ChangesPanel } from "../src/components/ChangesPanel.js";
import { Composer, type ComposerQueue, type ComposerRunState } from "../src/components/Composer.js";
import { Drawer } from "../src/components/Drawer.js";
import { EnvPanel } from "../src/components/EnvPanel.js";
import { OpenMenu } from "../src/components/OpenMenu.js";
import { RequirementMaterials } from "../src/components/RequirementMaterials.js";
import { applyLocalePreference } from "../src/i18n/locale.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return container;
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => root?.render(element));
}

beforeEach(() => {
  applyLocalePreference("en");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  applyLocalePreference("system");
  window.localStorage.clear();
});

const q = (node: ParentNode, testId: string) => node.querySelector<HTMLElement>(`[data-testid='${testId}']`);

/** Radix 下拉用键盘打开（jsdom 里没有指针事件的完整实现）。 */
async function openMenu(trigger: HTMLElement | null): Promise<void> {
  await act(async () => {
    trigger?.focus();
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

function queueView(overrides: Partial<ComposerQueue> = {}): ComposerQueue {
  return {
    items: [],
    status: "idle",
    pausedReason: null,
    onEnqueue: vi.fn(),
    onRemove: vi.fn(),
    onUpdate: vi.fn(),
    onTake: vi.fn(() => null),
    onResume: vi.fn(),
    ...overrides,
  };
}

function runState(overrides: Partial<ComposerRunState> = {}): ComposerRunState {
  return {
    status: "running",
    stepText: null,
    elapsedMs: null,
    pendingApprovals: 0,
    stopping: false,
    onStop: () => undefined,
    onJumpToApproval: () => undefined,
    ...overrides,
  };
}

function composer(input: { runState?: ComposerRunState; queue?: ComposerQueue } = {}) {
  return (
    <Composer
      disabled={false}
      projectId="p1"
      projectRoot="/repo"
      sessionId="s1"
      skills={[]}
      skillPath=""
      onSkillPath={() => undefined}
      onError={() => undefined}
      usage={{ usedTokens: 50_000, contextWindow: 200_000, totalTokens: 50_000 }}
      {...(input.runState === undefined ? {} : { runState: input.runState })}
      {...(input.queue === undefined ? {} : { queue: input.queue })}
    />
  );
}

describe("英文界面：会话输入框", () => {
  it("空闲时：占位、发送、图片按钮与上下文用量", async () => {
    const node = await render(composer());
    const textarea = q(node, "message-input") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Describe the work for Codex. Type / for a Skill, @ to reference a file");
    expect(node.querySelector("label.sr-only")?.textContent).toBe("Message to Codex");
    expect(q(node, "send-message")?.getAttribute("aria-label")).toBe("Send");
    expect(q(node, "send-message")?.title).toBe("Send (Enter)");
    expect(q(node, "attach-image")?.textContent).toBe("Image");
    expect(q(node, "context-ring")?.title).toBe(
      "25% of context used (50k / 200k). Codex automatically compacts earlier conversation as it nears the limit.",
    );
  });

  it("运行中：状态行、停止与排队；等你确认时按条数说", async () => {
    const node = await render(composer({ runState: runState(), queue: queueView() }));
    expect((q(node, "message-input") as HTMLTextAreaElement).placeholder).toBe(
      "Codex is working: Enter adds to this turn, Tab queues for later",
    );
    expect(q(node, "run-status-line")?.textContent).toContain("Codex is working");
    expect(q(node, "run-status-step")?.textContent).toBe("Running");
    expect(q(node, "queue-message")?.textContent).toBe("Queue");
    expect(q(node, "interrupt-turn")?.textContent).toBe("Stop");
    expect(q(node, "interrupt-turn")?.getAttribute("aria-label")).toBe("Stop this turn");

    await rerender(composer({ runState: runState({ stopping: true }), queue: queueView() }));
    expect(q(node, "interrupt-turn")?.textContent).toBe("Stopping…");

    await rerender(composer({ runState: runState({ status: "approval", pendingApprovals: 1 }), queue: queueView() }));
    expect(q(node, "run-status-line")?.textContent).toContain("Waiting for you · 1 approval");
    expect(q(node, "run-status-approval-link")?.textContent).toBe("Review");
    await rerender(composer({ runState: runState({ status: "approval", pendingApprovals: 2 }), queue: queueView() }));
    expect(q(node, "run-status-line")?.textContent).toContain("Waiting for you · 2 approvals");
  });

  it("排队面板：标题、暂停原因、各项操作", async () => {
    const queue = queueView({
      items: [{ id: "a", text: "", attachmentIds: [], unconfirmed: true }],
      status: "paused",
      pausedReason: "send_uncertain",
    });
    const node = await render(composer({ runState: runState(), queue }));
    const panel = q(node, "queue-panel");
    expect(panel?.querySelector("b")?.textContent).toBe("Queue 1");
    expect(panel?.textContent).toContain("This tab only");
    expect(q(node, "queue-paused")?.textContent).toContain("Paused · Not sure whether this message was sent");
    expect(q(node, "queue-resume")?.textContent).toBe("Resume");
    const item = q(node, "queue-item");
    expect(item?.textContent).toContain("Unconfirmed");
    expect(item?.textContent).toContain("(No text)");
    expect(q(node, "queue-item-edit")?.textContent).toBe("Edit");
    expect(q(node, "queue-item-take")?.textContent).toBe("Take back");
    expect(q(node, "queue-item-delete")?.textContent).toBe("Delete");
  });

  it("「/」面板：没有可用的 Skill", async () => {
    const node = await render(composer());
    const textarea = q(node, "message-input") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "/");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const listbox = node.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("Suggestions");
    expect(listbox?.textContent).toContain("Choose a Skill");
    expect(listbox?.textContent).toContain("↑↓ to select · Enter to confirm · Esc to close");
    expect(listbox?.textContent).toContain("No Skills available.");
  });
});

describe("英文界面：审批档切换", () => {
  const session = { id: "s1", approvalMode: "auto" } as SessionDto;

  it("档位名与设置一致，说明与完全访问的确认", async () => {
    const onChange = vi.fn(async () => undefined);
    const node = await render(<ApprovalModeSwitcher session={session} onChange={onChange} />);
    const trigger = q(node, "approval-mode");
    expect(trigger?.textContent).toBe("Ask when out of bounds");
    expect(trigger?.title).toBe("Approval mode (this session; takes effect next turn)");

    await openMenu(trigger);
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Approval mode · This session · Takes effect next turn");
    expect(menuItems().map((item) => item.querySelector("span > span")?.textContent)).toEqual([
      "Ask every step",
      "Ask when out of bounds",
      "Full access",
    ]);
    expect(q(document, "approval-mode-option-ask")?.textContent).toContain("You approve every file write and command (safest)");

    await act(async () => q(document, "approval-mode-option-full")?.click());
    const dialog = q(document, "confirm-dialog");
    expect(dialog?.textContent).toContain("Switch to full access?");
    expect([...(dialog?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toContain("Switch to full access");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("部署上限锁定时的说明", async () => {
    const node = await render(
      <ApprovalModeSwitcher session={session} approvalModeLocked maxApprovalMode="auto" onChange={async () => undefined} />,
    );
    await openMenu(q(node, "approval-mode"));
    const full = q(document, "approval-mode-option-full");
    expect(full?.textContent).toContain("Locked by the deployment cap. Contact your administrator.");
    expect(full?.title).toContain("full access isn't available");
  });
});

describe("英文界面：检查面板", () => {
  const changes = [
    { path: "src/new.ts", kind: "created" as const, size: 10, additions: 3, deletions: 0 },
    { path: "src/old.ts", kind: "modified" as const, size: 20, additions: 1, deletions: 1 },
  ];

  function changesPanel() {
    return (
      <ChangesPanel
        changes={changes}
        additions={4}
        deletions={1}
        projectId="p1"
        projectRoot="/repo"
        running={false}
        openTargets={[]}
        requirementPanel={<div />}
        onOpen={() => undefined}
        onCollapse={() => undefined}
        onSystemOpen={() => undefined}
        onError={() => undefined}
      />
    );
  }

  it("改动标签：标签名、汇总、分组与每行标记", async () => {
    const node = await render(changesPanel());
    expect(node.querySelector("aside")?.getAttribute("aria-label")).toBe("Inspector panel");
    expect(q(node, "side-tab-changes")?.textContent).toBe("Changes2");
    expect(q(node, "side-tab-requirement")?.textContent).toBe("Requirement");
    expect(q(node, "side-tab-env")?.textContent).toBe("Environment");
    expect(node.querySelector("[aria-label='Collapse inspector panel']")?.getAttribute("title")).toBe(
      "Collapse inspector panel (⌘J)",
    );
    const list = q(node, "change-list");
    expect(list?.textContent).toContain("Since the session started · 2 files");
    expect([...(list?.querySelectorAll("h3") ?? [])].map((heading) => heading.textContent)).toEqual(["Added 1", "Modified 1"]);
    expect(q(node, "change-item")?.querySelector("span")?.textContent).toBe("A");
  });

  it("没有改动时的空状态", async () => {
    const node = await render(
      <ChangesPanel
        changes={[]}
        additions={0}
        deletions={0}
        projectId="p1"
        projectRoot="/repo"
        running={false}
        openTargets={[]}
        onOpen={() => undefined}
        onCollapse={() => undefined}
        onSystemOpen={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(node.textContent).toContain("No changes yet");
  });
});

describe("英文界面：环境面板", () => {
  function panel(running: boolean) {
    return (
      <EnvPanel
        projectId="p1"
        projectRoot="/repo/shop"
        additions={3}
        deletions={1}
        changedFiles={1}
        refreshKey="k"
        running={running}
        openTargets={[]}
        onSystemOpen={() => undefined}
        onError={() => undefined}
      />
    );
  }

  it("没有 Git 与还没初始化版本管理", async () => {
    apiMocks.gitStatus.mockResolvedValue({ available: false, repo: false, branch: null, dirty: 0, autoCheckpoint: false, hasRemote: false, lastError: null });
    const node = await render(panel(false));
    expect(node.querySelector("section")?.getAttribute("aria-label")).toBe("Environment");
    expect(node.textContent).toContain("1 file");
    expect(node.textContent).toContain("Git isn't available on this computer");

    apiMocks.gitStatus.mockResolvedValue({ available: true, repo: false, branch: null, dirty: 0, autoCheckpoint: false, hasRemote: false, lastError: null });
    await act(async () => root?.unmount());
    const fresh = await render(panel(false));
    expect(fresh.textContent).toContain("This folder isn't under version control yet.");
    expect(fresh.querySelector("button")?.textContent).toBe("Initialize version control");
  });

  it("检查点：保存、运行中的告知、还原与确认", async () => {
    window.localStorage.setItem("suduo.ui.checkpointsOpen", "true");
    apiMocks.gitStatus.mockResolvedValue({ available: true, repo: true, branch: "main", dirty: 2, autoCheckpoint: true, hasRemote: true, lastError: null });
    apiMocks.gitCheckpoints.mockResolvedValue({
      items: [{ hash: "a1", subject: "SuDuo auto-save: before turn", ts: Date.now(), auto: true, kind: "turn-start", note: null }],
    });
    const node = await render(panel(true));
    expect(node.textContent).toContain("2 uncommitted changes");
    expect(node.querySelector("#checkpoint-heading")?.textContent).toBe("Checkpoints");
    expect(q(node, "save-checkpoint")?.textContent).toBe("Save checkpoint");
    expect(q(node, "checkpoint-running-note")?.textContent).toBe(
      "This turn is still running. A checkpoint saved now may miss changes that are still being written.",
    );
    expect(q(node, "restore-checkpoint")?.title).toContain("Can't restore while a turn is running");
    expect(node.textContent).toContain("History (1)");
    expect(node.textContent).toContain("Auto-save before each turn");

    await act(async () => root?.unmount());
    const idle = await render(panel(false));
    const restore = q(idle, "restore-checkpoint");
    expect(restore?.textContent).toBe("Restore");
    expect(restore?.title).toBe("Restore this checkpoint");
    await act(async () => restore?.click());
    const dialog = q(document, "confirm-dialog");
    expect(dialog?.textContent).toContain("Restore this checkpoint?");
    expect(dialog?.textContent).toContain("Project files will go back to how they were at “Auto-saved before turn · ");
    expect(dialog?.textContent).toContain("This repository has a remote.");
  });
});

describe("英文界面：需求标签", () => {
  const UUID = "0f6b1b3e-0a6d-4c3e-9c2e-3a1c2b4d5e6f";
  const context: SessionContextDto = {
    sessionId: "s1",
    kind: "requirement",
    contextMode: "tools",
    remoteProjectId: "proj-1",
    requirement: { remoteRequirementId: UUID, number: 7, title: "Checkout", startVersion: 2, startedAt: 1 },
  };

  it("版本一行、附件与打开需求页", async () => {
    apiMocks.getRequirement.mockResolvedValue({ id: UUID, number: 7, title: "Checkout", status: "in_development", version: 4 });
    apiMocks.listRequirementAttachments.mockResolvedValue({ items: [], requirementVersion: 4 });
    const node = await render(
      <RequirementMaterials context={{ status: "ready", value: context }} onRetryContext={() => undefined} onNavigate={() => undefined} />,
    );
    expect(q(node, "requirement-material-version")?.textContent).toBe(
      "Version 2 when work started, now version 4 · Changed since work started",
    );
    expect(q(node, "requirement-material-open")?.textContent).toBe("Open requirement page");
    expect(node.querySelector("#rm-attachments")?.textContent).toBe("Attachments0");
    expect(node.textContent).toContain("This requirement has no attachments");
  });

  it("查不到时说原因并给重试", async () => {
    const node = await render(
      <RequirementMaterials
        context={{ status: "error", message: "timeout" }}
        onRetryContext={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(node.textContent).toContain("Couldn't load the linked requirement: timeout");
  });
});

describe("英文界面：文件查看器与表格预览", () => {
  const file = (content: Partial<Extract<FileContentDto, { type: "text" }>>): FileContentDto => ({
    type: "text",
    path: "data/report.csv",
    mediaType: "text/csv",
    text: "",
    size: 10,
    ...content,
  });

  it("无法预览：返回按钮与说明", async () => {
    const node = await render(
      <Drawer
        state={{ mode: "fallback", path: "docs/spec.docx", message: "Too large" }}
        projectId="p1"
        targets={[]}
        onClose={() => undefined}
        onSystemOpen={() => undefined}
      />,
    );
    expect(node.querySelector("section")?.getAttribute("aria-label")).toBe("File details");
    expect(node.querySelector("[aria-label='Back']")?.getAttribute("title")).toBe("Back (Esc)");
    expect(node.textContent).toContain("Can't preview this file here");
  });

  it("Word 等二进制文件", async () => {
    const node = await render(
      <Drawer
        state={{ mode: "preview", content: { type: "binary", path: "docs/spec.docx", mediaType: "application/octet-stream", size: 2048 } }}
        projectId="p1"
        targets={[]}
        onClose={() => undefined}
        onSystemOpen={() => undefined}
      />,
    );
    expect(node.textContent).toContain("Preview");
    expect(node.textContent).toContain("This file type can't be previewed here");
  });

  it("CSV：被截断与超出行数", async () => {
    const rows = Array.from({ length: 600 }, (_, index) => `${String(index)},x`).join("\n");
    const node = await render(
      <Drawer
        state={{ mode: "preview", content: file({ text: rows, truncated: true }) }}
        projectId="p1"
        targets={[]}
        onClose={() => undefined}
        onSystemOpen={() => undefined}
      />,
    );
    expect(node.textContent).toContain("This file is large, so only the beginning was parsed.");
    expect(node.textContent).toContain("Showing only the first 500 rows and 60 columns.");
  });

  it("空表格", async () => {
    const node = await render(
      <Drawer
        state={{ mode: "preview", content: file({ text: "" }) }}
        projectId="p1"
        targets={[]}
        onClose={() => undefined}
        onSystemOpen={() => undefined}
      />,
    );
    expect(node.textContent).toContain("This sheet is empty.");
  });

  it("「用…打开」下拉", async () => {
    const node = await render(<OpenMenu path="src/a.ts" targets={["open", "reveal", "terminal"]} onOpen={() => undefined} />);
    const trigger = q(node, "open-menu");
    expect(trigger?.textContent).toBe("Open in");
    await openMenu(trigger);
    expect(menuItems().map((item) => item.textContent)).toEqual(["Default app", "File manager", "Terminal"]);
  });
});

describe("英文界面：上传的本地报错", () => {
  it("超过 300 MB 与已取消", async () => {
    const big = new File(["x"], "big.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 314_572_801 });
    await expect(api.uploadRoomFile("room-1", big, () => undefined)).rejects.toMatchObject({
      status: 413,
      message: "This file is larger than 300 MB and can't be uploaded",
    });

    const controller = new AbortController();
    controller.abort();
    const small = new File(["x"], "a.txt", { type: "text/plain" });
    await expect(api.uploadRequirementAttachment("r1", small, "key", () => undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "Upload canceled",
    });
  });
});
