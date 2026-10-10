// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDto, SendMessageAccepted } from "@suduo/client-contracts";

const apiMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  uploadAttachment: vi.fn(),
  fileIndex: vi.fn(),
  listAllSessions: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { Composer } from "../src/components/Composer.js";

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

/** 受控 textarea 必须走原生 setter + input 事件，React 才会收到 onChange。 */
async function type(node: HTMLElement, value: string): Promise<void> {
  const textarea = node.querySelector<HTMLTextAreaElement>(
    "[data-testid='message-input']",
  );
  if (textarea === null) {
    throw new Error("message-input not rendered");
  }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function textareaOf(node: HTMLElement): HTMLTextAreaElement {
  const textarea = node.querySelector<HTMLTextAreaElement>(
    "[data-testid='message-input']",
  );
  if (textarea === null) {
    throw new Error("message-input not rendered");
  }
  return textarea;
}

function attachmentIds(node: HTMLElement): string[] {
  return [...node.querySelectorAll("[data-testid='attachment-chip']")].map(
    (chip) => chip.getAttribute("data-attachment-id") ?? "",
  );
}

async function clickSend(node: HTMLElement): Promise<void> {
  const send = node.querySelector<HTMLButtonElement>(
    "[data-testid='send-message']",
  );
  await act(async () => send?.click());
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const accepted: SendMessageAccepted = {
  sessionId: "s1",
  messageEventSeq: 1,
  threadRef: { runtimeId: "rt1", runtimeKind: "codex", threadId: "t1" },
  turnRef: { threadId: "t1", turnId: "turn-1" },
  acceptedAt: 1,
};

function attachment(id: string): AttachmentDto {
  return {
    id,
    projectId: "p1",
    relativePath: `.codex/attachments/${id}.png`,
    mediaType: "image/png",
    size: 10,
  };
}

/** 通过隐藏 file input 走真实上传链路：jsdom 里直接定义 files。 */
async function upload(node: HTMLElement, name: string): Promise<void> {
  const input = node.querySelector<HTMLInputElement>("input[type='file']");
  if (input === null) {
    throw new Error("file input not rendered");
  }
  const file = new File([new Uint8Array([1, 2, 3])], name, {
    type: "image/png",
  });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function composer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
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
      {...overrides}
    />
  );
}

describe("Composer 草稿保全（PR1）", () => {
  it("在途改写文本：发送成功后保留新文本，不无条件清空", async () => {
    const gate = deferred<SendMessageAccepted>();
    apiMocks.sendMessage.mockReturnValue(gate.promise);
    const node = await render(composer());

    await type(node, "把测试跑一遍");
    await clickSend(node);
    // 响应还没回来，用户接着打字——今天这段字会被无条件清空。
    await type(node, "把测试跑一遍，顺便看覆盖率");
    await act(async () => {
      gate.resolve(accepted);
      await gate.promise;
    });

    expect(textareaOf(node).value).toBe("把测试跑一遍，顺便看覆盖率");
  });

  it("在途新增附件：只移除本次提交的那一份，期间完成的上传不受影响", async () => {
    apiMocks.uploadAttachment.mockResolvedValueOnce(attachment("att-1"));
    const gate = deferred<SendMessageAccepted>();
    apiMocks.sendMessage.mockReturnValue(gate.promise);
    const node = await render(composer());

    await upload(node, "first.png");
    expect(attachmentIds(node)).toEqual(["att-1"]);

    await clickSend(node);
    apiMocks.uploadAttachment.mockResolvedValueOnce(attachment("att-2"));
    await upload(node, "second.png");
    await act(async () => {
      gate.resolve(accepted);
      await gate.promise;
    });

    expect(attachmentIds(node)).toEqual(["att-2"]);
  });

  it("切会话：上一会话的在途回调不改动新会话的输入框", async () => {
    const gate = deferred<SendMessageAccepted>();
    apiMocks.sendMessage.mockReturnValue(gate.promise);
    const onMessageAccepted = vi.fn();
    const node = await render(composer({ onMessageAccepted }));

    await type(node, "上一个会话的话");
    await clickSend(node);
    await rerender(composer({ sessionId: "s2", onMessageAccepted }));
    await type(node, "新会话里刚打的字");
    await act(async () => {
      gate.resolve(accepted);
      await gate.promise;
    });

    expect(textareaOf(node).value).toBe("新会话里刚打的字");
    expect(onMessageAccepted).not.toHaveBeenCalled();
  });
});

describe("Composer 输入解禁（PR1 · R1）", () => {
  it("回合运行中 textarea 不禁用，只有无会话时禁用", async () => {
    const node = await render(composer());
    expect(textareaOf(node).disabled).toBe(false);
    await rerender(composer({ disabled: true }));
    expect(textareaOf(node).disabled).toBe(true);
  });

  it("上传只禁图片按钮，不禁 textarea 与发送", async () => {
    const gate = deferred<AttachmentDto>();
    apiMocks.uploadAttachment.mockReturnValue(gate.promise);
    const node = await render(composer());
    await type(node, "有字才可发送");
    await upload(node, "slow.png");

    const attach = node.querySelector<HTMLButtonElement>(
      "[data-testid='attach-image']",
    );
    const send = node.querySelector<HTMLButtonElement>(
      "[data-testid='send-message']",
    );
    expect(attach?.disabled).toBe(true);
    expect(textareaOf(node).disabled).toBe(false);
    expect(send?.disabled).toBe(false);

    await act(async () => {
      gate.resolve(attachment("att-9"));
      await gate.promise;
    });
    expect(
      node.querySelector<HTMLButtonElement>("[data-testid='attach-image']")
        ?.disabled,
    ).toBe(false);
  });
});

describe("Composer「@」引用会话（多 Agent 协作 S7）", () => {
  const session = (id: string, title: string, projectId: string, agent: string) =>
    ({ id, title, agentId: agent, agent: { displayName: agent === "claude-code" ? "Claude Code" : "Codex" }, project: { id: projectId, name: projectId === "p1" ? "商家端" : "别的项目" } }) as never;

  it("「@」面板里会话在前（当前项目优先、不含自己），选中插入会话引用；文件照旧在后面", async () => {
    apiMocks.fileIndex.mockResolvedValue({ items: ["src/export.ts"], truncated: false });
    apiMocks.listAllSessions.mockResolvedValue({
      items: [session("s1", "当前会话", "p1", "codex"), session("other", "导出接口（别处）", "p2", "codex"), session("a1", "导出接口", "p1", "claude-code")],
      nextCursor: null,
    });
    const node = await render(composer({ referencesSessions: true }));
    await type(node, "@导出");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const items = [...node.querySelectorAll<HTMLElement>("[data-testid='palette-item']")];
    expect(items.map((item) => item.textContent)).toEqual(["导出接口Claude Code · 商家端", "导出接口（别处）Codex · 别的项目"]);
    expect(apiMocks.listAllSessions).toHaveBeenCalledWith({ state: "active", limit: 50 });
    await act(async () => items[0]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(textareaOf(node).value).toBe("[导出接口](suduo://session/a1) ");

    // 文件照旧：会话没匹配上时只有文件。
    await type(node, "@export");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([...node.querySelectorAll<HTMLElement>("[data-testid='palette-item']")].map((item) => item.textContent)).toEqual(["export.tssrc/export.ts"]);
  });

  it("会话不能引用别的会话（本机会话没有读会话的工具）：「@」只列文件，也不去取会话列表", async () => {
    apiMocks.fileIndex.mockResolvedValue({ items: ["src/export.ts"], truncated: false });
    const node = await render(composer());
    await type(node, "@ex");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([...node.querySelectorAll<HTMLElement>("[data-testid='palette-item']")].map((item) => item.textContent)).toEqual(["export.tssrc/export.ts"]);
    expect(apiMocks.listAllSessions).not.toHaveBeenCalled();
  });
});
