// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEntryDto,
  type ProjectStatsResponse,
} from "@suduo/cloud-contracts";
import { api, ApiClientError } from "../src/api/client.js";
import { AppRoot } from "../src/app/AppRoot.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  localStorage.clear();
});

const user = { id: "u1", loginName: "sue", displayName: "Sue", createdAt: "2026-08-25T00:00:00.000Z" };
const project = {
  id: "p1",
  name: "项目一",
  isArchived: false,
  createdBy: { id: user.id, displayName: user.displayName },
  updatedBy: { id: user.id, displayName: user.displayName },
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  version: 1,
};

class SilentEventSource {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();
}

function stubShell() {
  vi.stubGlobal("EventSource", SilentEventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/api/v2/requirements/settings") {
      return new Response(JSON.stringify({
        configured: true,
        baseUrl: "http://requirements.test",
        session: { user, expiresAt: "2026-08-26T00:00:00.000Z" },
        mappingCount: 0,
      }));
    }
    if (input === "/api/v2/projects?includeArchived=true") {
      return new Response(JSON.stringify({ items: [project], nextCursor: null }));
    }
    if (input.startsWith("/api/v2/projects/p1/requirements?")) {
      return new Response(JSON.stringify({ items: [], nextCursor: null }));
    }
    return new Response(JSON.stringify({ code: "NOT_FOUND", message: "未预期的请求" }), { status: 404 });
  }));
}

function audit(index: number, action: AuditAction): AuditEntryDto {
  return {
    id: `a${String(index)}`,
    actor: { id: "u2", displayName: "张三" },
    resourceType: action.startsWith("project") ? "project" : action.startsWith("requirement")
      ? "requirement" : action.startsWith("comment") ? "comment" : action.startsWith("attachment")
        ? "attachment" : "artifact_version",
    resourceId: `r${String(index)}`,
    action,
    before: action === "requirement.status_changed" ? { status: "draft" } : null,
    after: action === "requirement.status_changed" ? { status: "in_development" } : null,
    createdAt: `2026-08-25T10:${String(59 - index).padStart(2, "0")}:00.000Z`,
  };
}

function stats(): ProjectStatsResponse {
  return {
    statusCounts: {
      draft: 1,
      in_refinement: 0,
      ready_for_development: 0,
      in_development: 2,
      in_testing: 0,
      completed: 3,
      on_hold: 1,
    },
    staleRequirements: [{
      id: "stale-1",
      number: 12,
      title: "停滞的需求",
      status: "in_development",
      staleDays: 8,
      level: "warning",
      lastUpdatedBy: { id: "u2", displayName: "张三" },
      updatedAt: "2026-08-15T10:00:00.000Z",
    }],
    staleTotal: 1,
    transitions: [
      { date: "2026-08-24", count: 0, byStatus: {} },
      { date: "2026-08-25", count: 4, byStatus: { in_development: 3, completed: 1 } },
    ],
  };
}

async function settle() {
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 查询失败会按默认策略重试一次（约 1 秒），用真实时间等到条件成立。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

async function open(path: string): Promise<HTMLDivElement> {
  window.history.replaceState({}, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<AppRoot />));
  await settle();
  return container;
}

function button(page: HTMLElement, text: string, within = ""): HTMLButtonElement | undefined {
  return [...page.querySelectorAll<HTMLButtonElement>(`${within} button`)].find((item) => item.textContent?.trim() === text);
}

describe("概览页", () => {
  it("状态分布七块，点一块进入带筛选的需求页", async () => {
    stubShell();
    vi.spyOn(api, "getProjectStats").mockResolvedValue(stats());
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open("/p/p1/overview");

    const tiles = page.querySelectorAll('[data-testid="overview-status-funnel"] button');
    expect(tiles).toHaveLength(7);
    expect(page.textContent).toContain("共 7 条需求");
    expect(page.querySelector("table.sr-only")?.textContent).toContain("2026-08-25");
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="开发中：2 条，查看这些需求"]')?.click());
    await settle();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/p/p1/requirements?status=in_development");
  });

  it("停滞需求按各状态的节奏列出：说明规则，标出「停滞较久 / 该推进了」，点开按编号进入详情", async () => {
    stubShell();
    vi.spyOn(api, "getProjectStats").mockResolvedValue({
      ...stats(),
      staleRequirements: [
        { ...stats().staleRequirements[0]!, id: "s1", number: 12, staleDays: 8, level: "warning" },
        { ...stats().staleRequirements[0]!, id: "s2", number: 13, title: "草稿很久", status: "draft", staleDays: 16, level: "notice" },
        // 旧版需求服务会把没到节奏的也列出来：前端按同一张表再筛掉。
        { ...stats().staleRequirements[0]!, id: "s3", number: 14, title: "刚动过", staleDays: 1, level: "normal" },
      ],
      staleTotal: 2,
    });
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open("/p/p1/overview");

    const list = page.querySelector('[data-testid="overview-stale-requirements"]');
    expect(list?.textContent).toContain("REQ-12");
    expect(list?.textContent).toContain("停滞较久");
    expect(list?.textContent).toContain("REQ-13");
    expect(list?.textContent).toContain("该推进了");
    expect(list?.textContent).not.toContain("REQ-14");
    expect(page.textContent).toContain("开发中 / 测试中 3 天");
    expect(page.querySelector('[aria-label="停滞天数"]')).toBeNull();

    await act(async () => page.querySelector<HTMLButtonElement>('[data-testid="overview-stale-requirements"] button')?.click());
    await settle();
    expect(window.location.pathname).toBe("/p/p1/requirements/12");
  });

  it("旧版需求服务（没给停滞总数）：照实说明只列出了它给的停滞需求", async () => {
    stubShell();
    const legacy = stats();
    delete legacy.staleTotal;
    vi.spyOn(api, "getProjectStats").mockResolvedValue(legacy);
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open("/p/p1/overview");
    expect(page.textContent).toContain("需求服务的版本较旧，这里只列出它给出的停滞需求");
    expect(page.textContent).not.toContain("停滞较久的在前");
  });

  it("时间范围写进地址：打开 ?range=30d 直接按 30 天取数，切换时地址跟着变", async () => {
    stubShell();
    const getProjectStats = vi.spyOn(api, "getProjectStats").mockResolvedValue(stats());
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open("/p/p1/overview?range=30d");
    expect(getProjectStats).toHaveBeenCalledWith("p1", expect.objectContaining({ window: "30d" }));
    await act(async () => button(page, "7 天", '[aria-label="时间范围"]')?.click());
    await settle();
    expect(window.location.search).toBe("?range=7d");
    expect(getProjectStats).toHaveBeenCalledWith("p1", expect.objectContaining({ window: "7d" }));
  });

  it("时间范围切到 30 天重新取数；最近动态先显示 8 条，展开后 12 种动作都在", async () => {
    stubShell();
    const getProjectStats = vi.spyOn(api, "getProjectStats").mockResolvedValue(stats());
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({
      items: AUDIT_ACTIONS.map((action, index) => audit(index, action)),
      nextCursor: null,
    });
    const page = await open("/p/p1/overview");

    expect(getProjectStats).toHaveBeenCalledWith("p1", expect.objectContaining({ window: "7d" }));
    await act(async () => button(page, "30 天", '[aria-label="时间范围"]')?.click());
    await settle();
    expect(getProjectStats).toHaveBeenCalledWith("p1", expect.objectContaining({ window: "30d" }));

    expect(page.querySelectorAll('[data-testid^="overview-audit-"]')).toHaveLength(8);
    await act(async () => button(page, "显示全部 12 条")?.click());
    for (const action of AUDIT_ACTIONS) {
      expect(page.querySelector(`[data-testid="overview-audit-${action}"]`)).not.toBeNull();
    }
    expect(page.textContent).toContain("草稿 → 开发中");
  });

  it("统计失败时各区块给出原因和重试，动态区不受影响", async () => {
    stubShell();
    // 4xx 不重试（queries.ts 的重试策略）：失败态立即出现，测试不用等真实的重试间隔。
    const getProjectStats = vi.spyOn(api, "getProjectStats").mockRejectedValue(
      new ApiClientError(422, "VALIDATION_ERROR", "时区参数无效"),
    );
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [audit(0, "comment.created")], nextCursor: null });
    const page = await open("/p/p1/overview");
    await waitUntil(() => page.textContent?.includes("统计没能加载") === true);
    // 统计失败只报一次警报，三个区块都有重试。
    expect(page.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect([...page.querySelectorAll("button")].filter((item) => item.textContent === "重试")).toHaveLength(3);

    expect(page.querySelector('[data-testid="overview-audit-comment.created"]')).not.toBeNull();
    getProjectStats.mockResolvedValue(stats());
    await act(async () => page.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    await waitUntil(() => page.querySelectorAll('[data-testid="overview-status-funnel"] button').length === 7);
  });
});
