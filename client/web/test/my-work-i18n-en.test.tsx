// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MyWorkbenchResponse, RequirementListItemDto, SessionListItemDto } from "@suduo/client-contracts";
import { api } from "../src/api/client.js";
import { AppRoot } from "../src/app/AppRoot.js";
import { summarizeDoctor } from "../src/app/pages/doctor-summary.js";
import { readSetupPending, recordEnvironmentPending, recordMappingPending } from "../src/app/pages/setup-pending.js";
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

function stubShell(options: { mappingCount?: number } = {}) {
  vi.stubGlobal("EventSource", SilentEventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/api/v2/requirements/settings") {
      return new Response(JSON.stringify({
        configured: true,
        baseUrl: "http://requirements.test",
        session: { user, expiresAt: "2026-08-26T00:00:00.000Z" },
        mappingCount: options.mappingCount ?? 1,
      }));
    }
    if (input === "/api/v2/projects?includeArchived=true") {
      return new Response(JSON.stringify({ items: [project], nextCursor: null }));
    }
    return new Response(JSON.stringify({ code: "NOT_FOUND", message: "unexpected request" }), { status: 404 });
  }));
  vi.spyOn(api, "listRequirements").mockResolvedValue({ items: [], nextCursor: null });
}

function session(id: string, patch: Partial<SessionListItemDto> = {}): SessionListItemDto {
  return {
    id,
    projectId: "l1",
    title: `Session ${id}`,
    state: "active",
    purpose: "requirement",
    approvalMode: "ask",
    model: null,
    reasoningEffort: null,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    lastActivityAt: Date.now() - 60_000,
    version: 1,
    threads: [],
    project: { id: "l1", name: "Checkout", rootPath: "/code/checkout", state: "active", remoteProjectId: "p1" },
    requirement: { remoteRequirementId: "r1", number: 12, title: "Order export" },
    preview: { role: "user", text: "Add CSV export" },
    runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null },
    ...patch,
  } as SessionListItemDto;
}

const readyWorkbench = (patch: Partial<MyWorkbenchResponse> = {}): MyWorkbenchResponse => ({
  actions: { status: "ready", data: [] },
  requirements: { status: "ready", data: [] },
  sessions: { status: "ready", data: [] },
  ...patch,
});

async function settle() {
  for (let index = 0; index < 12; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(): Promise<HTMLDivElement> {
  applyLocalePreference("en");
  window.history.replaceState({}, "", "/my");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<AppRoot />));
  await settle();
  return container;
}

const section = (page: HTMLElement, testId: string) => page.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
const buttons = (node: HTMLElement) => [...node.querySelectorAll("button")].map((button) => button.textContent);

describe("英文界面：我的工作", () => {
  it("各分组标题与空状态", async () => {
    stubShell();
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    expect(page.querySelector("h1")?.textContent).toBe("My work");
    expect(section(page, "workbench-refresh").textContent).toBe("Refresh");
    const actions = section(page, "workbench-actions");
    expect(actions.getAttribute("aria-label")).toBe("Needs your attention");
    expect(actions.textContent).toContain("All caught up. Nothing needs you right now.");
    const mine = section(page, "workbench-requirements");
    expect(mine.querySelector("h2")?.textContent).toBe("My requirements");
    expect(mine.textContent).toContain("No requirements assigned to you, in progress, or created by you without an assignee.");
    expect(buttons(mine.querySelector<HTMLElement>('[aria-label="Requirement scope"]')!)).toEqual(["All projects", "Checkout"]);
    const sessions = section(page, "workbench-sessions");
    expect(sessions.querySelector("h2")?.textContent).toBe("Sessions");
    expect(sessions.textContent).toContain("No sessions on this computer yet. Start one from a requirement on the Requirements page.");
    const recent = section(page, "workbench-activity");
    expect(recent.querySelector("h2")?.textContent).toBe("Recent activity");
    expect(recent.textContent).toContain("No one else has changed your requirements recently.");
    expect(page.querySelector('[data-testid="setup-checklist"]')).toBeNull();
  });

  it("需要你处理、我的需求、会话卡与最近动态", async () => {
    stubShell();
    const listed = (patch: Record<string, unknown>): RequirementListItemDto => ({
      id: "r1", projectId: "p1", number: 12, title: "Order export", summary: "", status: "in_development",
      assignee: { id: "u1", displayName: "Sue" }, commentCount: 3, attachmentCount: 0, localSessionCount: 0,
      createdBy: { id: "u1", displayName: "Sue" }, updatedBy: { id: "u2", displayName: "Alex Chen" },
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: new Date(Date.now() - 60_000).toISOString(), version: 1,
      ...patch,
    }) as RequirementListItemDto;
    vi.spyOn(api, "listRequirements").mockImplementation(async (_projectId, query) =>
      query?.creator === "me"
        ? { items: [listed({ id: "r9", number: 19, title: "My idea", assignee: null, status: "draft" })], nextCursor: null }
        : {
            items: [
              listed({ unreadCommentCount: 1 }),
              listed({ id: "r2", number: 13, title: "Stuck one", unreadCommentCount: 2, updatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }),
            ],
            nextCursor: null,
          },
    );
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(
      readyWorkbench({
        actions: {
          status: "ready",
          data: [{ kind: "pending_approval", sessionId: "s1", sessionTitle: "Session s1", localProjectId: "l1", projectName: "Checkout", pendingApprovals: 2, lastActivityAt: null }],
        },
      }),
    );
    vi.spyOn(api, "listAllSessions").mockResolvedValue({
      items: [
        session("s1", { runStatus: { running: false, pendingApprovals: 2, lastTurnOutcome: null } }),
        session("s2", { state: "error", runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: "failed" } }),
        session("s3", { runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null, runningSince: Date.now() - 75_000 } }),
      ],
      nextCursor: null,
    });
    const page = await open();

    const actions = section(page, "workbench-actions");
    const approval = actions.querySelector('[data-testid="workbench-action-pending_approval-s1"]');
    expect(approval?.textContent).toContain("Waiting for you · Session s1");
    expect(approval?.textContent).toContain("Checkout · 2 approvals waiting for you");
    expect(approval?.textContent).toContain("Review");
    const comments = actions.querySelector('[data-testid="workbench-action-new_comments-r1"]');
    expect(comments?.textContent).toContain("New comments · REQ-12 Order export");
    expect(comments?.textContent).toContain("Checkout · 1 comment you haven't read");
    const stale = actions.querySelector('[data-testid="workbench-action-stale-r2"]');
    expect(stale?.textContent).toContain("Stalled · REQ-13 Stuck one");
    expect(stale?.textContent).toContain("Checkout · In development · No changes in 10 days");
    expect(stale?.textContent).toContain("Move it forward");

    const mine = section(page, "workbench-requirements");
    expect(mine.querySelector('section[aria-label="In development"]')).not.toBeNull();
    expect(mine.querySelector('section[aria-label="Draft"]')).not.toBeNull();
    expect(mine.textContent).toContain("1 new comment");
    expect(mine.textContent).toContain("2 new comments");
    expect(mine.textContent).toContain("Assigned to you");
    expect(mine.textContent).toContain("Created by you · Unassigned");

    const sessions = section(page, "workbench-sessions");
    expect(sessions.textContent).toContain("2 in progress");
    expect(section(page, "workbench-session-s1").textContent).toContain("Waiting for you: 2 approvals · REQ-12 Order export");
    expect(section(page, "workbench-session-s1").textContent).toContain("You: Add CSV export");
    expect(section(page, "workbench-session-s2").textContent).toContain("Last turn didn't finish");
    expect(section(page, "workbench-session-s3").textContent).toMatch(/Running · 1:1[5-7] elapsed/);

    const recent = section(page, "workbench-activity");
    expect(recent.textContent).toContain("Alex Chen updated REQ-12 Order export");
  });

  it("单复数与兜底文字", () => {
    const text = messagesFor("en").myWork;
    expect(text.attention.stale.days(1)).toBe("No changes in 1 day");
    expect(text.attention.stale.days(8)).toBe("No changes in 8 days");
    expect(text.attention.pendingApproval.count(1)).toBe("1 approval waiting for you");
    expect(text.attention.drift.detail(1)).toBe("1 session is working on it, and what it saw at the start is out of date");
    expect(text.attention.drift.detail(3)).toBe("3 sessions are working on it, and what they saw at the start is out of date");
    expect(text.requirements.sessions(1)).toBe("1 session");
    expect(text.requirements.sessions(4)).toBe("4 sessions");
    expect(text.sessions.card.approval(1)).toBe("Waiting for you: 1 approval");
    expect(text.setupChecklist.remaining(1)).toBe("1 setup item left");
    expect(text.fixMapping.description(null)).toMatch(/^This project's local folder is no longer available\./);
    expect(text.fixMapping.description("Checkout")).toMatch(/^The local folder for “Checkout” is no longer available\./);
  });
});

describe("英文界面：首启留下的设置提醒", () => {
  it("中文界面下记下的提醒，切到英文后标题按 key 显示为英文；检查结论是当时的快照，原样显示", async () => {
    applyLocalePreference("zh-CN");
    recordEnvironmentPending(
      summarizeDoctor([
        { name: "Codex CLI", status: "pass", message: "codex-cli 0.159.2" },
        { name: "Codex · auth · auth.credentials", status: "fail", message: "no Codex credentials were found" },
      ]),
    );
    recordMappingPending(true);
    expect(JSON.parse(localStorage.getItem("suduo.setup.pending") ?? "null")).toEqual([
      { key: "model", detail: "还没有配置模型服务地址或 API Key，开始会话前需要补上" },
      { key: "mapping" },
    ]);
    expect(readSetupPending().map((item) => item.title)).toEqual(["模型服务", "关联本机代码目录"]);

    stubShell({ mappingCount: 0 });
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const checklist = section(page, "setup-checklist");
    expect(checklist.getAttribute("aria-label")).toBe("Unfinished setup");
    expect(checklist.querySelector("h2")?.textContent).toBe("2 setup items left");
    const rows = [...checklist.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows[0]).toBe("Model service · 还没有配置模型服务地址或 API Key，开始会话前需要补上Check again");
    expect(rows[1]).toBe(
      "Link local folder · SuDuo doesn't know where the project code is yet. Choose its folder before you start a session.Link",
    );
    expect(checklist.querySelector('[aria-label="Don\'t show again"]')).not.toBeNull();
  });

  it("旧格式（存了成句的 title / detail）仍能显示：标题与代码目录那条按 key 取英文，检查结论照旧", async () => {
    localStorage.setItem(
      "suduo.setup.pending",
      JSON.stringify([
        { key: "network", title: "网络", detail: "连不上模型服务。检查网络，或在设置里配置代理" },
        { key: "mapping", title: "关联本机代码目录", detail: "还没有告诉 SuDuo 项目代码在哪里，开始会话前需要选一次。" },
        { key: "bogus", title: "不认识", detail: "丢弃" },
        { key: "runtime", title: "缺了结论" },
      ]),
    );
    stubShell({ mappingCount: 0 });
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const checklist = section(page, "setup-checklist");
    expect(checklist.querySelector("h2")?.textContent).toBe("2 setup items left");
    expect(checklist.textContent).toContain("Network · 连不上模型服务。检查网络，或在设置里配置代理");
    expect(checklist.textContent).toContain("Link local folder · SuDuo doesn't know where the project code is yet.");
    expect(checklist.textContent).not.toContain("关联本机代码目录");
    expect(buttons(checklist).slice(1)).toEqual(["Check again", "Link"]);
  });

  it("旧格式里只剩一条（代码目录已关联时那条不显示）：单数", async () => {
    localStorage.setItem(
      "suduo.setup.pending",
      JSON.stringify([
        { key: "sandbox", title: "命令沙箱", detail: "bwrap: No permissions to create new namespace" },
        { key: "mapping", title: "关联本机代码目录", detail: "还没有关联" },
      ]),
    );
    stubShell({ mappingCount: 1 });
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const checklist = section(page, "setup-checklist");
    expect(checklist.querySelector("h2")?.textContent).toBe("1 setup item left");
    expect(checklist.textContent).toContain("Command sandbox · bwrap: No permissions to create new namespace");
  });
});
