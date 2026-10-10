// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDto, TrialDto, TrialEntryDto } from "@suduo/client-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 多 Agent 协作 S10 的界面：并行试做表单（未提交改动提示、选 Agent、准备命令）、比较视图（采用、确认后清理）。 */

const apiMocks = vi.hoisted(() => ({
  listLocalAgents: vi.fn(),
  trialPrecheck: vi.fn(),
  trialRepo: vi.fn(),
  startTrial: vi.fn(),
  getTrial: vi.fn(),
  adoptTrial: vi.fn(),
  cleanupTrial: vi.fn(),
  gitCheckpoint: vi.fn(),
}));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode } & Record<string, unknown>) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return (
      <a href={href} {...(rest as object)}>
        {children}
      </a>
    );
  },
}));

const { TrialForm } = await import("../src/features/trials/TrialForm.js");
const { TrialPage } = await import("../src/features/trials/TrialPage.js");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>));
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const type = async (element: HTMLElement, value: string) => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  vi.clearAllMocks();
});

const agent = (id: string, displayName: string) => ({ id, displayName, runtimeAvailable: true, enabled: true, status: "ready" }) as AgentDto;

function entry(patch: Partial<TrialEntryDto> = {}): TrialEntryDto {
  return {
    id: "e1",
    agentId: "codex",
    agentName: "Codex",
    sessionId: "s1",
    path: "/data/worktrees/p/g/codex",
    branch: "suduo/REQ-7-codex",
    state: "completed",
    setupLog: null,
    error: null,
    finalMessage: "加好了分页",
    changedFiles: [{ path: "app.js", kind: "update", additions: 3, deletions: 1 }],
    additions: 3,
    deletions: 1,
    tests: [{ command: "pnpm test", exitCode: 0 }],
    durationMs: 60_000,
    branchRemoved: false,
    pendingApprovals: 0,
    busy: false,
    adoptMode: null,
    adoptResult: null,
    cleanup: { worktree: true, branch: "delete-unmerged", gitSaid: null },
    ...patch,
  };
}

function trial(patch: Partial<TrialDto> = {}): TrialDto {
  return {
    id: "t1",
    projectId: "p",
    remoteProjectId: "proj",
    remoteRequirementId: "req-7",
    requirementLabel: "REQ-7 订单导出",
    task: "加分页",
    baseCommit: "abcdef1234567890",
    baseBranch: "main",
    setupCommand: "pnpm install",
    status: "active",
    adoptedEntryId: null,
    adoptMode: null,
    adoptResult: null,
    entries: [entry(), entry({ id: "e2", agentId: "claude-code", agentName: "Claude Code", branch: "suduo/REQ-7-claude-code", state: "running", finalMessage: null, tests: [] })],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("并行试做表单", () => {
  it("原目录有未提交改动时提示并给「先存检查点」；选两家、写任务，按记下的准备命令发起", async () => {
    apiMocks.listLocalAgents.mockResolvedValue({ defaultAgentId: "codex", agents: [agent("codex", "Codex"), agent("claude-code", "Claude Code"), agent("opencode", "OpenCode")] });
    apiMocks.trialPrecheck.mockResolvedValue({ isGitRepo: true, dirty: true, head: "abc", branch: "main", setupCommand: "pnpm install", localProjectId: "local-1" });
    apiMocks.gitCheckpoint.mockResolvedValue({ checkpoint: null });
    apiMocks.startTrial.mockResolvedValue(trial());
    const onStarted = vi.fn();
    await render(<TrialForm target={{ remoteRequirementId: "req-7" }} onBack={() => undefined} onStarted={onStarted} />);
    expect(q("trial-dirty")?.textContent).toContain("试做版本基于最近一次提交");
    await act(async () => q("trial-checkpoint")?.click());
    expect(apiMocks.gitCheckpoint).toHaveBeenCalledWith("local-1");
    expect((q("trial-setup") as HTMLInputElement).value).toBe("pnpm install");
    expect(q("trial-start")?.hasAttribute("disabled")).toBe(true);
    for (const id of ["codex", "claude-code"]) await act(async () => document.querySelector<HTMLElement>(`[data-testid="trial-agent"][data-agent-id="${id}"]`)?.click());
    await type(q("trial-task")!, "给导出加分页");
    await act(async () => q("trial-start")?.click());
    expect(apiMocks.startTrial).toHaveBeenCalledWith({
      target: { remoteRequirementId: "req-7" },
      agents: [{ agentId: "codex" }, { agentId: "claude-code" }],
      task: "给导出加分页",
      setupCommand: "pnpm install",
    });
    expect(onStarted).toHaveBeenCalledWith("t1");
  });

  it("不是 git 仓库：说明做不了，不能开始", async () => {
    apiMocks.listLocalAgents.mockResolvedValue({ defaultAgentId: "codex", agents: [agent("codex", "Codex"), agent("claude-code", "Claude Code")] });
    apiMocks.trialPrecheck.mockResolvedValue({ isGitRepo: false, dirty: false, head: null, branch: null, setupCommand: null, localProjectId: "local-1" });
    await render(<TrialForm target={{ remoteProjectId: "proj" }} onBack={() => undefined} onStarted={() => undefined} />);
    expect(q("trial-not-git")).not.toBeNull();
    for (const id of ["codex", "claude-code"]) await act(async () => document.querySelector<HTMLElement>(`[data-testid="trial-agent"][data-agent-id="${id}"]`)?.click());
    await type(q("trial-task")!, "x");
    expect(q("trial-start")?.hasAttribute("disabled")).toBe(true);
  });
});

describe("并行试做比较", () => {
  it("各版并排：状态、改动与增删、测试命令；做完的可以采用（合并 / 保留分支）", async () => {
    apiMocks.getTrial.mockResolvedValue(trial());
    apiMocks.trialRepo.mockResolvedValue({ isGitRepo: true, dirty: false, branch: "main" });
    apiMocks.adoptTrial.mockResolvedValue(trial({ status: "adopted", adoptedEntryId: "e1", adoptMode: "keep-branch", adoptResult: { kind: "kept", branch: "suduo/REQ-7-codex" } }));
    await render(<TrialPage trialId="t1" />);
    const columns = all("trial-entry");
    expect(columns.map((column) => column.getAttribute("data-state"))).toEqual(["completed", "running"]);
    expect(columns[0]!.textContent).toContain("改了 1 个文件 · +3 −1");
    expect(columns[0]!.textContent).toContain("pnpm test");
    expect(columns[1]!.querySelector('[data-testid="trial-adopt"]')).toBeNull();
    await act(async () => columns[0]!.querySelector<HTMLElement>('[data-testid="trial-adopt"]')?.click());
    await act(async () => q("trial-adopt-keep")?.click());
    await act(async () => q("trial-adopt-confirm")?.click());
    expect(apiMocks.adoptTrial).toHaveBeenCalledWith("t1", { entryId: "e1", mode: "keep-branch" });
    expect(q("trial-adopt-result")?.textContent).toContain("已保留分支 suduo/REQ-7-codex");
  });

  it("采用前说明合并到原目录现在的分支、原目录有未提交的改动、之前采用过哪一版", async () => {
    apiMocks.getTrial.mockResolvedValue(
      trial({
        status: "adopted",
        adoptedEntryId: "e2",
        entries: [
          entry(),
          entry({ id: "e2", agentId: "claude-code", agentName: "Claude Code", adoptMode: "keep-branch", adoptResult: { kind: "kept", branch: "suduo/REQ-7-claude-code" } }),
          // 合并冲突不算采用成了：不提示「已经采用过 OpenCode」。
          entry({ id: "e3", agentId: "opencode", agentName: "OpenCode", adoptMode: "merge", adoptResult: { kind: "conflict", files: ["a"], message: "x" } }),
        ],
      }),
    );
    apiMocks.trialRepo.mockResolvedValue({ isGitRepo: true, dirty: true, branch: "release" });
    await render(<TrialPage trialId="t1" />);
    await act(async () => all("trial-adopt")[0]!.click());
    for (let index = 0; index < 3; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(q("trial-adopt-dialog")?.textContent).toContain("的 release 上");
    expect(q("trial-adopt-dirty")).not.toBeNull();
    expect(q("trial-adopt-again")?.textContent).toContain("已经采用过 Claude Code");
    expect(apiMocks.trialRepo).toHaveBeenCalledWith("t1");
    expect(all("trial-entry").map((column) => column.textContent?.includes("已采用") ?? false)).toEqual([false, true, false]);
  });

  it("合并有冲突：如实告知冲突文件与怎么处理", async () => {
    apiMocks.getTrial.mockResolvedValue(trial({ status: "adopted", adoptedEntryId: "e1", adoptMode: "merge", adoptResult: { kind: "conflict", files: ["app.js"], message: "CONFLICT" } }));
    await render(<TrialPage trialId="t1" />);
    expect(q("trial-adopt-result")?.getAttribute("data-kind")).toBe("conflict");
    expect(q("trial-adopt-result")?.textContent).toContain("app.js");
    expect(q("trial-adopt-result")?.textContent).toContain("git merge --abort");
  });

  it("清理照各版的计划列出会删的目录与分支请确认（R11）：保留 / 已合并 / 没合并的提交会丢各自写明；默认勾上没采用的，还在进行的不能勾", async () => {
    apiMocks.getTrial.mockResolvedValue(
      trial({
        status: "adopted",
        adoptedEntryId: "e1",
        adoptMode: "keep-branch",
        adoptResult: { kind: "kept", branch: "suduo/REQ-7-codex" },
        entries: [
          entry({ adoptMode: "keep-branch", adoptResult: { kind: "kept", branch: "suduo/REQ-7-codex" }, cleanup: { worktree: true, branch: "keep", gitSaid: null } }),
          entry({ id: "e2", agentId: "claude-code", agentName: "Claude Code", branch: "suduo/REQ-7-claude-code", path: "/data/worktrees/p/g/claude-code" }),
          // 这一版自己做完了，但从它开的评审还在跑：服务端算出 busy。
          entry({ id: "e3", agentId: "opencode", agentName: "OpenCode", branch: "suduo/REQ-7-opencode", busy: true, cleanup: { worktree: true, branch: "delete-merged", gitSaid: null } }),
          entry({ id: "e4", agentId: "gemini", agentName: "Gemini", state: "failed", cleanup: { worktree: false, branch: "none", gitSaid: null } }),
          entry({ id: "e6", agentId: "kimi", agentName: "Kimi", state: "removed", cleanup: { worktree: false, branch: "delete-unmerged", gitSaid: "error: the branch 'x' is not fully merged" } }),
          entry({ id: "e5", agentId: "qwen", agentName: "Qwen", state: "removed", cleanup: null }),
        ],
      }),
    );
    apiMocks.cleanupTrial.mockResolvedValue(trial({ status: "adopted", entries: [entry(), entry({ id: "e2", state: "removed", branchRemoved: true, cleanup: null, error: null })] }));
    await render(<TrialPage trialId="t1" />);
    await act(async () => q("trial-cleanup")?.click());
    const plans = all("trial-cleanup-plan").map((plan) => plan.textContent ?? "");
    expect(plans).toHaveLength(5);
    expect(plans[0]).toContain("删工作目录 /data/worktrees/p/g/codex");
    expect(plans[0]).toContain("保留分支 suduo/REQ-7-codex");
    expect(plans[1]).toContain("删分支 suduo/REQ-7-claude-code（有没合并的提交，会丢）");
    expect(plans[2]).toContain("它的提交都已在当前分支里");
    expect(plans[2]).toContain("还在被用");
    expect(plans[3]).toContain("只从列表里清掉");
    expect(plans[4]).toContain("上次 git 没删这个分支：error: the branch 'x' is not fully merged");
    expect(plans[4]).toContain("强制删除分支");
    const checks = all("trial-cleanup-entry");
    expect(checks.map((check) => check.getAttribute("data-state"))).toEqual(["unchecked", "checked", "unchecked", "checked", "checked"]);
    expect(checks[2]!.hasAttribute("disabled")).toBe(true);
    await act(async () => q("trial-cleanup-confirm")?.click());
    // 只有写明「会丢」且勾上的版本允许 -D。
    expect(apiMocks.cleanupTrial).toHaveBeenCalledWith("t1", ["e2", "e4", "e6"], ["e2", "e6"]);
  });
});
