// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDto, SessionStartOptions } from "@suduo/client-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 开工选项（多 Agent S5 / S7）：交给另一个 Agent 接着做时，默认尽量不选原会话的那一家。 */

const apiMocks = vi.hoisted(() => ({ listLocalAgents: vi.fn(), agentModels: vi.fn(), getSettings: vi.fn() }));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => <a {...(rest as object)}>{children}</a>,
}));

const { StartOptions } = await import("../src/features/agents/StartOptions.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, displayName: string): AgentDto => ({
  id,
  displayName,
  vendor: "v",
  channel: id === "codex" ? "codex" : "claude",
  bundled: false,
  runtimeAvailable: true,
  enabled: true,
  status: "ready",
  reasonCode: null,
  reasonDetail: null,
  version: null,
  minVersion: null,
  verifiedVersion: null,
  executablePath: null,
  actions: [],
  capabilities: [],
  readOnlyCapable: true,
  homepageUrl: "https://x.test",
  termsUrl: null,
  checkedAt: null,
});

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
}

beforeEach(() => {
  localStorage.clear();
  apiMocks.listLocalAgents.mockResolvedValue({ defaultAgentId: "codex", agents: [agent("codex", "Codex"), agent("claude-code", "Claude Code")] });
  apiMocks.agentModels.mockResolvedValue({ items: [] });
  apiMocks.getSettings.mockResolvedValue({ defaultApprovalMode: "ask", approvalModeLocked: false, maxApprovalMode: null });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("开工选项默认选哪家", () => {
  it("没有要避开的：上次用的 → 默认（Codex）", async () => {
    const chosen: Array<(SessionStartOptions & { agentId: string }) | null> = [];
    await render(<StartOptions onChange={(options) => chosen.push(options)} onNavigate={() => undefined} />);
    expect(chosen.at(-1)?.agentId).toBe("codex");
  });

  it("交给另一个 Agent：默认换一家能用的；只有它能用时照样选它", async () => {
    const chosen: Array<(SessionStartOptions & { agentId: string }) | null> = [];
    await render(<StartOptions onChange={(options) => chosen.push(options)} onNavigate={() => undefined} avoidAgentId="codex" />);
    expect(chosen.at(-1)?.agentId).toBe("claude-code");

    await act(async () => root?.unmount());
    container?.remove();
    apiMocks.listLocalAgents.mockResolvedValue({ defaultAgentId: "codex", agents: [agent("codex", "Codex")] });
    const only: Array<(SessionStartOptions & { agentId: string }) | null> = [];
    await render(<StartOptions onChange={(options) => only.push(options)} onNavigate={() => undefined} avoidAgentId="codex" />);
    expect(only.at(-1)?.agentId).toBe("codex");
  });
});
