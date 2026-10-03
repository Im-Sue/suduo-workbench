// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRunSummaryDto } from "@suduo/cloud-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagesData } from "../src/features/rooms/model.js";
import { ME, message, run, WANG, ZHANG } from "./fixtures/rooms.js";

const apiMocks = vi.hoisted(() => ({ stopAgentRun: vi.fn(), retryAgentRun: vi.fn() }));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { RunCard, RunStatusLine } = await import("../src/features/rooms/components/RunStatusLine.js");
const { roomKeys } = await import("../src/features/rooms/keys.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderLine(entry: AgentRunSummaryDto, meId: string | null, onOpen = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RunStatusLine run={entry} meId={meId} onOpen={onOpen} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  return container;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const q = (node: ParentNode, id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("消息下的 Agent 状态行", () => {
  it.each([
    [run({ status: "queued", queuePosition: 3 }), "小王 的 Codex·排队中（前面还有 3 个）"],
    [run({ status: "running", progress: "查看了 6 个文件" }), "小王 的 Codex·执行中 · 查看了 6 个文件"],
    [run({ status: "completed", summary: "后端已有 receiverSnapshot" }), "小王 的 Codex·已完成 · 后端已有 receiverSnapshot"],
    [run({ status: "failed", reason: "所有者本机下线，执行中断" }), "小王 的 Codex·失败 · 所有者本机下线，执行中断"],
    [run({ status: "stopped" }), "小王 的 Codex·已停止"],
    [run({ status: "offline", reason: null }), "小王 的 Codex·离线，未执行"],
  ])("%#：各状态的文字", async (entry, text) => {
    const node = await renderLine(entry, null);
    const line = q(node, "run-status");
    expect(line?.getAttribute("data-status")).toBe(entry.status);
    expect(line?.querySelector("button")?.textContent).toBe(text);
  });

  it("点状态行打开话题", async () => {
    const onOpen = vi.fn();
    const node = await renderLine(run(), null, onOpen);
    await act(async () => q(node, "run-status")?.querySelector("button")?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("停止：触发人或所有者可见；旁观者看不到", async () => {
    let node = await renderLine(run({ status: "running", triggeredBy: ME }), ME.id);
    expect(q(node, "run-stop")).not.toBeNull();
    expect(q(node, "run-retry")).toBeNull();
    await act(async () => root?.unmount());
    node = await renderLine(run({ status: "running", triggeredBy: ME }), WANG.id);
    expect(q(node, "run-stop")).not.toBeNull();
    await act(async () => root?.unmount());
    node = await renderLine(run({ status: "running", triggeredBy: ME }), ZHANG.id);
    expect(q(node, "run-stop")).toBeNull();
  });

  it("重试：只有触发人，失败 / 已停止 / 离线；回来的状态写回状态行", async () => {
    client.setQueryData<MessagesData>(roomKeys.messages("room-1"), { items: [message({ id: "m-2", seq: 2, runs: [run({ status: "offline" })] })], hasMoreBefore: false, lastSeq: 2 });
    apiMocks.retryAgentRun.mockResolvedValue(run({ status: "queued", queuePosition: 0 }));
    let node = await renderLine(run({ status: "offline", triggeredBy: ME }), WANG.id);
    expect(q(node, "run-retry")).toBeNull();
    await act(async () => root?.unmount());
    node = await renderLine(run({ status: "offline", triggeredBy: ME }), ME.id);
    await act(async () => q(node, "run-retry")?.click());
    expect(apiMocks.retryAgentRun).toHaveBeenCalledWith("run-1");
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-1"))?.items[0]?.runs[0]?.status).toBe("queued");
  });

  it("点停止调停止接口", async () => {
    apiMocks.stopAgentRun.mockResolvedValue(run({ status: "running", stopRequested: true }));
    const node = await renderLine(run({ status: "queued", triggeredBy: ME }), ME.id);
    await act(async () => q(node, "run-stop")?.click());
    expect(apiMocks.stopAgentRun).toHaveBeenCalledWith("run-1");
  });
});

describe("话题里的任务状态卡", () => {
  it("执行中显示进度与正在走的用时；「查看详情」打开运行详情", async () => {
    const onViewDetail = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <RunCard run={run({ status: "running", progress: "查看了 6 个文件", startedAt })} meId={null} onViewDetail={onViewDetail} />
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    );
    const card = q(container, "run-card");
    expect(card?.textContent).toContain("执行中");
    expect(card?.textContent).toContain("查看了 6 个文件");
    expect(card?.textContent).toMatch(/用时 1 分 \d+ 秒/);
    await act(async () => q(container ?? document, "run-view-detail")?.click());
    expect(onViewDetail).toHaveBeenCalledTimes(1);
  });
});
