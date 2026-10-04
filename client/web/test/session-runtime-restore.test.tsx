// @vitest-environment jsdom

import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, GitCheckpointDto, JsonValue, SessionDto } from "@suduo/client-contracts";

const apiMocks = vi.hoisted(() => ({
  backfillSessionEvents: vi.fn(),
  getSession: vi.fn(),
  getSettings: vi.fn(),
  listApprovals: vi.fn(),
  listChanges: vi.fn(),
  listFiles: vi.fn(),
  getSessionContext: vi.fn(),
  listRequirementAttachments: vi.fn(),
  readFile: vi.fn(),
  decideApproval: vi.fn(),
  requirementAttachmentDownloadUrl: (id: string) => `/api/v2/attachments/${id}/content`,
  listProjects: vi.fn(),
  listSkills: vi.fn(),
  modelProvider: vi.fn(),
  openTargets: vi.fn(),
  interrupt: vi.fn(),
  sendMessage: vi.fn(),
  getRequirement: vi.fn(),
  gitStatus: vi.fn(),
  gitCheckpoints: vi.fn(),
  gitRestore: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  loadEventCache: vi.fn(),
  loadEventCacheStart: vi.fn(),
  saveEventCache: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  getInflightCount: () => 0,
  subscribeInflight: () => () => undefined,
}));
vi.mock("../src/event-projection/cache.js", () => cacheMocks);
vi.mock("../src/components/MonacoView.js", async () => {
  const { createElement } = await import("react");
  return { MonacoView: () => createElement("div") };
});
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));

import { SessionRuntime } from "../src/app/SessionRuntime.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 「回到这一轮开始前？」确认框：不是这一轮自己的自动存档时，按检查点类型显示名称（与环境面板一致），
 * 不再原样显示本机服务写入时的提交标题。
 */
class MockEventSource {
  addEventListener(): void {}
  close(): void {}
  onerror: (() => void) | null = null;
}

const TURN_START = 1_700_000_000_000;

function envelope(seq: number, type: string, payload: JsonValue): EventEnvelope<string, JsonValue> {
  return {
    schemaVersion: 1, seq, eventId: `evt-${String(seq)}`, sessionId: "s1", source: "runtime:codex-local",
    type, payload, threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "t1" },
    turnRef: { threadId: "t1", turnId: "T1" }, ts: TURN_START + (seq - 1) * 1_000,
  };
}

/** 一轮改了一个文件的完整回合（从 seq 1 起全在缓存里，不需要回填）。 */
const TURN_EVENTS = [
  envelope(1, "turn.started", { turn: { id: "T1" } }),
  envelope(2, "item.completed", {
    item: { id: "fc-1", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", kind: { type: "add" }, diff: "x\n" }] },
  }),
  envelope(3, "turn.completed", { turn: { id: "T1", status: "completed" } }),
];

function session(): SessionDto {
  return {
    id: "s1", projectId: "p1", title: "Session", state: "active", purpose: "general", approvalMode: "ask",
    createdAt: 1, updatedAt: 1, lastActivityAt: null, version: 1, threads: [],
  };
}

function checkpoint(patch: Partial<GitCheckpointDto>): GitCheckpointDto {
  return { hash: "abc1234", subject: "", ts: TURN_START - 10 * 60_000, auto: false, kind: null, note: null, ...patch };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<TooltipProvider>{element}</TooltipProvider>));
  return container;
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 点回合末尾的「回到开始前」，返回确认框里的说明。 */
async function openRestoreDialog(items: GitCheckpointDto[]): Promise<string> {
  apiMocks.gitCheckpoints.mockResolvedValue({ items });
  const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
  await settle();
  const label = messagesFor(document.documentElement.lang === "en" ? "en" : "zh-CN").conversation.turn.restoreBefore;
  const button = [...node.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await settle();
  const dialog = document.querySelector<HTMLElement>("[role='alertdialog'], [role='dialog']");
  expect(dialog).not.toBeNull();
  return dialog?.textContent ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
  cacheMocks.loadEventCache.mockReturnValue(TURN_EVENTS);
  cacheMocks.loadEventCacheStart.mockReturnValue(null);
  apiMocks.backfillSessionEvents.mockResolvedValue([]);
  apiMocks.getSession.mockResolvedValue(session());
  apiMocks.getSettings.mockResolvedValue({ approvalModeLocked: false });
  apiMocks.listApprovals.mockResolvedValue({ items: [] });
  apiMocks.listChanges.mockResolvedValue({ items: [], additions: 0, deletions: 0 });
  apiMocks.listFiles.mockResolvedValue({ entries: [] });
  apiMocks.getSessionContext.mockResolvedValue({ sessionId: "s1", kind: "project", contextMode: "tools", remoteProjectId: null, requirement: null });
  apiMocks.listProjects.mockResolvedValue({ items: [] });
  apiMocks.listSkills.mockResolvedValue({ items: [] });
  apiMocks.gitStatus.mockResolvedValue({ available: false, repo: false, branch: null, dirty: 0, autoCheckpoint: false });
  apiMocks.modelProvider.mockResolvedValue(null);
  apiMocks.openTargets.mockResolvedValue({ targets: ["open"] });
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  applyLocalePreference("system");
});

describe("「回到这一轮开始前？」里的检查点名称", () => {
  it("中文：按类型显示，不再显示提交标题原文", async () => {
    const text = await openRestoreDialog([
      checkpoint({ subject: "SuDuo checkpoint: Draft done", kind: "manual", note: "Draft done" }),
    ]);
    expect(text).toContain("最近的是「检查点：Draft done」");
    expect(text).not.toContain("SuDuo checkpoint");
  });

  it("英文：中文写下的自动存档显示为英文名称", async () => {
    applyLocalePreference("en");
    const text = await openRestoreDialog([
      checkpoint({ subject: "SuDuo 自动存档：回合开始前", kind: "turn-start", auto: true }),
    ]);
    expect(text).toContain("The closest one is “Auto-saved before turn”");
    expect(text).not.toContain("自动存档");
  });

  it("英文：手动检查点显示说明；不是检查点的普通提交仍显示提交标题", async () => {
    applyLocalePreference("en");
    const manual = await openRestoreDialog([
      checkpoint({ subject: "SuDuo 检查点：修复登录", kind: "manual", note: "修复登录" }),
    ]);
    expect(manual).toContain("The closest one is “Checkpoint: 修复登录”");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    const plain = await openRestoreDialog([checkpoint({ subject: "Fix login redirect" })]);
    expect(plain).toContain("The closest one is “Fix login redirect”");
  });
});
