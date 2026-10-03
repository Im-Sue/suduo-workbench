// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  uploadAttachment: vi.fn(),
  fileIndex: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { Composer, type ComposerQueue, type ComposerRunState } from "../src/components/Composer.js";
import type { QueueItem } from "../src/session/queue.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => root?.render(element));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function textareaOf(node: HTMLElement): HTMLTextAreaElement {
  const textarea = node.querySelector<HTMLTextAreaElement>("[data-testid='message-input']");
  if (textarea === null) throw new Error("message-input not rendered");
  return textarea;
}

async function type(node: HTMLElement, value: string): Promise<void> {
  const textarea = textareaOf(node);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(node: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    textareaOf(node).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

const q = (node: HTMLElement, testId: string) => node.querySelector<HTMLElement>(`[data-testid='${testId}']`);
const all = (node: HTMLElement, testId: string) => [...node.querySelectorAll<HTMLElement>(`[data-testid='${testId}']`)];

function running(): ComposerRunState {
  return { status: "running", stepText: null, elapsedMs: null, pendingApprovals: 0, stopping: false, onStop: () => undefined, onJumpToApproval: () => undefined };
}

function queueView(overrides: Partial<ComposerQueue> = {}): ComposerQueue {
  return {
    items: [], status: "idle", pausedReason: null,
    onEnqueue: vi.fn(), onRemove: vi.fn(), onUpdate: vi.fn(), onTake: vi.fn(() => null), onResume: vi.fn(),
    ...overrides,
  };
}

function composer(input: { queue: ComposerQueue; runState?: ComposerRunState; skillPath?: string; onSkillPath?(path: string): void }) {
  return (
    <Composer
      disabled={false}
      projectId="p1"
      projectRoot="/repo"
      sessionId="s1"
      skills={[{ name: "review", path: "/repo/.codex/skills/review", description: "审查" } as never]}
      skillPath={input.skillPath ?? ""}
      onSkillPath={input.onSkillPath ?? (() => undefined)}
      onError={() => undefined}
      {...(input.runState === undefined ? {} : { runState: input.runState })}
      queue={input.queue}
    />
  );
}

describe("Composer 队列布局与入口（PR5）", () => {
  it("运行中：「排队」按钮把草稿整份入队并只清这一份；空闲时没有排队入口", async () => {
    const queue = queueView();
    const node = await render(composer({ queue, runState: running() }));
    expect(q(node, "queue-message")).not.toBeNull();
    await type(node, "第三件事");
    await act(async () => q(node, "queue-message")?.click());
    expect(queue.onEnqueue).toHaveBeenCalledWith({ text: "第三件事", skill: undefined, attachmentIds: [] });
    expect(textareaOf(node).value).toBe("");
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();

    await rerender(composer({ queue, runState: { ...running(), status: "idle" } }));
    expect(q(node, "queue-message")).toBeNull();
  });

  it("补全面板关闭时 Tab = 排队；面板打开时 Tab 仍是接受候选，不入队", async () => {
    const queue = queueView();
    const onSkillPath = vi.fn();
    const node = await render(composer({ queue, runState: running(), onSkillPath }));
    await type(node, "先记一下");
    await press(node, "Tab");
    expect(queue.onEnqueue).toHaveBeenCalledTimes(1);

    // 输入 "/" 打开 skill 面板：Tab 接受候选
    await type(node, "/rev");
    await press(node, "Tab");
    expect(onSkillPath).toHaveBeenCalledWith("/repo/.codex/skills/review");
    expect(queue.onEnqueue).toHaveBeenCalledTimes(1);
  });

  it("没有回合在跑时 Tab 不入队（走浏览器默认焦点移动）", async () => {
    const queue = queueView();
    const node = await render(composer({ queue }));
    await type(node, "闲时");
    await press(node, "Tab");
    expect(queue.onEnqueue).not.toHaveBeenCalled();
  });

  it("队列面板：列出各项（静态 testid + data-index）、待核对标记、编辑 / 删除 / 取回；暂停时显示理由与恢复", async () => {
    const taken: QueueItem = { id: "b", text: "取回我", skill: { name: "review", path: "/repo/.codex/skills/review" }, attachmentIds: ["att-1"] };
    const onSkillPath = vi.fn();
    const queue = queueView({
      items: [{ id: "a", text: "第一条", attachmentIds: [], unconfirmed: true }, taken],
      status: "paused", pausedReason: "send_uncertain",
      onTake: vi.fn(() => taken),
    });
    const node = await render(composer({ queue, runState: running(), onSkillPath }));
    const items = all(node, "queue-item");
    expect(items.map((entry) => entry.getAttribute("data-index"))).toEqual(["0", "1"]);
    expect(items[0]?.getAttribute("data-unconfirmed")).toBe("true");
    expect(items[0]?.textContent).toContain("待核对");
    expect(q(node, "queue-paused")?.textContent).toContain("这一条发没发出去还不确定");
    expect(node.textContent).toContain("仅本标签页有效");

    await act(async () => q(node, "queue-resume")?.click());
    expect(queue.onResume).toHaveBeenCalledTimes(1);

    await act(async () => all(node, "queue-item-delete")[0]?.click());
    expect(queue.onRemove).toHaveBeenCalledWith("a");

    await act(async () => all(node, "queue-item-edit")[1]?.click());
    const editor = items[1]?.querySelector("textarea") ?? null;
    expect(editor).not.toBeNull();

    await act(async () => all(node, "queue-item-take")[0]?.click());
    expect(queue.onTake).toHaveBeenCalled();
    expect(textareaOf(node).value).toBe("取回我");
    expect(onSkillPath).toHaveBeenCalledWith("/repo/.codex/skills/review");
    // 取回的附件只有 id、没有大小：chip 显示「图片」但不显示大小
    const chip = q(node, "attachment-chip");
    expect(chip?.getAttribute("data-attachment-id")).toBe("att-1");
    expect(chip?.textContent).toBe("图片");
  });
});

describe("Composer 队列面板 · 返工补充（PR5）", () => {
  it("选中 skill 入队：草稿带 skill 的 name 与 path，不只有路径", async () => {
    const queue = queueView();
    const node = await render(composer({ queue, runState: running(), skillPath: "/repo/.codex/skills/review" }));
    await act(async () => q(node, "queue-message")?.click());
    expect(queue.onEnqueue).toHaveBeenCalledWith({ text: "", skill: { name: "review", path: "/repo/.codex/skills/review" }, attachmentIds: [] });
  });

  it("每一种暂停都有恢复入口：只剩待核对项、以及归属未证实后队列为空时也显示「恢复」", async () => {
    const onlyUnconfirmed = queueView({ items: [{ id: "a", text: "待核对的", attachmentIds: [], unconfirmed: true }], status: "paused", pausedReason: "send_uncertain" });
    const node = await render(composer({ queue: onlyUnconfirmed, runState: running() }));
    expect(q(node, "queue-resume")).not.toBeNull();
    await act(async () => q(node, "queue-resume")?.click());
    expect(onlyUnconfirmed.onResume).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();

    const emptyPaused = queueView({ items: [], status: "paused", pausedReason: "attribution_unconfirmed" });
    await rerender(composer({ queue: emptyPaused, runState: running() }));
    expect(q(node, "queue-paused")?.textContent).toContain("这一条去了哪儿还没确认");
    expect(q(node, "queue-resume")).not.toBeNull();
  });
});
