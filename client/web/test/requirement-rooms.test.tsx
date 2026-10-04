// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME, room, WANG, ZHANG } from "./fixtures/rooms.js";

const apiMocks = vi.hoisted(() => ({
  createRequirementRoom: vi.fn(),
  listRequirementRooms: vi.fn(),
  listUsers: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode } & Record<string, unknown>) => (
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
}));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { RequirementRooms } = await import("../src/features/rooms/sections/RequirementRooms.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const requirement = {
  id: "r1",
  projectId: "p1",
  number: 12,
  title: "订单导出",
  assignee: WANG,
  createdBy: ME,
} as unknown as RequirementListItemDto;

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
          <RequirementRooms requirement={requirement} me={ME} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiMocks.listUsers.mockResolvedValue({ items: [ME, WANG, ZHANG] });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("需求详情 · 讨论区块", () => {
  it("列出本需求的房间：未读、最后一条，点开进房间", async () => {
    apiMocks.listRequirementRooms.mockResolvedValue({
      items: [
        room({
          id: "room-9",
          kind: "requirement",
          name: "REQ-12 讨论",
          requirement: { id: "r1", number: 12, title: "订单导出" },
          viewer: { joined: true, lastReadSeq: 0, unreadCount: 3, mentionCount: 0 },
          lastMessage: { seq: 3, authorName: "小王", preview: "导出上限改成 1 万", createdAt: new Date().toISOString() },
        }),
      ],
    });
    const node = await render();
    const link = node.querySelector<HTMLAnchorElement>('[data-testid="requirement-room-link"]');
    expect(link?.getAttribute("href")).toBe("/p/p1/rooms/room-9");
    expect(link?.getAttribute("aria-label")).toBe("REQ-12 讨论，3 条未读");
    expect(link?.textContent).toContain("小王：导出上限改成 1 万");
  });

  it("最后一条按结构化字段用中文渲染（云端的兜底文字是英文）；老云端没有结构化字段时原样显示", async () => {
    const at = new Date().toISOString();
    const reqRoom = (id: string, lastMessage: NonNullable<ReturnType<typeof room>["lastMessage"]>) =>
      room({ id, kind: "requirement", name: id, requirement: { id: "r1", number: 12, title: "订单导出" }, lastMessage });
    apiMocks.listRequirementRooms.mockResolvedValue({
      items: [
        reqRoom("agent-files", {
          seq: 5,
          authorName: "小王's Codex · MacBook Pro",
          preview: "[File] 方案.pdf and 1 more",
          createdAt: at,
          authorKind: "agent",
          agent: { ownerName: "小王", deviceName: "MacBook Pro" },
          text: "",
          firstFile: { fileName: "方案.pdf", kind: "file" },
          fileCount: 2,
        }),
        reqRoom("system", { seq: 2, authorName: "System", preview: "房间已归档", createdAt: at, authorKind: "system", agent: null, text: "房间已归档", firstFile: null, fileCount: 0 }),
        reqRoom("legacy", { seq: 1, authorName: "小张", preview: "[附件] 截图.png", createdAt: at }),
      ],
    });
    const node = await render();
    const texts = [...node.querySelectorAll('[data-testid="requirement-room-link"]')].map((link) => link.textContent ?? "");
    expect(texts.find((text) => text.startsWith("agent-files"))).toContain("小王 的 Codex：[文件] 方案.pdf 等 2 个");
    expect(texts.find((text) => text.startsWith("system"))).toContain("系统：房间已归档");
    expect(texts.find((text) => text.startsWith("legacy"))).toContain("小张：[附件] 截图.png");
  });

  it("没有讨论时给出说明和「新建讨论」；查不到时说原因并给重试", async () => {
    apiMocks.listRequirementRooms.mockResolvedValueOnce({ items: [] });
    let node = await render();
    expect(node.querySelector('[data-testid="empty-state"]')?.textContent).toContain("还没有讨论");
    await act(async () => root?.unmount());
    container?.remove();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMocks.listRequirementRooms.mockRejectedValueOnce(Object.assign(new Error("down"), { status: 503 }));
    node = await render();
    expect(node.querySelector('[data-testid="region-error"]')?.textContent).toContain("查不到这条需求的讨论");
  });

  it("新建讨论：名字缺省「REQ-n 讨论」，可选拉人（负责人、创建人已在内不再列出），建好进房间", async () => {
    apiMocks.listRequirementRooms.mockResolvedValue({ items: [] });
    apiMocks.createRequirementRoom.mockResolvedValue(room({ id: "room-new", kind: "requirement", name: "REQ-12 讨论", requirement: { id: "r1", number: 12, title: "订单导出" } }));
    const node = await render();
    await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="new-requirement-room"]')?.click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[data-testid="form-dialog"]');
    const name = dialog?.querySelector<HTMLInputElement>("#new-room-name-r1");
    expect(name?.value).toBe("REQ-12 讨论");
    const people = [...(dialog?.querySelectorAll("label") ?? [])].map((label) => label.textContent?.trim()).filter((text) => text !== "名称");
    expect(people).toHaveLength(1);
    expect(people[0]).toContain("小张");
    await act(async () => dialog?.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click());
    await act(async () => dialog?.querySelector<HTMLButtonElement>('[data-testid="create-requirement-room"]')?.click());
    await settle();
    expect(apiMocks.createRequirementRoom).toHaveBeenCalledWith("r1", { name: "REQ-12 讨论", memberIds: [ZHANG.id] });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/p/$projectId/rooms/$roomId", params: { projectId: "p1", roomId: "room-new" } });
  });
});
