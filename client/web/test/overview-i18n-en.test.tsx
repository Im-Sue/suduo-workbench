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
import { api } from "../src/api/client.js";
import { AppRoot } from "../src/app/AppRoot.js";
import { staleRuleText } from "../src/features/overview/OverviewPage.js";
import { groupSummary, presentAudit, statusTransitionOf } from "../src/features/overview/timeline.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  applyLocalePreference("system");
  localStorage.clear();
});

const user = { id: "u1", loginName: "sue", displayName: "Sue", createdAt: "2026-08-25T00:00:00.000Z" };
const project = {
  id: "p1",
  name: "Checkout",
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
    return new Response(JSON.stringify({ code: "NOT_FOUND", message: "unexpected request" }), { status: 404 });
  }));
}

function audit(index: number, action: AuditAction, patch: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return {
    id: `a${String(index)}`,
    actor: { id: "u2", displayName: "Alex Chen" },
    resourceType: action.startsWith("project") ? "project" : action.startsWith("requirement")
      ? "requirement" : action.startsWith("comment") ? "comment" : action.startsWith("attachment")
        ? "attachment" : "artifact_version",
    resourceId: `r${String(index)}`,
    action,
    before: action === "requirement.status_changed" ? { status: "draft" } : null,
    after: action === "requirement.status_changed" ? { status: "in_development" } : null,
    createdAt: `2026-08-25T10:${String(59 - index).padStart(2, "0")}:00.000Z`,
    ...patch,
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
    staleRequirements: [
      {
        id: "stale-1",
        number: 12,
        title: "Order export",
        status: "in_development",
        staleDays: 8,
        level: "warning",
        lastUpdatedBy: { id: "u2", displayName: "Alex Chen" },
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
      {
        id: "stale-2",
        number: 13,
        title: "Refund flow",
        status: "draft",
        staleDays: 1,
        level: "notice",
        lastUpdatedBy: { id: "u2", displayName: "Alex Chen" },
        updatedAt: "2026-08-24T10:00:00.000Z",
      },
    ],
    staleTotal: 5,
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

async function open(path: string): Promise<HTMLDivElement> {
  applyLocalePreference("en");
  window.history.replaceState({}, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<AppRoot />));
  await settle();
  return container;
}

const block = (page: HTMLElement, title: string) => page.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;

describe("英文界面：概览", () => {
  it("状态分布、趋势图说明与停滞需求", async () => {
    stubShell();
    vi.spyOn(api, "getProjectStats").mockResolvedValue(stats());
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open("/p/p1/overview");

    expect(page.querySelector("h1")?.textContent).toBe("Overview");
    expect(page.textContent).toContain("Status breakdown, flow, and stalled requirements for “Checkout”.");

    const status = block(page, "Status breakdown");
    expect(status.textContent).toContain("7 requirements");
    expect(status.querySelector('[aria-label="In development: 2 requirements, show them"]')?.textContent).toBe("In development2");
    expect(status.querySelector('[aria-label="Draft: 1 requirement, show it"]')).not.toBeNull();

    const trend = block(page, "Status flow");
    expect(trend.textContent).toContain("4 status changes in the last 7 days");
    expect([...trend.querySelectorAll('[aria-label="Time range"] button')].map((item) => item.textContent)).toEqual(["7 days", "30 days"]);
    const table = trend.querySelector("table.sr-only")!;
    expect(table.querySelector("caption")?.textContent).toBe("Daily moves into each status, last 7 days");
    expect([...table.querySelectorAll("thead th")].map((item) => item.textContent)).toEqual([
      "Date",
      "Total",
      "Moved to In development",
      "Moved to Done",
    ]);

    const stale = block(page, "Stalled requirements");
    expect(stale.textContent).toContain("5 in total, showing the 2 most urgent");
    expect(stale.textContent).toContain(
      "Listed when unchanged for: In development / In testing: 3 days, Refining / Ready: 7 days, Draft: 14 days, On hold: 30 days. Longest stalled first.",
    );
    const rows = stale.querySelectorAll('[data-testid="overview-stale-requirements"] button');
    expect(rows[0]?.textContent).toContain("Last updated by Alex Chen · ");
    expect(rows[0]?.textContent).toContain("StalledIdle 8 days");
    expect(rows[1]?.textContent).toContain("Needs a nudgeIdle 1 day");
  });

  it("空状态", async () => {
    stubShell();
    vi.spyOn(api, "getProjectStats").mockResolvedValue({
      statusCounts: { draft: 0, in_refinement: 0, ready_for_development: 0, in_development: 0, in_testing: 0, completed: 0, on_hold: 0 },
      staleRequirements: [],
      staleTotal: 0,
      transitions: [{ date: "2026-08-25", count: 0, byStatus: {} }],
    });
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open("/p/p1/overview");

    expect(block(page, "Status breakdown").textContent).toContain("This project doesn't have any requirements yet.");
    expect(block(page, "Status breakdown").textContent).toContain("Create the first one");
    expect(block(page, "Status flow").textContent).toContain("0 status changes in the last 7 days");
    expect(block(page, "Status flow").textContent).toContain("No requirement changed status in this period.");
    expect(block(page, "Stalled requirements").textContent).toContain("No stalled requirements. Everything is moving at its own pace.");
    expect(block(page, "Recent activity").textContent).toContain("No activity in this project yet.");
  });

  it("旧版需求服务的停滞说明", async () => {
    stubShell();
    const legacy = stats();
    delete legacy.staleTotal;
    vi.spyOn(api, "getProjectStats").mockResolvedValue(legacy);
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open("/p/p1/overview");
    expect(block(page, "Stalled requirements").textContent).toContain(
      "The requirements service is an older version, so only the stalled requirements it reports are listed here.",
    );
  });

  it("活动时间线：各类型的句子、状态流转、归并与展开", async () => {
    stubShell();
    vi.spyOn(api, "getProjectStats").mockResolvedValue(stats());
    vi.spyOn(api, "listRequirementsAudit").mockResolvedValue({
      items: [
        audit(0, "requirement.status_changed"),
        audit(1, "requirement.updated"),
        audit(2, "requirement.updated"),
        ...AUDIT_ACTIONS.map((action, index) => audit(index + 3, action, { actor: { id: `u${String(index + 3)}`, displayName: `User ${String(index)}` } })),
      ],
      nextCursor: null,
    });
    const page = await open("/p/p1/overview");

    const timeline = page.querySelector<HTMLElement>('[data-testid="overview-timeline"]')!;
    // 状态流转紧跟在句子后面，间距由样式给出。
    expect(timeline.querySelector('[data-testid="overview-audit-requirement.status_changed"]')?.textContent).toContain(
      "Alex Chen changed a requirement's statusDraft → In development",
    );
    const grouped = [...timeline.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")][0]!;
    expect(grouped.textContent).toContain("Alex Chen made 2 requirement updates");
    await act(async () => grouped.click());
    expect([...timeline.querySelectorAll('[data-testid="overview-audit-requirement.updated"]')].map((item) => item.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Alex Chen updated a requirement")]),
    );

    const showAll = [...page.querySelectorAll("button")].find((item) => item.textContent === "Show all 15");
    expect(showAll).not.toBeUndefined();
    await act(async () => showAll?.click());
    expect(timeline.textContent).toContain("User 7 posted a comment");
    expect(timeline.textContent).toContain("User 8 uploaded an attachment");
    expect(timeline.textContent).toContain("User 11 published a confirmed version");
    expect([...page.querySelectorAll("button")].some((item) => item.textContent === "Show less")).toBe(true);
  });
});

describe("英文界面：概览的非组件文字", () => {
  const entry = (action: AuditAction, resourceType: AuditEntryDto["resourceType"] = "requirement"): AuditEntryDto => ({
    id: "a1",
    actor: { id: "u1", displayName: "Sue" },
    resourceType,
    resourceId: "r1",
    action,
    before: null,
    after: null,
    createdAt: "2026-08-17T00:00:00.000Z",
  });

  it("按调用时的语言取文字，也可由调用方传入字典", () => {
    applyLocalePreference("en");
    expect(presentAudit(entry("requirement.created")).text).toBe("created a requirement");
    expect(presentAudit(entry("project.archived", "project")).text).toBe("archived the project");
    expect(presentAudit(entry("requirement.created"), messagesFor("zh-CN")).text).toBe("创建了需求");
    expect(statusTransitionOf({ ...entry("requirement.status_changed"), before: { status: "in_testing" }, after: { status: "completed" } }))
      .toBe("In testing → Done");
    expect(statusTransitionOf({ ...entry("requirement.status_changed"), after: { status: "bogus" } })).toBe("Status changed");
    expect(staleRuleText(messagesFor("zh-CN"))).toBe("开发中 / 测试中 3 天、梳理中 / 待开发 7 天、草稿 14 天、暂缓 30 天");
  });

  it("未知动作回落原文；归并组的单复数", () => {
    applyLocalePreference("en");
    const unknown = { ...entry("requirement.created"), resourceType: "widget" as AuditEntryDto["resourceType"], action: "widget.frobnicated" as AuditAction };
    expect(presentAudit(unknown).text).toBe("performed widget.frobnicated on widget");
    expect(presentAudit({ ...unknown, resourceType: "comment" }).text).toBe("performed widget.frobnicated on comment");
    expect(groupSummary("comment.created", 3)).toBe("posted 3 comments");
    expect(groupSummary("attachment.deleted", 1)).toBe("deleted 1 attachment");
    expect(groupSummary("project.updated", 2)).toBe("updated the project 2 times");
    expect(groupSummary("widget.frobnicated" as AuditAction, 2)).toBe("handled 2 records");
    expect(groupSummary("widget.frobnicated" as AuditAction, 2, messagesFor("zh-CN"))).toBe("处理了 2 条记录");
    const text = messagesFor("en").overview;
    expect(text.stale.truncated(5, 1)).toBe("5 in total, showing the most urgent one");
    expect(text.trend.summary(30, 1)).toBe("1 status change in the last 30 days");
    expect(text.trend.times(1)).toBe("1 time");
  });
});
