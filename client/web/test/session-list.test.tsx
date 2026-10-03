// @vitest-environment jsdom

import type { SessionListItemDto } from "@suduo/client-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { SessionList } from "../src/features/sessions/SessionList.js";
import {
  attentionCount,
  flattenSessions,
  groupByDay,
  matchesFilter,
  matchesSearch,
  rowStatus,
} from "../src/features/sessions/session-list.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;

function item(id: string, patch: Partial<SessionListItemDto> = {}): SessionListItemDto {
  return {
    id,
    projectId: "local-1",
    title: `会话 ${id}`,
    state: "active",
    purpose: "general",
    approvalMode: "ask",
    model: null,
    reasoningEffort: null,
    createdAt: Date.now() - 3 * DAY,
    updatedAt: Date.now() - 3 * DAY,
    lastActivityAt: Date.now(),
    version: 1,
    threads: [],
    project: { id: "local-1", name: "订单中心", rootPath: "/code/order", state: "active", remoteProjectId: "p1" },
    requirement: null,
    preview: null,
    runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null },
    ...patch,
  } as SessionListItemDto;
}

describe("会话列表 · 纯逻辑", () => {
  it("筛选：运行中含等你确认；需要我 = 等你确认或上一轮失败", () => {
    expect(matchesFilter("running", "running")).toBe(true);
    expect(matchesFilter("approval", "running")).toBe(true);
    expect(matchesFilter("approval", "needs-me")).toBe(true);
    expect(matchesFilter("error", "needs-me")).toBe(true);
    expect(matchesFilter("completed", "needs-me")).toBe(false);
    expect(matchesFilter("idle", "all")).toBe(true);
  });

  it("搜索：标题、需求编号（REQ-12 或 12）、需求标题、项目名、最后一句", () => {
    const withRequirement = item("a", {
      requirement: { remoteRequirementId: "r1", number: 12, title: "订单导出" },
      preview: { role: "assistant", text: "测试都通过了" },
    });
    for (const keyword of ["REQ-12", "req-12", "订单导出", "订单中心", "测试都通过", "会话 a"]) {
      expect(matchesSearch(withRequirement, keyword), keyword).toBe(true);
    }
    expect(matchesSearch(withRequirement, "REQ-13")).toBe(false);
  });

  it("按今天 / 昨天 / 更早分组，空组不出现", () => {
    const groups = groupByDay([item("t"), item("y", { lastActivityAt: Date.now() - DAY }), item("o", { lastActivityAt: Date.now() - 5 * DAY })]);
    expect(groups.map((group) => [group.label, group.items.map((entry) => entry.id)])).toEqual([
      ["今天", ["t"]],
      ["昨天", ["y"]],
      ["更早", ["o"]],
    ]);
  });

  it("选中会话的行状态以实时通道为准，其余用列表摘要；需要我的数量据此计算", () => {
    const polled = item("a", { runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null } });
    const other = item("b", { runStatus: { running: false, pendingApprovals: 1, lastTurnOutcome: null } });
    expect(rowStatus(polled, null)).toBe("running");
    const live = { sessionId: "a", running: 0, pendingApprovals: 0, lastTurnOutcome: "failed" as const };
    expect(rowStatus(polled, live)).toBe("error");
    expect(attentionCount([polled, other], live)).toBe(2);
  });

  it("翻页期间会话变活跃：以先出现的为准，不重复显示", () => {
    const data = { pages: [{ items: [item("a"), item("b")], nextCursor: "c1" }, { items: [item("a"), item("c")], nextCursor: null }], pageParams: [undefined, "c1"] };
    expect(flattenSessions(data).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

let root: Root | null = null;

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root?.render(<TooltipProvider>{element}</TooltipProvider>));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const noop = () => undefined;
const baseProps = {
  loading: false,
  error: null,
  hasMore: false,
  loadingMore: false,
  activeSessionId: null,
  live: null,
  keyword: "",
  canCreate: true,
  createDisabledReason: "",
  onFilterChange: noop,
  onKeywordChange: noop,
  onLoadMore: noop,
  onOpen: noop,
  onCreate: noop,
  onRename: noop,
  onArchive: noop,
  onDelete: noop,
};

describe("会话列表 · 界面", () => {
  it("没有会话时给出空态和新建入口", async () => {
    const onCreate = vi.fn();
    const node = await render(<SessionList {...baseProps} items={[]} filter="all" onCreate={onCreate} />);
    expect(node.querySelector('[data-testid="sessions-empty"]')?.textContent).toContain("还没有会话");
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="new-session"]')?.click());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("当前会话行高亮；「需要我」只列等你确认或失败的会话", async () => {
    const items = [
      item("a", { requirement: { remoteRequirementId: "r1", number: 12, title: "订单导出" } }),
      item("b", { runStatus: { running: false, pendingApprovals: 2, lastTurnOutcome: null } }),
    ];
    const node = await render(<SessionList {...baseProps} items={items} activeSessionId="a" filter="all" />);
    const active = node.querySelector('[data-testid="session-row"][data-active="true"]');
    expect(active?.getAttribute("data-session-id")).toBe("a");
    expect(active?.textContent).toContain("REQ-12");
    await act(async () => root?.render(<TooltipProvider><SessionList {...baseProps} items={items} activeSessionId="a" filter="needs-me" /></TooltipProvider>));
    expect([...node.querySelectorAll('[data-testid="session-row"]')].map((row) => row.getAttribute("data-session-id"))).toEqual(["b"]);
  });

  it("行菜单：原地重命名回车提交；删除交给调用方确认", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const node = await render(<SessionList {...baseProps} items={[item("a")]} filter="all" onRename={onRename} onDelete={onDelete} />);
    const openMenu = async () => {
      const trigger = node.querySelector<HTMLButtonElement>('[aria-label^="会话「会话 a」的更多操作"]');
      await act(async () => {
        trigger?.focus();
        trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    };
    await openMenu();
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("重命名"));
    await act(async () => rename?.click());
    const input = node.querySelector<HTMLInputElement>("#rename-a");
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "导出优化");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "导出优化");

    await openMenu();
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("删除"));
    await act(async () => remove?.click());
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });
});
