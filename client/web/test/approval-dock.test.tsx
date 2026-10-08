// @vitest-environment jsdom

import type { ApprovalDto } from "@suduo/client-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ApprovalDock, approvalQuestion, approvalSubject } from "../src/features/sessions/ApprovalDock.js";
import { displayProjectPath, toProjectPath } from "../src/features/sessions/paths.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const approval = (kind: ApprovalDto["kind"], request: Record<string, unknown>): ApprovalDto =>
  ({
    id: "ap-1",
    sessionId: "s1",
    threadRef: { runtimeId: "codex", runtimeKind: "codex", threadId: "t" },
    turnRef: null,
    kind,
    status: "pending",
    decision: null,
    request: { request },
    requestedAt: 1,
    decidedAt: null,
    version: 1,
  }) as ApprovalDto;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderDock(props: Parameters<typeof ApprovalDock>[0], before?: () => void) {
  const host = document.body.appendChild(document.createElement("div"));
  before?.();
  root = createRoot(host);
  await act(async () => root?.render(<TooltipProvider><ApprovalDock {...props} /></TooltipProvider>));
  return host;
}

const press = async (target: Element | null, key: string) =>
  act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

describe("审批坞键盘", () => {
  it("焦点在「拒绝」上按回车：执行拒绝，绝不批准", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const node = await renderDock({ approvals: [approval("command", { command: "rm -rf build" })], onDecide });
    const decline = node.querySelector<HTMLButtonElement>('[data-testid="approval-decline"]');
    decline?.focus();
    await press(decline, "Enter");
    expect(onDecide).not.toHaveBeenCalledWith(expect.anything(), "accept");
  });

  it("出现时焦点移到审批卡上；在审批卡上 ⏎ 批准、Esc 拒绝", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const node = await renderDock({ approvals: [approval("command", { command: "pnpm test" })], onDecide });
    const dock = node.querySelector('[data-testid="approval-card"]');
    expect(document.activeElement).toBe(dock);
    await press(dock, "Enter");
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-1" }), "accept");
  });

  it("正在输入框里打字时不抢焦点，回车与 Esc 也不当成批准 / 拒绝", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const textarea = document.createElement("textarea");
    const node = await renderDock({ approvals: [approval("command", { command: "pnpm test" })], onDecide }, () => {
      document.body.append(textarea);
      textarea.focus();
    });
    expect(document.activeElement).toBe(textarea);
    await press(textarea, "Enter");
    await press(textarea, "Escape");
    expect(onDecide).not.toHaveBeenCalled();
    expect(node.textContent).toContain("Agent 想运行命令");
  });

  it("文件改动审批：从同一 item 的改动卡取文件，点开看还没写入的改动", async () => {
    const onViewPatch = vi.fn();
    const change = { path: "/code/order/src/a.ts", kind: "update" as const, movePath: null, additions: 2, deletions: 1, diff: "@@ -1 +1 @@\n-a\n+b\n" };
    const node = await renderDock({
      approvals: [approval("file-change", { itemId: "fc-1", reason: null })],
      onDecide: vi.fn(),
      changesFor: () => [change],
      onViewPatch,
      displayPath: (path) => displayProjectPath(path, "/code/order"),
    });
    expect(node.textContent).toContain("Agent 想修改 1 个文件");
    expect(node.textContent).toContain("src/a.ts");
    const file = [...node.querySelectorAll("button")].find((button) => button.textContent?.includes("src/a.ts"));
    await act(async () => file?.click());
    expect(onViewPatch).toHaveBeenCalledWith(change);
  });
});

describe("项目内路径", () => {
  it("绝对路径换成项目内相对路径；项目外返回 null；相对路径原样", () => {
    expect(toProjectPath("/code/order/src/a.ts", "/code/order")).toBe("src/a.ts");
    expect(toProjectPath("/code/order/src/a.ts", "/code/order/")).toBe("src/a.ts");
    expect(toProjectPath("/code/order-2/a.ts", "/code/order")).toBeNull();
    expect(toProjectPath("./src/a.ts", "/code/order")).toBe("src/a.ts");
    expect(displayProjectPath("/tmp/x.ts", "/code/order")).toBe("/tmp/x.ts");
  });
});

describe("审批卡标题", () => {
  it("向正在运行的命令输入内容（writeStdin）与运行新命令分开说", () => {
    expect(approvalQuestion("command", { request: { kind: "writeStdin", command: "npm run dev" } })).toBe(
      "Agent 想向正在运行的命令输入内容",
    );
    expect(approvalQuestion("command", { request: { kind: "command", command: "npm test" } })).toBe("Agent 想运行命令");
    expect(approvalQuestion("command", { request: { command: "npm test" } })).toBe("Agent 想运行命令");
    expect(approvalQuestion("permissions", { request: {} })).toBe("Agent 想变更权限");
  });
});

describe("权限审批卡显示要的范围", () => {
  it("写入路径与联网都列出来，不再是空白", () => {
    expect(
      approvalSubject({
        request: { permissions: { fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/work/out" } }] }, network: { enabled: true } } },
      }),
    ).toBe("写入 /work/out\n联网");
  });
});

describe("SuDuo 工具确认卡（需求 4.3）", () => {
  const toolApproval = (suDuoTool: Record<string, unknown>, id = "ap-tool"): ApprovalDto =>
    ({
      ...approval("other", {}),
      id,
      request: { nativeMethod: "item/tool/call", suDuoTool },
    }) as ApprovalDto;
  const requirement = { id: "r1", projectId: "p1", number: 1, title: "商家端-订单详情优化" };
  /** 工具确认卡出现 400ms 后按钮才可点（防连击误触）；测试等它就绪。 */
  const renderToolDock = async (...args: Parameters<typeof renderDock>) => {
    const node = await renderDock(...args);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    return node;
  };
  const buttonText = (node: HTMLElement) =>
    [...node.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent?.trim());

  it("发评论：标题说清发到哪条需求，评论全文逐字展示（保留换行），只有「发出 / 不发」", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const body = "待确认问题：\n1. 收货地址是否脱敏？\n2. 旧订单是否补齐？";
    const node = await renderToolDock({
      approvals: [toolApproval({ tool: "comment_submit", requirement, comment: { body }, duplicateOf: null })],
      onDecide,
    });
    const card = node.querySelector<HTMLElement>('[data-testid="approval-card"]');
    expect(card?.dataset["variant"]).toBe("suduo-tool");
    expect(node.querySelector('[data-testid="tool-confirm-title"]')?.textContent).toBe("发评论到 REQ-1「商家端-订单详情优化」");
    const comment = node.querySelector<HTMLElement>('[data-testid="tool-confirm-comment"]');
    expect(comment?.textContent).toBe(body);
    expect(comment?.className).toContain("whitespace-pre-wrap");
    expect(comment?.className).toContain("overflow-auto");
    expect(node.textContent).toContain("发出后不能撤回");
    expect(buttonText(node)).toEqual(["不发", "发出"]);
    expect(node.querySelector('[data-testid="approval-more"]')).toBeNull();
    expect(node.querySelector('[data-testid="tool-confirm-duplicate"]')).toBeNull();
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="approval-accept"]')?.click());
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-tool" }), "accept");
  });

  it("需求编号与标题都没有时说「这条需求」", async () => {
    const node = await renderToolDock({
      approvals: [toolApproval({ tool: "comment_submit", requirement: { id: "r1", projectId: "p1", number: null, title: null }, comment: { body: "x" }, duplicateOf: null })],
      onDecide: vi.fn(),
    });
    expect(node.querySelector('[data-testid="tool-confirm-title"]')?.textContent).toBe("发评论到 这条需求");
  });

  it("本会话发过相同内容：只提示时间，按钮照常可用", async () => {
    const at = new Date(2026, 9, 1, 14, 32).getTime();
    const node = await renderToolDock({
      approvals: [toolApproval({ tool: "comment_submit", requirement, comment: { body: "同样的话" }, duplicateOf: { at } })],
      onDecide: vi.fn(),
    });
    expect(node.querySelector('[data-testid="tool-confirm-duplicate"]')?.textContent).toBe("本会话 14:32 已发过相同内容");
    expect(node.querySelector<HTMLButtonElement>('[data-testid="approval-accept"]')?.disabled).toBe(false);
  });

  it("对外写操作不接受回车代发；Esc 仍是「不发」", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const node = await renderToolDock({
      approvals: [toolApproval({ tool: "comment_submit", requirement, comment: { body: "x" }, duplicateOf: null })],
      onDecide,
    });
    const dock = node.querySelector('[data-testid="approval-card"]');
    expect(document.activeElement).toBe(dock);
    await press(dock, "Enter");
    expect(onDecide).not.toHaveBeenCalled();
    await press(dock, "Escape");
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-tool" }), "decline");
  });

  it("决定进行中：主按钮转圈，两个按钮都不能再点", async () => {
    let finish: () => void = () => undefined;
    const onDecide = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const node = await renderToolDock({
      approvals: [toolApproval({ tool: "comment_submit", requirement, comment: { body: "x" }, duplicateOf: null })],
      onDecide,
    });
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="approval-accept"]')?.click());
    const accept = node.querySelector<HTMLButtonElement>('[data-testid="approval-accept"]');
    expect(accept?.getAttribute("aria-busy")).toBe("true");
    expect(accept?.disabled).toBe(true);
    expect(node.querySelector<HTMLButtonElement>('[data-testid="approval-decline"]')?.disabled).toBe(true);
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="approval-decline"]')?.click());
    expect(onDecide).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(node.querySelector<HTMLButtonElement>('[data-testid="approval-accept"]')?.disabled).toBe(false);
  });

  it("suDuoTool 放在 request 里也认；没有 suDuoTool 的「其它」审批仍按普通审批显示", async () => {
    const nested = {
      ...approval("other", {}),
      request: { nativeMethod: "item/tool/call", request: { suDuoTool: { tool: "comment_submit", requirement, comment: { body: "嵌套" }, duplicateOf: null } } },
    } as ApprovalDto;
    const first = await renderToolDock({ approvals: [nested], onDecide: vi.fn() });
    expect(first.querySelector('[data-testid="tool-confirm-comment"]')?.textContent).toBe("嵌套");
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    const plain = await renderToolDock({ approvals: [approval("other", { reason: "继续吗" })], onDecide: vi.fn() });
    expect(plain.querySelector('[data-testid="approval-card"]')?.getAttribute("data-variant")).toBeNull();
    expect(plain.textContent).toContain("Agent 请你确认后继续");
    expect(buttonText(plain)).toContain("批准");
  });

  it("刚出现的 400ms 内按钮不可点（上一张卡的连击不会落到这张不可撤回的卡上）", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const node = await renderDock({
      approvals: [toolApproval({ tool: "comment_submit", requirement, comment: { body: "x" }, duplicateOf: null })],
      onDecide,
    });
    const accept = node.querySelector<HTMLButtonElement>('[data-testid="approval-accept"]');
    expect(accept?.disabled).toBe(true);
    await act(async () => accept?.click());
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("已经在执行（刷新后看到 deciding）：显示「正在发出…」，按钮与 Esc 都不再生效", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const node = await renderToolDock({
      approvals: [{ ...toolApproval({ tool: "comment_submit", requirement, comment: { body: "x" }, duplicateOf: null }), status: "deciding" } as ApprovalDto],
      onDecide,
    });
    expect(node.textContent).toContain("正在发出…");
    expect(node.querySelector<HTMLElement>('[data-testid="approval-card"]')?.dataset["status"]).toBe("deciding");
    expect(node.querySelector<HTMLButtonElement>('[data-testid="approval-decline"]')?.disabled).toBe(true);
    await press(node.querySelector('[data-testid="approval-card"]'), "Escape");
    expect(onDecide).not.toHaveBeenCalled();
  });
});

