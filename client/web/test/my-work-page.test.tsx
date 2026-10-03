// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListItemDto, MyWorkbenchResponse } from "@suduo/client-contracts";
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
  name: "订单中心",
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
    return new Response(JSON.stringify({ code: "NOT_FOUND", message: "未预期的请求" }), { status: 404 });
  }));
  vi.spyOn(api, "listRequirements").mockResolvedValue({ items: [], nextCursor: null });
}

function session(id: string, patch: Partial<SessionListItemDto> = {}): SessionListItemDto {
  return {
    id,
    projectId: "l1",
    title: `会话 ${id}`,
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
    project: { id: "l1", name: "订单中心", rootPath: "/code/order", state: "active", remoteProjectId: "p1" },
    requirement: { remoteRequirementId: "r1", number: 12, title: "订单导出" },
    preview: { role: "assistant", text: "已经改好导出逻辑" },
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

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

async function open(): Promise<HTMLDivElement> {
  window.history.replaceState({}, "", "/my");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<AppRoot />));
  await settle();
  return container;
}

const section = (page: HTMLElement, testId: string) => page.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;

describe("我的工作", () => {
  it("工作台接口整体失败：待处理与我在做的显示暂不可用，不显示「都处理完了」；本机会话不受影响", async () => {
    stubShell();
    // 4xx 不重试：失败态立即出现，不用等真实的重试间隔。
    vi.spyOn(api, "getMyWorkbench").mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "工作台接口不存在"));
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [session("s1")], nextCursor: null });
    const page = await open();

    expect(section(page, "workbench-sessions").querySelector('[data-testid="workbench-session-s1"]')).not.toBeNull();
    await waitUntil(() => section(page, "workbench-actions").textContent?.includes("暂不可用") === true);
    expect(section(page, "workbench-actions").textContent).not.toContain("都处理完了");
    expect(section(page, "workbench-requirements").textContent).toContain("我在做的需求暂不可用");
    // 同一原因只报一次警报。
    expect(page.querySelectorAll('[data-testid="workbench-actions"] [role="alert"], [data-testid="workbench-requirements"] [role="alert"]')).toHaveLength(1);
  });

  it("会话卡：状态点和文字同源，副行写需求编号，附最后一句话；点开进会话", async () => {
    stubShell();
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({
      items: [
        session("s1", { runStatus: { running: false, pendingApprovals: 2, lastTurnOutcome: null } }),
        session("s2", { state: "error", runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null } }),
      ],
      nextCursor: null,
    });
    const page = await open();

    const approval = section(page, "workbench-session-s1");
    expect(approval.textContent).toContain("等你确认 2 项 · REQ-12 订单导出");
    expect(approval.textContent).toContain("已经改好导出逻辑");
    expect(approval.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("等你确认");
    const broken = section(page, "workbench-session-s2");
    expect(broken.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("异常");
    expect(broken.textContent).toContain("会话出错了");
    expect(broken.textContent).not.toContain("空闲");
    expect(section(page, "workbench-sessions").textContent).toContain("进行中 1");

    // 会话页在测试里取不到会话会退回列表，这里只看跳转目标。
    const pushState = vi.spyOn(window.history, "pushState");
    await act(async () => approval.click());
    expect(pushState.mock.calls.some((call) => String(call[2]).endsWith("/sessions/s1"))).toBe(true);
  });

  it("侧栏「我的工作」旁显示待处理数（等你确认 + 开工后有变化）", async () => {
    stubShell();
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(
      readyWorkbench({
        actions: {
          status: "ready",
          data: [{ kind: "pending_approval", sessionId: "s1", sessionTitle: "会话 s1", localProjectId: "l1", projectName: "订单中心", pendingApprovals: 1, lastActivityAt: 1 }],
        },
        requirements: {
          status: "ready",
          data: [{
            requirementId: "r1", remoteProjectId: "p1", title: "订单导出", projectName: "订单中心", status: "in_development",
            availability: "available", sessionIds: ["s1"], sessionCount: 1, running: false, pendingApprovals: 1,
            lastActivityAt: 1, drift: true, snapshotStatus: "available",
          }],
        },
      }),
    );
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    // jsdom 视口窄，侧栏是收起态：数字收成一个点，读屏名称里带数量。
    expect(page.querySelector('a[href="/my"]')?.getAttribute("aria-label")).toBe("我的工作，2 件待处理");
  });

  it("我负责的需求有新评论 / 停滞较久出现在「需要你处理」；我提的没人负责的在「我的需求」里标出来", async () => {
    stubShell();
    const listed = (patch: Record<string, unknown>) => ({
      id: "r1", projectId: "p1", number: 12, title: "订单导出", summary: "", status: "in_development",
      assignee: { id: "u1", displayName: "Sue" }, commentCount: 3, attachmentCount: 0, localSessionCount: 0,
      createdBy: { id: "u1", displayName: "Sue" }, updatedBy: { id: "u2", displayName: "张三" },
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: new Date(Date.now() - 60_000).toISOString(), version: 1,
      ...patch,
    });
    vi.spyOn(api, "listRequirements").mockImplementation(async (_projectId, query) =>
      query?.creator === "me"
        ? { items: [listed({ id: "r9", number: 19, title: "我提的需求", assignee: null, status: "draft" })], nextCursor: null }
        : {
            items: [
              listed({ unreadCommentCount: 2 }),
              listed({ id: "r2", number: 13, title: "卡住的需求", updatedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }),
            ],
            nextCursor: null,
          },
    );
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const actions = section(page, "workbench-actions");
    expect(actions.querySelector('[data-testid="workbench-action-new_comments-r1"]')?.textContent).toContain("有新评论 · REQ-12 订单导出");
    expect(actions.querySelector('[data-testid="workbench-action-stale-r2"]')?.textContent).toContain("10 天没有变化");
    const mine = section(page, "workbench-requirements");
    expect(mine.textContent).toContain("2 条新评论");
    expect(mine.textContent).toContain("我提的 · 还没人负责");
    // 侧栏的待处理数与这里同一套判定。
    expect(page.querySelector('a[href="/my"]')?.getAttribute("aria-label")).toBe("我的工作，2 件待处理");

    await act(async () => actions.querySelector<HTMLButtonElement>('[data-testid="workbench-action-new_comments-r1"]')?.click());
    await settle();
    expect(window.location.pathname).toBe("/p/p1/requirements/12");
  });

  it("旧版需求服务丢掉创建人筛选时，别人提的未指派需求不会混进「我提的」", async () => {
    stubShell();
    const listed = (patch: Record<string, unknown>) => ({
      id: "r1", projectId: "p1", number: 12, title: "订单导出", summary: "", status: "draft",
      assignee: null, commentCount: 0, attachmentCount: 0, localSessionCount: 0,
      createdBy: { id: "u1", displayName: "Sue" }, updatedBy: { id: "u1", displayName: "Sue" },
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: new Date(Date.now() - 60_000).toISOString(), version: 1,
      ...patch,
    });
    // 旧服务不认 creator：带不带它都只按「未指派」返回，里面有别人提的。
    vi.spyOn(api, "listRequirements").mockImplementation(async (_projectId, query) =>
      query?.assignee === "none"
        ? {
            items: [
              listed({ id: "r9", number: 19, title: "我提的需求" }),
              listed({ id: "r8", number: 18, title: "同事提的需求", createdBy: { id: "u2", displayName: "张三" } }),
            ],
            nextCursor: null,
          }
        : { items: [], nextCursor: null },
    );
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const mine = section(page, "workbench-requirements");
    expect(mine.textContent).toContain("我提的需求");
    expect(mine.textContent).not.toContain("同事提的需求");
  });

  it("范围写进地址：?scope=current 打开即是当前项目，切换时地址跟着变", async () => {
    stubShell();
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    window.history.replaceState({}, "", "/my?scope=current");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AppRoot />));
    await settle();
    const selected = () => section(container!, "workbench-requirements").querySelector('[aria-label="需求范围"] [data-state="on"]')?.textContent;
    expect(selected()).toBe("订单中心");
    const all = [...section(container, "workbench-requirements").querySelectorAll<HTMLButtonElement>('[aria-label="需求范围"] button')].find((item) => item.textContent === "全部项目");
    await act(async () => all?.click());
    await settle();
    expect(window.location.search).toBe("?scope=all");
    expect(selected()).toBe("全部项目");
  });

  it("运行中的会话卡显示已用时间和当前在做的一步", async () => {
    stubShell();
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({
      items: [session("s1", { runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null, runningSince: Date.now() - 75_000, activity: "运行命令：npm test" } })],
      nextCursor: null,
    });
    const page = await open();
    const card = section(page, "workbench-session-s1");
    expect(card.textContent).toMatch(/运行中 · 已用 1:1[5-7]/);
    expect(card.querySelector('[data-testid="session-activity"]')?.textContent).toBe("运行命令：npm test");
  });

  it("后台刷新不转圈，点「刷新」才转", async () => {
    stubShell();
    let resolveWorkbench: (value: MyWorkbenchResponse) => void = () => undefined;
    vi.spyOn(api, "getMyWorkbench")
      .mockResolvedValueOnce(readyWorkbench())
      .mockReturnValueOnce(new Promise((resolve) => (resolveWorkbench = resolve)));
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const icon = () => section(page, "workbench-refresh").querySelector("svg");
    expect(icon()?.getAttribute("class")).not.toContain("animate-spin");
    await act(async () => section(page, "workbench-refresh").click());
    expect(icon()?.getAttribute("class")).toContain("animate-spin");
    await act(async () => resolveWorkbench(readyWorkbench()));
    await settle();
    expect(icon()?.getAttribute("class")).not.toContain("animate-spin");
  });

  it("记忆的范围是不认识的值时按「全部项目」处理", async () => {
    stubShell();
    localStorage.setItem("suduo.my.scope", JSON.stringify("project"));
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const selected = section(page, "workbench-requirements").querySelector('[aria-label="需求范围"] [data-state="on"]');
    expect(selected?.textContent).toBe("全部项目");
  });

  it("首启跳过的事留在顶部；已经有代码目录关联的那条不显示；关掉后不再出现", async () => {
    stubShell({ mappingCount: 1 });
    localStorage.setItem(
      "suduo.setup.pending",
      JSON.stringify([
        { key: "model", title: "模型服务", detail: "还没有配置模型服务地址或 API Key" },
        { key: "mapping", title: "关联本机代码目录", detail: "还没有告诉 SuDuo 项目代码在哪里" },
        { key: "bogus", title: "不认识", detail: "丢弃" },
      ]),
    );
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const checklist = section(page, "setup-checklist");
    expect(checklist.textContent).toContain("还有 1 项设置没做完");
    expect(checklist.textContent).toContain("模型服务");
    expect(checklist.textContent).not.toContain("关联本机代码目录");
    await act(async () => checklist.querySelector<HTMLButtonElement>('[aria-label="不再提示"]')?.click());
    expect(page.querySelector('[data-testid="setup-checklist"]')).toBeNull();
    expect(localStorage.getItem("suduo.setup.pending")).toBeNull();
  });

  it("没有任何关联时，代码目录那条显示，点「去关联」回到向导对应步骤", async () => {
    stubShell({ mappingCount: 0 });
    localStorage.setItem("suduo.setup.pending", JSON.stringify([{ key: "mapping", title: "关联本机代码目录", detail: "还没有关联" }]));
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue(readyWorkbench());
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    const page = await open();

    const button = [...section(page, "setup-checklist").querySelectorAll("button")].find((item) => item.textContent === "去关联");
    await act(async () => button?.click());
    await settle();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/setup?step=4");
  });
});
