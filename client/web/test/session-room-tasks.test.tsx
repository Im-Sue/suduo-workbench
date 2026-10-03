// @vitest-environment jsdom

import type { SessionListItemDto } from "@suduo/client-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { SessionList } from "../src/features/sessions/SessionList.js";
import { sessionKeys, sessionListQuery } from "../src/features/sessions/session-list.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    version: 1,
    threads: [],
    project: { id: "local-1", name: "订单中心", rootPath: "/code/order", state: "active", remoteProjectId: "p1" },
    requirement: null,
    kind: "normal",
    roomTask: null,
    preview: null,
    runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null },
    ...patch,
  } as SessionListItemDto;
}

const roomTask = (id: string) =>
  item(id, {
    title: "商家后台的订单详情现在能拿到收货信息吗？",
    kind: "room_task",
    roomTask: { remoteProjectId: "p1", roomId: "room-1", roomName: "订单中心", threadRootId: "m-2", lastRunId: "run-1" },
    runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null },
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
  vi.unstubAllGlobals();
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

describe("会话页 · 房间任务", () => {
  it("房间任务是服务端按 kind 单独取的列表；普通列表不带 kind", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetch);
    const normal = sessionListQuery("active");
    const tasks = sessionListQuery("active", "room_task");
    expect(normal.queryKey).toEqual(sessionKeys.list("active"));
    expect(tasks.queryKey).toEqual(["sessions", "list", "active", "room_task"]);
    await api.listAllSessions({ state: "active", limit: 50 });
    await api.listAllSessions({ state: "active", kind: "room_task", limit: 50 });
    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "/api/v1/sessions?state=active&limit=50",
      "/api/v1/sessions?state=active&kind=room_task&limit=50",
    ]);
  });

  it("会话页只列当前项目：查询键与请求都带远程项目，不带时仍是跨项目列表", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetch);
    expect(sessionListQuery("active", "normal", "p1").queryKey).toEqual(["sessions", "list", "active", "project", "p1"]);
    expect(sessionListQuery("active", "room_task", "p1").queryKey).toEqual(["sessions", "list", "active", "room_task", "project", "p1"]);
    expect(sessionListQuery("active", "normal").queryKey).toEqual(["sessions", "list", "active"]);
    await api.listAllSessions({ state: "active", kind: "room_task", remoteProjectId: "p1", limit: 50 });
    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "/api/v1/sessions?state=active&kind=room_task&remoteProjectId=p1&limit=50",
    ]);
  });

  it("筛选里有「房间任务」；行上显示房间名与话题，菜单里可回到讨论", async () => {
    const onFilterChange = vi.fn();
    const onOpenRoom = vi.fn();
    const node = await render(
      <SessionList
        {...baseProps}
        items={[roomTask("t1")]}
        countItems={[item("n1", { runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null } })]}
        filter="room-tasks"
        onFilterChange={onFilterChange}
        onOpenRoom={onOpenRoom}
      />,
    );
    const option = [...node.querySelectorAll<HTMLButtonElement>('[aria-label="筛选会话"] button')].find((button) => button.textContent === "房间任务");
    expect(option?.getAttribute("data-state")).toBe("on");
    // 「运行中」计数按普通会话算，不混入房间任务。
    expect(node.textContent).toContain("运行中 1");
    const row = node.querySelector('[data-testid="session-row"]');
    expect(row?.textContent).toContain("商家后台的订单详情现在能拿到收货信息吗？");
    expect(row?.querySelector('[data-testid="session-room-task"]')?.textContent).toBe("订单中心");

    const trigger = node.querySelector<HTMLButtonElement>('[aria-label^="会话「商家后台"]');
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const back = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("在讨论里查看"));
    await act(async () => back?.click());
    expect(onOpenRoom).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });

  it("没有房间任务时说明它们会出现在这里", async () => {
    const node = await render(<SessionList {...baseProps} items={[]} filter="room-tasks" />);
    expect(node.querySelector('[data-testid="sessions-empty"]')?.textContent).toContain("还没有房间任务");
  });
});
