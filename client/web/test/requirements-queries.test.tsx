// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import type { RequirementsEventDto } from "@suduo/cloud-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getRequirement: vi.fn(),
  getRequirementByNumber: vi.fn(),
  listRequirementsSessions: vi.fn(),
  requirementsEventsUrl: () => "/api/v2/events",
}));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
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

const { requirementKeys } = await import("../src/features/requirements/keys.js");
const { useRequirementIdByRef } = await import("../src/features/requirements/queries.js");
const { invalidateForEvent, RequirementsRealtimeProvider, useRequirementsRealtimeState } = await import(
  "../src/features/requirements/realtime.js"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (patch: Partial<RequirementListItemDto> = {}): RequirementListItemDto =>
  ({
    id: "r1",
    projectId: "p1",
    number: 12,
    title: "订单导出",
    summary: "",
    status: "draft",
    assignee: null,
    commentCount: 0,
    attachmentCount: 0,
    localSessionCount: 0,
    createdBy: { id: "u1", displayName: "陈思远" },
    updatedBy: { id: "u1", displayName: "陈思远" },
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    version: 1,
    ...patch,
  }) as RequirementListItemDto;

const columnKey = requirementKeys.column("p1", "draft", {});
const seedColumn = (client: QueryClient, entries: RequirementListItemDto[]) =>
  client.setQueryData(columnKey, { pages: [{ items: entries, nextCursor: null }], pageParams: [undefined] });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

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

function Probe({ reference }: { reference: string }) {
  const resolved = useRequirementIdByRef("p1", reference);
  return <span data-testid="resolved">{resolved.id ?? "none"}</span>;
}

async function renderProbe(reference: string) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => root?.render(<QueryClientProvider client={client}><Probe reference={reference} /></QueryClientProvider>));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return document.querySelector('[data-testid="resolved"]')?.textContent;
}

describe("编号 → 需求 id", () => {
  it("看板缓存命中后被回收，id 仍在，不再请求、页面不会闪回骨架屏", async () => {
    seedColumn(client, [item()]);
    expect(await renderProbe("12")).toBe("r1");
    client.removeQueries({ queryKey: requirementKeys.project("p1") });
    expect(await renderProbe("12")).toBe("r1");
    expect(apiMocks.getRequirementByNumber).not.toHaveBeenCalled();
  });

  it("缓存里没有时按编号查一次", async () => {
    apiMocks.getRequirementByNumber.mockResolvedValue(item({ id: "r7", number: 7 }));
    expect(await renderProbe("REQ-7")).toBe("r7");
    expect(apiMocks.getRequirementByNumber).toHaveBeenCalledWith("p1", 7);
  });
});

describe("实时事件的失效范围", () => {
  const event = (type: RequirementsEventDto["type"]): RequirementsEventDto => ({
    id: "e1",
    type,
    projectId: "p1",
    requirementId: "r1",
    occurredAt: "2026-09-29T00:00:00.000Z",
  });

  it("新评论只重取这一条，看板上那张卡的计数原地更新，不整板重拉", async () => {
    seedColumn(client, [item(), item({ id: "r2", number: 13 })]);
    client.setQueryData(requirementKeys.sessions("p1"), []);
    apiMocks.getRequirement.mockResolvedValue({ ...item({ commentCount: 3, attachmentCount: 1 }), attachments: [] });
    invalidateForEvent(client, event("comment.created"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.getQueryState(columnKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(requirementKeys.sessions("p1"))?.isInvalidated).toBe(false);
    const cards = (client.getQueryData(columnKey) as { pages: { items: RequirementListItemDto[] }[] }).pages[0]!.items;
    expect(cards.map((card) => [card.id, card.commentCount, card.attachmentCount])).toEqual([
      ["r1", 3, 1],
      ["r2", 0, 0],
    ]);
  });

  it("同一需求连着来两条事件：第二次不复用第一次的请求，卡片计数不会停在旧值", async () => {
    seedColumn(client, [item()]);
    let resolveFirst: (value: unknown) => void = () => undefined;
    apiMocks.getRequirement
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ ...item({ attachmentCount: 2 }), attachments: [] });
    invalidateForEvent(client, event("attachment.changed"));
    await Promise.resolve();
    invalidateForEvent(client, event("attachment.changed"));
    // 第一次请求读到的是第二份材料落库前的状态。
    resolveFirst({ ...item({ attachmentCount: 1 }), attachments: [] });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const cards = (client.getQueryData(columnKey) as { pages: { items: RequirementListItemDto[] }[] }).pages[0]!.items;
    expect(apiMocks.getRequirement).toHaveBeenCalledTimes(2);
    expect(cards[0]?.attachmentCount).toBe(2);
  });

  it("评论 / 附件 / 产物 / 项目变化：概览的动态一起重取，统计不动", () => {
    const stats = requirementKeys.overviewStats("p1", "7d", "UTC", 7);
    for (const type of ["comment.created", "attachment.changed", "artifact.published", "project.changed"] as const) {
      client.setQueryData(stats, {});
      client.setQueryData(requirementKeys.overviewAudit("p1"), { items: [] });
      invalidateForEvent(client, event(type));
      expect(client.getQueryState(requirementKeys.overviewAudit("p1"))?.isInvalidated, type).toBe(true);
      expect(client.getQueryState(stats)?.isInvalidated, type).toBe(false);
    }
  });

  it("需求变了：概览的统计和动态都重取", () => {
    const stats = requirementKeys.overviewStats("p1", "30d", "UTC", 14);
    client.setQueryData(stats, {});
    client.setQueryData(requirementKeys.overviewAudit("p1"), { items: [] });
    invalidateForEvent(client, event("requirement.changed"));
    expect(client.getQueryState(stats)?.isInvalidated).toBe(true);
    expect(client.getQueryState(requirementKeys.overviewAudit("p1"))?.isInvalidated).toBe(true);
  });

  it("需求本身变了：看板列重取，本机会话不重查", () => {
    seedColumn(client, [item()]);
    client.setQueryData(requirementKeys.sessions("p1"), []);
    invalidateForEvent(client, event("requirement.changed"));
    expect(client.getQueryState(columnKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(requirementKeys.sessions("p1"))?.isInvalidated).toBe(false);
  });
});

describe("实时连接", () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    readonly close = vi.fn();
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }
  }

  function StateProbe() {
    return <output data-testid="realtime">{useRequirementsRealtimeState()}</output>;
  }

  it("断线按 1s、2s… 退避重连；重连成功后全量失效需求数据，补上断线期间的变化", async () => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      seedColumn(client, [item()]);
      container ??= document.body.appendChild(document.createElement("div"));
      root ??= createRoot(container);
      await act(async () =>
        root?.render(
          <QueryClientProvider client={client}>
            <RequirementsRealtimeProvider enabled>
              <StateProbe />
            </RequirementsRealtimeProvider>
          </QueryClientProvider>,
        ),
      );
      const state = () => document.querySelector('[data-testid="realtime"]')?.textContent;
      const first = FakeEventSource.instances[0]!;
      expect(first.url).toBe("/api/v2/events");
      await act(async () => first.onopen?.(new Event("open")));
      expect(state()).toBe("live");
      expect(client.getQueryState(columnKey)?.isInvalidated).toBe(false);

      await act(async () => first.onerror?.(new Event("error")));
      expect(first.close).toHaveBeenCalledOnce();
      expect(state()).toBe("reconnecting");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(FakeEventSource.instances).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const second = FakeEventSource.instances[1]!;
      await act(async () => second.onerror?.(new Event("error")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_999);
      });
      expect(FakeEventSource.instances).toHaveLength(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const third = FakeEventSource.instances[2]!;
      await act(async () => third.onopen?.(new Event("open")));
      expect(state()).toBe("live");
      expect(client.getQueryState(columnKey)?.isInvalidated).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
