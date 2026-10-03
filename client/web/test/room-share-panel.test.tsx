// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LocalAgentStateDto } from "@suduo/client-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, ME, room, share, shareRequest, WANG, ZHANG } from "./fixtures/rooms.js";

const apiMocks = vi.hoisted(() => ({
  closeAgentShare: vi.fn(),
  getSelfAgent: vi.fn(),
  listAgents: vi.fn(),
  listRequirementsMappings: vi.fn(),
  listRoomShares: vi.fn(),
  listShareRequests: vi.fn(),
  openAgentShare: vi.fn(),
  requestAgentShare: vi.fn(),
  resolveShareRequest: vi.fn(),
}));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ShareAgentPanel } = await import("../src/features/rooms/components/ShareAgentPanel.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const myAgent = agent({ id: "agent-me", owner: ME, deviceName: "MacBook Air", label: "李娜 的 Codex · MacBook Air" });
const ready = (patch: Partial<LocalAgentStateDto> = {}): LocalAgentStateDto => ({
  status: "ready",
  agent: myAgent,
  message: null,
  activeRun: null,
  queuedRuns: 0,
  ...patch,
});

async function settle(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ShareAgentPanel room={room()} meId={ME.id} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container;
}

const q = (node: ParentNode, id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (node: ParentNode, text: string) => [...node.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
/** 时长分段里选中的那一档。 */
const selectedDuration = (node: ParentNode) => q(node, "share-duration")?.querySelector('[data-state="on"]')?.textContent?.trim();

async function rerender() {
  await act(async () => root?.unmount());
  container?.remove();
  return render();
}

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiMocks.getSelfAgent.mockResolvedValue(ready());
  apiMocks.listAgents.mockResolvedValue({ items: [agent(), agent({ id: "agent-zhang", owner: ZHANG, label: "小张 的 Codex · ThinkPad", online: false }), myAgent] });
  apiMocks.listRoomShares.mockResolvedValue({ items: [share()] });
  apiMocks.listShareRequests.mockResolvedValue({ items: [] });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [{ remoteProjectId: "p1", localProjectId: "l1", rootPath: "/code/p1", localProjectName: "p1", lastValidatedAt: 0 }] });
  apiMocks.openAgentShare.mockResolvedValue(share({ id: "share-me", agent: myAgent }));
  apiMocks.closeAgentShare.mockResolvedValue({});
  apiMocks.requestAgentShare.mockResolvedValue(shareRequest());
  apiMocks.resolveShareRequest.mockResolvedValue({});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("共享 Agent 面板", () => {
  it("本机 Agent 没登记：说明原因，不给开关", async () => {
    apiMocks.getSelfAgent.mockResolvedValue({ status: "unregistered", agent: null, message: "还没登录需求服务", activeRun: null, queuedRuns: 0 });
    const node = await render();
    expect(q(node, "my-agent-unavailable")?.textContent).toContain("还没登录需求服务");
    expect(q(node, "my-agent-switch")).toBeNull();
  });

  it("打开开关按选的时长共享；「今天」带浏览器本地当天结束时刻", async () => {
    const node = await render();
    const switchControl = q(node, "my-agent-switch");
    expect(switchControl?.getAttribute("aria-checked")).toBe("false");
    await act(async () => switchControl?.click());
    await settle(2);
    expect(apiMocks.openAgentShare).toHaveBeenCalledWith("room-1", expect.objectContaining({ agentId: "agent-me", duration: "today", expiresAt: expect.any(String) }));
    const expiresAt = new Date((apiMocks.openAgentShare.mock.calls[0]?.[1] as { expiresAt: string }).expiresAt);
    expect([expiresAt.getHours(), expiresAt.getMinutes(), expiresAt.getSeconds()]).toEqual([23, 59, 59]);

    await act(async () => button(q(node, "share-duration") ?? node, "2 小时")?.click());
    // 还没共享时换时长只是选择，不发请求。
    expect(apiMocks.openAgentShare).toHaveBeenCalledTimes(1);
  });

  it("没共享时选的时长记住：再打开面板仍选中它，提示里写明打开后按哪一档共享", async () => {
    apiMocks.openAgentShare.mockReset();
    let node = await render();
    expect(selectedDuration(node)).toBe("今天");
    await act(async () => button(q(node, "share-duration") ?? node, "直到我关闭")?.click());
    expect(q(node, "my-agent-share-state")?.textContent).toContain("打开后按「直到我关闭」共享");
    node = await rerender();
    expect(selectedDuration(node)).toBe("直到我关闭");
    await act(async () => q(node, "my-agent-switch")?.click());
    await settle(2);
    expect(apiMocks.openAgentShare).toHaveBeenCalledWith("room-1", { agentId: "agent-me", duration: "until_closed" });
  });

  it("已共享：面板按共享的到期时间选中对应档，不回到默认的「今天」", async () => {
    const at = (hours: number, minutes: number, seconds: number) => {
      const date = new Date();
      date.setHours(hours, minutes, seconds, 0);
      return date.toISOString();
    };
    const cases: [string | null, string][] = [
      [null, "直到我关闭"],
      [at(23, 59, 59), "今天"],
      [at(15, 42, 7), "2 小时"],
    ];
    for (const [expiresAt, label] of cases) {
      apiMocks.listRoomShares.mockResolvedValue({ items: [share({ id: "share-me", agent: myAgent, expiresAt })] });
      client.clear();
      const node = await rerender();
      expect(selectedDuration(node), String(expiresAt)).toBe(label);
    }
  });

  it("已共享：显示到期；改时长按新时长重开；关掉开关关闭共享", async () => {
    apiMocks.listRoomShares.mockResolvedValue({ items: [share(), share({ id: "share-me", agent: myAgent, expiresAt: null })] });
    const node = await render();
    expect(q(node, "my-agent-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(q(node, "my-agent-share-state")?.textContent).toContain("已共享 · 直到关闭");
    // 选中的是实际共享的档：再点它不算改；点「今天」才按新时长重开。
    expect(selectedDuration(node)).toBe("直到我关闭");
    await act(async () => button(q(node, "share-duration") ?? node, "今天")?.click());
    await settle(2);
    expect(apiMocks.openAgentShare).toHaveBeenCalledWith("room-1", expect.objectContaining({ agentId: "agent-me", duration: "today", expiresAt: expect.any(String) }));
    await act(async () => q(node, "my-agent-switch")?.click());
    await settle(2);
    expect(apiMocks.closeAgentShare).toHaveBeenCalledWith("share-me");
  });

  it("本房间已共享的 Agent 显示在线与到期；别人的没共享的可以申请", async () => {
    const node = await render();
    const shared = [...node.querySelectorAll('[data-testid="shared-agent-row"]')];
    expect(shared.map((row) => row.getAttribute("data-agent-id"))).toEqual(["agent-wang"]);
    expect(shared[0]?.textContent).toContain("可用 · 直到关闭");
    const requestable = [...node.querySelectorAll<HTMLElement>('[data-testid="requestable-agent-row"]')];
    expect(requestable.map((row) => row.getAttribute("data-agent-id"))).toEqual(["agent-zhang"]);
    await act(async () => requestable[0]?.querySelector("button")?.click());
    await settle(2);
    expect(apiMocks.requestAgentShare).toHaveBeenCalledWith("room-1", "agent-zhang");
  });

  it("我已申请过的显示「已申请」不能再点", async () => {
    apiMocks.listShareRequests.mockResolvedValue({ items: [shareRequest({ agent: agent({ id: "agent-zhang", owner: ZHANG }), requester: ME })] });
    const node = await render();
    const row = node.querySelector<HTMLElement>('[data-testid="requestable-agent-row"]');
    expect(row?.querySelector("button")?.textContent).toBe("已申请");
    expect(row?.querySelector("button")?.disabled).toBe(true);
  });

  it("我收到的待处理申请：开启（按选的时长）或忽略", async () => {
    apiMocks.listShareRequests.mockResolvedValue({ items: [shareRequest({ id: "req-9", agent: myAgent, requester: WANG })] });
    const node = await render();
    const incoming = q(node, "incoming-share-request");
    expect(incoming?.textContent).toContain("小王 申请使用");
    await act(async () => button(incoming ?? node, "开启")?.click());
    await settle(2);
    expect(apiMocks.resolveShareRequest).toHaveBeenCalledWith("req-9", expect.objectContaining({ action: "accept", duration: "today", expiresAt: expect.any(String) }));
    await act(async () => button(incoming ?? node, "忽略")?.click());
    await settle(2);
    expect(apiMocks.resolveShareRequest).toHaveBeenLastCalledWith("req-9", { action: "ignore" });
  });

  it("项目没关联本机代码目录：引导先关联；本机正在为别的房间执行时说明", async () => {
    apiMocks.listRequirementsMappings.mockResolvedValue({ items: [] });
    apiMocks.getSelfAgent.mockResolvedValue(ready({ activeRun: null, queuedRuns: 2 }));
    const node = await render();
    expect(q(node, "my-agent-no-mapping")?.textContent).toContain("关联代码目录");
    expect(node.textContent).toContain("还有 2 个在排队");
  });
});
