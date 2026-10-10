// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EventEnvelope, JsonValue, SessionDto, SessionListItemDto, SessionStartOptions } from "@suduo/client-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 会话之间的关系（多 Agent 协作 S7）：读取步骤、消息里的会话标签、接续横幅、会话树、接着做。 */

const navigateMock = vi.hoisted(() => vi.fn());
const apiMocks = vi.hoisted(() => ({ getSession: vi.fn(), continueSession: vi.fn() }));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode } & Record<string, unknown>) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  useNavigate: () => navigateMock,
}));
// 开工选项另有测试：这里直接给一个选好的结果。
vi.mock("../src/features/agents/StartOptions.js", async () => {
  const { useEffect } = await import("react");
  return {
    StartOptions: ({ onChange }: { onChange(options: SessionStartOptions & { agentId: string }): void }) => {
      useEffect(() => onChange({ agentId: "claude-code", approvalMode: "auto" }), [onChange]);
      return <div data-testid="start-options" />;
    },
  };
});

const { sessionReadRef, sessionReadViewLabel } = await import("../src/event-projection/suduo-tools.js");
const { buildTimeline } = await import("../src/event-projection/timeline.js");
const { messagesFor } = await import("../src/i18n/messages/index.js");
const { ContinueSessionDialog, SessionLinksBar, SessionReadTitle, TextWithSessionLinks, sessionLinkText, takePendingDraft } = await import(
  "../src/features/sessions/session-links.js"
);
const { nestByParent } = await import("../src/features/sessions/session-list.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = "0b7e1a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const zh = messagesFor("zh-CN");
const en = messagesFor("en");

function sessionFixture(patch: Partial<SessionDto> = {}): SessionDto {
  return {
    id: SOURCE,
    projectId: "p1",
    title: "导出接口",
    state: "active",
    purpose: "general",
    approvalMode: "ask",
    model: null,
    reasoningEffort: null,
    kind: "normal",
    agentId: "claude-code",
    agent: { displayName: "Claude Code", readOnlyCapable: true, capabilities: [] },
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    version: 1,
    threads: [],
    ...patch,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

beforeEach(() => {
  apiMocks.getSession.mockResolvedValue(sessionFixture());
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("Agent 读另一个会话的步骤", () => {
  it("认出 session_read 的参数与层，说法按语言", () => {
    expect(sessionReadRef("suduo_session_read", { sessionId: SOURCE })).toEqual({ sessionId: SOURCE, view: "summary", number: null });
    expect(sessionReadRef("suduo_session_read", JSON.stringify({ sessionId: SOURCE, view: "conversation" }))).toEqual({ sessionId: SOURCE, view: "conversation", number: 3 });
    const turn = sessionReadRef("suduo_session_read", { sessionId: SOURCE, view: "turn", turn: "2" })!;
    expect(sessionReadViewLabel(turn, zh)).toBe("第 2 回合");
    expect(sessionReadViewLabel(turn, en)).toBe("turn 2");
    expect(sessionReadViewLabel({ sessionId: SOURCE, view: "conversation", number: 1 }, en)).toBe("last exchange");
    expect(sessionReadRef("suduo_requirement_get", { sessionId: SOURCE })).toBeNull();
    expect(sessionReadRef("suduo_session_read", {})).toBeNull();
  });

  it("时间线：读取会话的工具步骤带上读的哪个会话；显示「读取了 Agent ·「标题」· 层」", async () => {
    const events: Array<EventEnvelope<string, JsonValue>> = [
      { seq: 1, eventId: "e1", sessionId: "s", source: "runtime", type: "turn.started", payload: { turn: { id: "t1" } }, threadRef: null, turnRef: { threadId: "th", turnId: "t1" }, ts: 1 },
      {
        seq: 2,
        eventId: "e2",
        sessionId: "s",
        source: "runtime",
        type: "item.completed",
        payload: { item: { id: "x", type: "dynamicToolCall", tool: "suduo_session_read", arguments: { sessionId: SOURCE, view: "conversation", rounds: 2 }, success: true, contentItems: [] } },
        threadRef: null,
        turnRef: { threadId: "th", turnId: "t1" },
        ts: 2,
      },
    ];
    const { timeline } = buildTimeline(events, [], new Map(), zh);
    const turn = timeline.find((entry) => entry.kind === "turn");
    const steps = turn?.kind === "turn" ? turn.turn.blocks.flatMap((block) => (block.kind === "steps" ? block.steps : [])) : [];
    expect(steps[0]).toMatchObject({ title: "读取会话", sessionRead: { sessionId: SOURCE, view: "conversation", number: 2 } });

    const node = await render(<SessionReadTitle read={steps[0]!.sessionRead!} />);
    expect(node.textContent).toBe("读取了 Claude Code ·「导出接口」· 最近 2 轮");
    expect(apiMocks.getSession).toHaveBeenCalledWith(SOURCE);
  });

  it("读的会话取不到（已删除等）：只说读了一个会话", async () => {
    apiMocks.getSession.mockRejectedValue(new Error("404"));
    const node = await render(<SessionReadTitle read={{ sessionId: SOURCE, view: "changes", number: null }} />);
    expect(node.textContent).toBe("读取了一个会话 · 累计改动");
  });
});

describe("消息里的会话引用", () => {
  it("插进输入框的写法：方括号去掉，链接是句柄", () => {
    expect(sessionLinkText({ id: SOURCE, title: "导出[接口]" })).toBe(`[导出 接口](suduo://session/${SOURCE})`);
  });

  it("会话标签：显示 Agent 与会话名，点开是那个会话；没有句柄的文字原样", async () => {
    const node = await render(<TextWithSessionLinks text={`接着 [旧标题](suduo://session/${SOURCE}) 继续：做前端`} />);
    const chip = node.querySelector<HTMLAnchorElement>('[data-testid="session-chip"]');
    expect(chip?.getAttribute("href")).toBe(`/sessions/${SOURCE}`);
    expect(chip?.textContent).toBe("Claude Code · 导出接口");
    expect(node.textContent).toBe("接着 Claude Code · 导出接口 继续：做前端");
    const plain = await render(<TextWithSessionLinks text="普通消息" />);
    expect(plain.textContent).toBe("普通消息");
  });
});

describe("接续关系", () => {
  it("会话页顶部互相显示：接续自、已由谁接着做；已删除的不给链接", async () => {
    const node = await render(
      <SessionLinksBar
        links={{
          continuedFrom: { id: SOURCE, title: "导出接口", agentId: "claude-code", agentName: "Claude Code", state: "active" },
          continuedBy: [{ id: "next", title: "前端页面", agentId: "gemini", agentName: "Gemini CLI", state: "deleted" }],
        }}
      />,
    );
    expect(node.querySelector('[data-testid="session-continued-from"]')?.textContent).toBe("接续自Claude Code ·「导出接口」");
    expect(node.querySelector('[data-testid="session-continued-from"] a')?.getAttribute("href")).toBe(`/sessions/${SOURCE}`);
    expect(node.querySelector('[data-testid="session-continued-by"]')?.textContent).toBe("已由这些会话接着做Gemini CLI ·「前端页面」（已删除）");
    const empty = await render(<SessionLinksBar links={{ continuedFrom: null, continuedBy: [] }} />);
    expect(empty.querySelector('[data-testid="session-links-bar"]')).toBeNull();
  });

  it("会话树：接着做出来的会话紧跟在父会话后面；父会话不在这一组的照常排", () => {
    const item = (id: string, parentSessionId: string | null = null) => ({ id, parentSessionId, relation: parentSessionId === null ? null : "continue" }) as unknown as SessionListItemDto;
    const ordered = nestByParent([item("c", "a"), item("b"), item("a"), item("d", "missing")]);
    expect(ordered.map(({ item: entry, nested }) => `${entry.id}${nested ? "↳" : ""}`)).toEqual(["b", "a", "c↳", "d"]);
  });

  it("接着做：选好 Agent 后开新会话、跳过去，新会话预填「接着 @原会话 继续：」（不自动发出）", async () => {
    apiMocks.continueSession.mockResolvedValue(sessionFixture({ id: "next-session", title: "导出接口", agentId: "claude-code" }));
    const onOpenChange = vi.fn();
    await render(<ContinueSessionDialog session={sessionFixture({ agentId: "codex", agent: undefined })} open onOpenChange={onOpenChange} />);
    const start = document.querySelector<HTMLButtonElement>('[data-testid="continue-session-start"]');
    expect(start?.disabled).toBe(false);
    await act(async () => start?.click());
    expect(apiMocks.continueSession).toHaveBeenCalledWith(SOURCE, { agentId: "claude-code", approvalMode: "auto" });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/sessions/$sessionId", params: { sessionId: "next-session" } });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(takePendingDraft("next-session")).toBe(`接着 [导出接口](suduo://session/${SOURCE}) 继续：`);
    expect(takePendingDraft("next-session")).toBeNull();
  });

  it("接着做失败：对话框里说明原因，不跳转", async () => {
    apiMocks.continueSession.mockRejectedValue(new Error("Claude Code 还没登录"));
    await render(<ContinueSessionDialog session={sessionFixture()} open onOpenChange={vi.fn()} />);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="continue-session-start"]')?.click());
    expect(document.querySelector('[data-testid="inline-error"]')?.textContent).toContain("没能开新会话");
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
