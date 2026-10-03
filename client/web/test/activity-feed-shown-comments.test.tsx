// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementActivityEntryDto } from "@suduo/cloud-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ listRequirementActivity: vi.fn() }));
vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { ActivityFeed, type ActivityFilter } from "../src/features/requirements/sections/ActivityFeed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const colleague = { id: "u2", displayName: "张三" };

function entry(patch: Partial<RequirementActivityEntryDto> & Pick<RequirementActivityEntryDto, "id" | "action" | "createdAt">): RequirementActivityEntryDto {
  return {
    requirementId: "r1",
    actor: colleague,
    resourceType: "requirement",
    resourceId: "r1",
    changes: [],
    comment: null,
    attachment: null,
    artifactVersion: null,
    ...patch,
  };
}

// 最新在前（与接口一致）：最新一条是状态变化，其次是确认版发布，再往前才是两条评论。
const ENTRIES: RequirementActivityEntryDto[] = [
  entry({
    id: "a4",
    action: "requirement.status_changed",
    createdAt: "2026-09-29T12:00:00.000Z",
    changes: [{ field: "status", from: "draft", to: "in_development" }],
  }),
  entry({
    id: "a3",
    action: "artifact_version.published",
    resourceType: "artifact_version",
    resourceId: "v1",
    createdAt: "2026-09-29T11:00:00.000Z",
    artifactVersion: { id: "v1", versionNumber: 1, fileCount: 1, note: "第一版说明" },
  }),
  entry({ id: "a2", action: "comment.created", resourceType: "comment", resourceId: "c2", createdAt: "2026-09-29T10:00:00.000Z", comment: { id: "c2", body: "第二条" } }),
  entry({ id: "a1", action: "comment.created", resourceType: "comment", resourceId: "c1", createdAt: "2026-09-29T09:00:00.000Z", comment: { id: "c1", body: "第一条" } }),
];

let root: Root | null = null;

async function renderFeed(filter: ActivityFilter, onShownComments: (latest: string | null) => void): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ActivityFeed requirementId="r1" mode="timeline" filter={filter} onShownComments={onShownComments} />
      </QueryClientProvider>,
    ),
  );
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

describe("时间线告诉详情页「显示出来的最新评论」", () => {
  it("全部：报最新一条评论的时间，而不是最新一条活动（状态变化、确认版发布不算评论）", async () => {
    apiMocks.listRequirementActivity.mockResolvedValue({ items: ENTRIES, nextCursor: null });
    const shown = vi.fn();
    await renderFeed("all", shown);
    expect(shown).toHaveBeenLastCalledWith("2026-09-29T10:00:00.000Z");
    expect(shown).not.toHaveBeenCalledWith("2026-09-29T12:00:00.000Z");
    expect(shown).not.toHaveBeenCalledWith("2026-09-29T11:00:00.000Z");
  });

  it("只看评论：同样报最新一条评论", async () => {
    apiMocks.listRequirementActivity.mockResolvedValue({ items: ENTRIES, nextCursor: null });
    const shown = vi.fn();
    await renderFeed("comments", shown);
    expect(shown).toHaveBeenLastCalledWith("2026-09-29T10:00:00.000Z");
  });

  it("只看变更：评论被筛掉，报 null（不算看过）", async () => {
    apiMocks.listRequirementActivity.mockResolvedValue({ items: ENTRIES, nextCursor: null });
    const shown = vi.fn();
    await renderFeed("changes", shown);
    expect(shown).toHaveBeenCalled();
    expect(shown.mock.calls.every(([latest]) => latest === null)).toBe(true);
  });

  it("还在加载时不报；加载失败也不报", async () => {
    apiMocks.listRequirementActivity.mockReturnValue(new Promise(() => undefined));
    const pending = vi.fn();
    await renderFeed("all", pending);
    expect(pending).not.toHaveBeenCalled();
    await act(async () => root?.unmount());

    apiMocks.listRequirementActivity.mockRejectedValue(new Error("offline"));
    const failed = vi.fn();
    await renderFeed("all", failed);
    expect(failed.mock.calls.every(([latest]) => latest === null)).toBe(true);
  });
});
