// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ markRequirementRead: vi.fn() }));
vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { useReadMarker } from "../src/features/requirements/read-marker.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

async function renderMarker() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  let shown: ((latestCommentAt: string | null) => void) | null = null;
  function Probe() {
    shown = useReadMarker("req-1", "proj-1");
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    ),
  );
  return { shown: (latestCommentAt: string | null) => shown?.(latestCommentAt), invalidate };
}

describe("需求详情的已读位置", () => {
  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    apiMocks.markRequirementRead.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    vi.restoreAllMocks();
  });

  it("在前台看到评论：按显示出来的最新一条记已读，并让「指派给我」重取", async () => {
    const { shown, invalidate } = await renderMarker();
    await act(async () => shown("2026-09-29T10:00:00.000Z"));
    expect(apiMocks.markRequirementRead).toHaveBeenCalledWith("req-1", { upTo: "2026-09-29T10:00:00.000Z" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: expect.arrayContaining(["assigned-to-me"]) });
  });

  it("没有显示出评论（被筛掉 / 还没取到）不记", async () => {
    const { shown } = await renderMarker();
    await act(async () => shown(null));
    expect(apiMocks.markRequirementRead).not.toHaveBeenCalled();
  });

  it("标签页在后台不记；回到前台时补记", async () => {
    visibility = "hidden";
    const { shown } = await renderMarker();
    await act(async () => shown("2026-09-29T10:00:00.000Z"));
    expect(apiMocks.markRequirementRead).not.toHaveBeenCalled();
    await act(async () => setVisibility("visible"));
    expect(apiMocks.markRequirementRead).toHaveBeenCalledTimes(1);
    expect(apiMocks.markRequirementRead).toHaveBeenCalledWith("req-1", { upTo: "2026-09-29T10:00:00.000Z" });
  });

  it("已读位置只往前走：同一条或更早的不重复记，更新的一条再记", async () => {
    const { shown } = await renderMarker();
    await act(async () => shown("2026-09-29T10:00:00.000Z"));
    await act(async () => shown("2026-09-29T10:00:00.000Z"));
    await act(async () => shown("2026-09-29T09:00:00.000Z"));
    expect(apiMocks.markRequirementRead).toHaveBeenCalledTimes(1);
    await act(async () => shown("2026-09-29T11:00:00.000Z"));
    expect(apiMocks.markRequirementRead).toHaveBeenCalledTimes(2);
    expect(apiMocks.markRequirementRead).toHaveBeenLastCalledWith("req-1", { upTo: "2026-09-29T11:00:00.000Z" });
  });

  it("记不下（网络等）不打扰，下次再记", async () => {
    apiMocks.markRequirementRead.mockRejectedValueOnce(new Error("offline"));
    const { shown } = await renderMarker();
    await act(async () => shown("2026-09-29T10:00:00.000Z"));
    await act(async () => setVisibility("visible"));
    expect(apiMocks.markRequirementRead).toHaveBeenCalledTimes(2);
  });
});
