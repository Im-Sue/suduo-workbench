// @vitest-environment jsdom

import type { AgentDto, ApprovalDto } from "@suduo/client-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { isUsable, preferredAgent } from "../src/features/agents/queries.js";
import { needsAgentChoice } from "../src/features/agents/StartOptions.js";
import { ApprovalDock, approvalChoices } from "../src/features/sessions/ApprovalDock.js";

/** 多 Agent S5：开工选 Agent 的规则、按选项出的审批按钮（需求 4.2、4.3）。 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, status: AgentDto["status"], extra: Partial<AgentDto> = {}): AgentDto => ({
  id,
  displayName: id,
  vendor: "v",
  channel: "acp",
  bundled: false,
  runtimeAvailable: true,
  enabled: true,
  status,
  reasonCode: null,
  reasonDetail: null,
  version: null,
  minVersion: null,
  verifiedVersions: [],
  versionVerified: null,
  executablePath: null,
  actions: [],
  capabilities: [],
  readOnlyCapable: false,
  homepageUrl: "https://x.test",
  termsUrl: null,
  checkedAt: null,
  ...extra,
});

describe("开工默认选哪家 Agent、要不要先选", () => {
  const list = [agent("codex", "ready"), agent("claude-code", "ready"), agent("gemini", "auth_required"), agent("cursor", "not_installed"), agent("opencode", "installed", { enabled: false })];

  it("只能选能用的：就绪或已安装、已接上、没停用", () => {
    expect(list.filter(isUsable).map((item) => item.id)).toEqual(["codex", "claude-code"]);
  });

  it("上次用的（还能用）→ 设置里的默认 → 第一家能用的", () => {
    expect(preferredAgent(list, "codex", "claude-code")?.id).toBe("claude-code");
    expect(preferredAgent(list, "codex", "gemini")?.id).toBe("codex");
    expect(preferredAgent(list, "cursor", null)?.id).toBe("codex");
    expect(preferredAgent([agent("gemini", "auth_required")], "gemini", null)).toBeNull();
  });

  it("能用（或还在检测）的不止一家才先问；只有一家就直接开工", () => {
    expect(needsAgentChoice(list)).toBe(true);
    expect(needsAgentChoice([agent("codex", "ready"), agent("gemini", "auth_required")])).toBe(false);
    expect(needsAgentChoice([agent("codex", "ready"), agent("claude-code", "checking")])).toBe(true);
  });
});

describe("审批卡按卡上的选项出按钮", () => {
  it("没有选项的老卡：同意、拒绝，更多里是本会话同意与拒绝并停止；不带选项 id", () => {
    const choices = approvalChoices({ request: {} });
    expect(choices.accept).toEqual({ id: undefined, decision: "accept" });
    expect(choices.decline).toEqual({ id: undefined, decision: "decline" });
    expect(choices.more.map((choice) => choice.decision)).toEqual(["acceptForSession", "cancel"]);
  });

  it("ACP 的选项：始终同意 / 始终拒绝收进更多；没给本会话同意就不出现", () => {
    const choices = approvalChoices({
      options: [
        { id: "allow-once", decision: "accept" },
        { id: "allow-always", decision: "acceptAlways" },
        { id: "reject-once", decision: "decline" },
        { id: "cancel", decision: "cancel" },
        { id: "weird", decision: "nope" },
      ],
    });
    expect(choices.accept?.id).toBe("allow-once");
    expect(choices.decline?.id).toBe("reject-once");
    expect(choices.more.map((choice) => choice.id)).toEqual(["allow-always", "cancel"]);
  });

  it("保留 Agent 给选项起的名字（同为「始终同意」的两项能分开）", () => {
    const choices = approvalChoices({
      options: [
        { id: "allow-tool", decision: "acceptAlways", label: "Always allow this tool" },
        { id: "allow-server", decision: "acceptAlways", label: "Always allow this server" },
      ],
    });
    expect(choices.more.map((choice) => choice.label)).toEqual(["Always allow this tool", "Always allow this server"]);
  });

  it("点更多里的「始终同意」带上 Agent 的选项 id；回车批准也带", async () => {
    const card = {
      id: "ap-1",
      sessionId: "s1",
      threadRef: { runtimeId: "acp-gemini", runtimeKind: "acp", threadId: "t" },
      turnRef: null,
      kind: "command",
      status: "pending",
      decision: null,
      request: {
        request: { command: "rm -rf build" },
        options: [
          { id: "allow-once", decision: "accept" },
          { id: "allow-always", decision: "acceptAlways" },
          { id: "reject-once", decision: "decline" },
          { id: "cancel", decision: "cancel" },
        ],
      },
      requestedAt: 1,
      decidedAt: null,
      version: 1,
    } as unknown as ApprovalDto;
    const onDecide = vi.fn().mockResolvedValue(undefined);
    const host = document.body.appendChild(document.createElement("div"));
    let root: Root | null = createRoot(host);
    await act(async () => root?.render(<TooltipProvider><ApprovalDock approvals={[card]} onDecide={onDecide} /></TooltipProvider>));
    const dock = host.querySelector('[data-testid="approval-card"]');
    await act(async () => {
      dock?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-1" }), "accept", "allow-once");
    expect(host.querySelector('[data-testid="approval-more"]')).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    host.remove();
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});
