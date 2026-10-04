// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AGENT_RUN_CODEX_ERRORS,
  AGENT_RUN_FAILURE_CATEGORIES,
  agentRunProgressFallback,
  agentRunReasonFallback,
  readAgentRunReason,
  type AgentRunSummaryDto,
  type AgentRunTextParams,
} from "@suduo/cloud-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, run } from "./fixtures/rooms.js";

/**
 * 共享 Agent 任务的原因与进度按 code 渲染（中英双语 S6）：
 * - 中文渲染与迁移前本机 / 云端写下的中文逐字相同（下表照抄迁移前的源码）；
 * - 英文渲染与 cloud-contracts 的英文兜底逐字相同（老客户端看到的就是兜底）；
 * - 没有 code（旧数据、老版本写的）、认不出的 code、参数不对时显示文字列原文，不吞。
 */

const apiMocks = vi.hoisted(() => ({ stopAgentRun: vi.fn(), retryAgentRun: vi.fn(), getAgentRun: vi.fn() }));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { applyLocalePreference } = await import("../src/i18n/locale.js");
const { messagesFor } = await import("../src/i18n/messages/index.js");
const { RunCard, RunStatusLine } = await import("../src/features/rooms/components/RunStatusLine.js");
const { AgentRunDetail } = await import("../src/features/rooms/components/AgentRunDetail.js");
const model = await import("../src/features/rooms/model.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const zh = messagesFor("zh-CN");
const en = messagesFor("en");
const SAM = { id: "u-sam", displayName: "Sam" };
const samAgent = agent({ id: "agent-sam", owner: SAM, label: "Sam's Codex · MacBook Pro" });

/** 迁移前写下的中文（照抄 runner.ts / progress.ts / rooms/constants.ts / run-service.ts 的旧文案）。 */
const LEGACY_REASONS: Array<[code: string, params: AgentRunTextParams | null, text: string]> = [
  ["not_shared", null, "未共享到这个房间"],
  ["owner_offline", null, "所有者不在线"],
  ["share_closed", null, "共享已关闭"],
  ["share_expired", null, "共享已到期"],
  ["owner_disconnected", null, "所有者本机下线，执行中断"],
  ["stopped_by_owner", null, "所有者停止了任务"],
  ["stopped_by_requester", null, "发起人停止了任务"],
  ["no_local_folder", null, "这台电脑没有为这个项目关联代码目录"],
  ["local_folder_unavailable", { path: "/work/shop" }, "这台电脑为这个项目关联的代码目录不可用（/work/shop），需要所有者重新关联"],
  ["trigger_message_missing", null, "找不到触发这次任务的消息"],
  ["stopped_before_start", null, "开始执行前被叫停"],
  ["stopped_while_running", null, "执行中被叫停"],
  ["interrupted_locally", null, "在所有者电脑上被中断"],
  ["stalled", { minutes: 20 }, "执行中断：20 分钟没有任何进展"],
  ["local_start_failed", { detail: "会话不存在" }, "没能在本机开始执行：会话不存在"],
  ["run_error", { detail: "room not found" }, "执行失败：room not found"],
  ["reply_rejected", { detail: "远程服务拒绝了请求参数" }, "回答没能发到房间：远程服务拒绝了请求参数"],
  ["local_service_restarted", null, "执行中断（本机服务重启）"],
  ["result_not_delivered", null, "执行结果没能发回房间，详情见所有者本机的房间任务会话"],
  ["start_connection_lost", null, "开始执行时与需求服务的连接中断，这次没有执行，可以重试"],
  ["turn_failed", { codexError: "contextWindowExceeded" }, "这段对话已经超出模型的上下文窗口。可以在新话题里重新 @，或请所有者处理。"],
  ["turn_failed", { codexError: "usageLimitExceeded" }, "所有者的模型用量已经到上限，请稍后再试。"],
  ["turn_failed", { codexError: "unauthorized" }, "所有者电脑上的模型服务认证失败（401），需要所有者检查模型服务设置。"],
  ["turn_failed", { codexError: "serverOverloaded" }, "模型服务现在很忙，请稍等一会儿再重试。"],
  ["turn_failed", { codexError: "internalServerError" }, "模型服务暂时出错，请稍后重试。"],
  ["turn_failed", { codexError: "badRequest" }, "模型服务拒绝了这次请求，可能是参数或附件不被支持。"],
  ["turn_failed", { codexError: "sandboxError" }, "命令没能在只读沙箱里运行。"],
  ["turn_failed", { codexError: "rateLimitExceeded" }, "模型服务限流了，请稍等几分钟再重试。"],
  ["turn_failed", { codexError: "misalignmentPolicyViolation" }, "这次请求触发了模型服务的安全策略，已停止。可以换个说法再试。"],
  ["turn_failed", { codexError: "sessionBudgetExceeded" }, "这个话题的用量预算已经用完，可以在新话题里重新 @。"],
  ["turn_failed", { codexError: "cyberPolicy" }, "请求涉及网络安全相关内容，被模型服务的安全策略拦下了。"],
  ["turn_failed", { category: "rate_limited" }, "模型服务限流（429），请稍等几分钟再重试。"],
  ["turn_failed", { category: "unauthorized" }, "所有者电脑上的模型服务认证失败（401），需要所有者检查模型服务设置。"],
  ["turn_failed", { category: "forbidden" }, "模型服务拒绝了请求（403），所有者的凭证可能没有权限使用这个模型。"],
  ["turn_failed", { category: "server_error" }, "模型服务暂时出错，请稍后重试。"],
  ["turn_failed", { category: "timeout" }, "模型服务响应超时，请稍后重试。"],
  ["turn_failed", { detail: "disk full boom" }, "执行失败：disk full boom"],
  ["turn_failed", null, "执行失败，原因未知。"],
];

const reasonRun = (code: string | null, params: AgentRunTextParams | null, reason = "fallback text") =>
  run({ status: "failed", reason, reasonCode: code, reasonParams: params });

describe("任务原因按 code 渲染", () => {
  it("覆盖全部 code、Codex 错误码与归类", () => {
    const covered = new Set(LEGACY_REASONS.map(([code, params]) => `${code}:${JSON.stringify(params)}`));
    for (const error of AGENT_RUN_CODEX_ERRORS) expect(covered.has(`turn_failed:${JSON.stringify({ codexError: error })}`)).toBe(true);
    for (const category of AGENT_RUN_FAILURE_CATEGORIES) {
      expect(covered.has(`turn_failed:${JSON.stringify({ category })}`)).toBe(true);
    }
  });

  it.each(LEGACY_REASONS)("中文与迁移前逐字相同：%s %j", (code, params, text) => {
    expect(model.runReasonText(reasonRun(code, params), zh)).toBe(text);
  });

  it.each(LEGACY_REASONS)("英文与兜底文字逐字相同：%s %j", (code, params) => {
    const reason = readAgentRunReason(code, params);
    expect(reason).not.toBeNull();
    const fallback = agentRunReasonFallback(reason!.code, reason!.params);
    expect(model.runReasonText(reasonRun(code, params), en)).toBe(fallback);
  });

  it("英文措辞抽查", () => {
    expect(model.runReasonText(reasonRun("owner_offline", null), en)).toBe("The owner is offline");
    expect(model.runReasonText(reasonRun("stalled", { minutes: 1 }), en)).toBe("Run interrupted: no progress for 1 minute");
    expect(model.runReasonText(reasonRun("stalled", { minutes: 20 }), en)).toBe("Run interrupted: no progress for 20 minutes");
    expect(model.runReasonText(reasonRun("reply_rejected", { detail: "The server rejected the request" }), en)).toBe(
      "Couldn't post the answer to the room: The server rejected the request",
    );
  });

  it("旧数据（没有 code）、认不出的 code、参数不对：显示原文，不吞", () => {
    expect(model.runReasonText(run({ status: "failed", reason: "所有者本机下线，执行中断" }), en)).toBe("所有者本机下线，执行中断");
    expect(model.runReasonText(reasonRun(null, null, "Old text"), zh)).toBe("Old text");
    expect(model.runReasonText(reasonRun("future_reason", { x: 1 }, "Something new happened"), zh)).toBe("Something new happened");
    // 参数缺了、类型不对、取值认不出：退回原文。
    expect(model.runReasonText(reasonRun("stalled", null, "Run interrupted"), zh)).toBe("Run interrupted");
    expect(model.runReasonText(reasonRun("stalled", { minutes: "20" }, "Run interrupted"), zh)).toBe("Run interrupted");
    expect(model.runReasonText(reasonRun("turn_failed", { codexError: "newCodexError" }, "New failure"), zh)).toBe("New failure");
    // 多出来的参数忽略。
    expect(model.runReasonText(reasonRun("owner_offline", { extra: "x" }), zh)).toBe("所有者不在线");
    expect(model.runReasonText(run({ status: "offline", reason: null }), zh)).toBeNull();
  });
});

describe("任务进度按 code 渲染", () => {
  const progressRun = (code: string | null, params: AgentRunTextParams | null, progress = "fallback") =>
    run({ status: "running", progress, progressCode: code, progressParams: params });

  it("中文与迁移前逐字相同（与会话时间线的步骤组摘要同一套说法）", () => {
    expect(model.runProgressText(progressRun("thinking", null), zh)).toBe("正在思考");
    expect(model.runProgressText(progressRun("activity", { read: 6, command: 2 }), zh)).toBe("查看了 6 个文件 · 运行了 2 条命令");
    expect(
      model.runProgressText(progressRun("activity", { web: 1, tool: 3, command: 2, list: 4, search: 5, read: 6 }), zh),
    ).toBe("查看了 6 个文件 · 搜索了 5 次 · 列了 4 个目录 · 运行了 2 条命令 · 调用了 3 次工具 · 搜索了 1 次网页");
  });

  it("英文与兜底文字逐字相同", () => {
    expect(model.runProgressText(progressRun("thinking", null), en)).toBe(agentRunProgressFallback("thinking", {}));
    const counts = { read: 1, search: 2, list: 1, command: 2, tool: 1, web: 3 };
    expect(model.runProgressText(progressRun("activity", counts), en)).toBe(agentRunProgressFallback("activity", counts));
    expect(model.runProgressText(progressRun("activity", { read: 6, command: 1 }), en)).toBe("Read 6 files · Ran 1 command");
  });

  it("旧数据、认不出的 code、没有有效计数：显示原文", () => {
    expect(model.runProgressText(run({ status: "running", progress: "查看了 6 个文件" }), en)).toBe("查看了 6 个文件");
    expect(model.runProgressText(progressRun("future_progress", { edits: 2 }, "Edited 2 files"), zh)).toBe("Edited 2 files");
    expect(model.runProgressText(progressRun("activity", { edits: 2 }, "Edited 2 files"), zh)).toBe("Edited 2 files");
    // 多出来的种类忽略，认得的照常渲染。
    expect(model.runProgressText(progressRun("activity", { read: 2, edits: 2 }), zh)).toBe("查看了 2 个文件");
  });

  it("状态行文字：按 code 渲染进度与原因", () => {
    expect(model.runStatusText(progressRun("activity", { read: 6 }), zh)).toBe("执行中 · 查看了 6 个文件");
    expect(model.runStatusText(progressRun("activity", { read: 6 }), en)).toBe("Running · Read 6 files");
    expect(model.runStatusText(run({ status: "offline", reason: "Not shared to this room", reasonCode: "not_shared" }), zh)).toBe(
      "离线，未执行 · 未共享到这个房间",
    );
    expect(model.runStatusText(run({ status: "failed", reason: "x", reasonCode: "owner_disconnected" }), en)).toBe(
      "Failed · The owner's computer went offline, so the run was interrupted",
    );
    expect(model.runStatusText(run({ status: "stopped", reason: "已停止" }), en)).toBe("Stopped · 已停止");
  });
});

describe("界面：状态行、状态卡与运行详情（英文）", () => {
  let client: QueryClient;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  async function render(element: ReactElement): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <TooltipProvider>{element}</TooltipProvider>
        </QueryClientProvider>,
      ),
    );
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    return container;
  }

  const q = (node: ParentNode, id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    localStorage.clear();
    applyLocalePreference("en");
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.clearAllMocks();
    applyLocalePreference("system");
    localStorage.clear();
  });

  it("状态行与状态卡按 code 用英文说，原文是中文的旧数据照原文", async () => {
    const running: AgentRunSummaryDto = run({
      agent: samAgent,
      status: "running",
      progress: "Read 6 files · Ran 2 commands",
      progressCode: "activity",
      progressParams: { read: 6, command: 2 },
    });
    let node = await render(<RunStatusLine run={running} meId={null} onOpen={vi.fn()} />);
    expect(q(node, "run-status")?.querySelector("button")?.textContent).toBe("Sam's Codex·Running · Read 6 files · Ran 2 commands");
    await act(async () => root?.unmount());
    container?.remove();

    const failed = run({
      agent: samAgent,
      status: "failed",
      reason: "The run failed: disk full",
      reasonCode: "turn_failed",
      reasonParams: { codexError: "usageLimitExceeded" },
    });
    node = await render(<RunCard run={failed} meId={null} onViewDetail={vi.fn()} />);
    expect(q(node, "run-card")?.textContent).toContain("The owner has reached their model usage limit. Try again later.");
    await act(async () => root?.unmount());
    container?.remove();

    node = await render(<RunCard run={run({ agent: samAgent, status: "failed", reason: "所有者本机下线，执行中断" })} meId={null} onViewDetail={vi.fn()} />);
    expect(q(node, "run-card")?.textContent).toContain("所有者本机下线，执行中断");
  });

  it("运行详情：离线说明按 code 渲染；没有原因时用通用说明", async () => {
    apiMocks.getAgentRun.mockResolvedValue({
      ...run({ agent: samAgent, status: "offline", reason: "The owner is offline", reasonCode: "owner_offline" }),
      events: [],
    });
    let node = await render(<AgentRunDetail runId="run-1" onBack={vi.fn()} />);
    expect(q(node, "run-detail")?.textContent).toContain("The owner is offline");
    await act(async () => root?.unmount());
    container?.remove();

    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMocks.getAgentRun.mockResolvedValue({ ...run({ agent: samAgent, status: "offline", reason: null }), events: [] });
    node = await render(<AgentRunDetail runId="run-1" onBack={vi.fn()} />);
    expect(q(node, "run-detail")?.textContent).toContain("The owner was offline or not sharing, so this didn't run.");
  });

  it("运行详情（中文）：离线说明按 code 渲染成迁移前的中文", async () => {
    applyLocalePreference("zh-CN");
    apiMocks.getAgentRun.mockResolvedValue({
      ...run({ agent: samAgent, status: "offline", reason: "Not shared to this room", reasonCode: "not_shared" }),
      events: [],
    });
    const node = await render(<AgentRunDetail runId="run-1" onBack={vi.fn()} />);
    expect(q(node, "run-detail")?.textContent).toContain("未共享到这个房间");
    expect(q(node, "run-detail")?.textContent).not.toContain("Not shared to this room");
  });
});
