import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import type { AgentListDto, AgentSettingsDto, DelegationDto, ReviewDto, SessionDto, TrialDto } from "@suduo/client-contracts";
import { capture } from "./helpers.js";
import type { GateCStep } from "./types.js";

/**
 * 多 Agent「模拟示例」（多 Agent S12）：用走剧本的假 ACP Agent（占配置表里一家的位置，默认 OpenCode，
 * `SUDUO_GATE_WALKTHROUGH_AGENT` 可换）在真实的本机服务上走一遍——引用另一个会话、委派并等结果、请评审并把意见交回、
 * 并行试做两版后保留一版分支并清理。假 Agent 经 SuDuo 本机工具服务（MCP）真调工具，验的是 SuDuo 这一侧的链路；
 * 各家真实 Agent 的冒烟在装好对应 CLI 的机器上发布前手动跑。放在最后：要把项目目录变成 git 仓库（并行试做需要）。
 */
const FAKE_AGENT = fileURLToPath(new URL("../../fixtures/fake-script-agent.mjs", import.meta.url));
const TIMEOUT_MS = 90_000;

export const multiAgentWalkthroughStep: GateCStep = {
  id: "multi-agent-walkthrough",
  async run(context) {
    const page = context.page;
    const projectId = context.remoteProjectId;
    if (projectId === null) throw new Error("multi-agent walkthrough needs the remote project from v2-user-path");
    const slot = process.env["SUDUO_GATE_WALKTHROUGH_AGENT"] ?? "opencode";

    // 0. 假 Agent 放进配置表一家的位置（路径覆盖，经 SuDuo 自己的检测）。
    const wrapper = resolve(context.artifactRoot, "fake-script-agent.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    // 假 Agent 说的是 ACP：只能占 ACP 那几家的位置（Claude 走官方 SDK，Codex 是自带的）。
    const catalog = await api<AgentListDto>(page, "GET", "/api/v1/agents");
    if (catalog.agents.find((entry) => entry.id === slot)?.channel !== "acp") throw new Error(`SUDUO_GATE_WALKTHROUGH_AGENT must name an ACP agent, got ${slot}`);
    // 记下原来的路径覆盖，走完放回去（gate 部署的审批上限低于 full，假 Agent 本来也不请求权限，用 auto）。
    const before = await api<AgentSettingsDto>(page, "GET", "/api/v1/settings/agents");
    const previous = before.agents.find((entry) => entry.id === slot) ?? null;
    await api(page, "PUT", "/api/v1/settings/agents", { agents: [{ id: slot, binOverride: wrapper, enabled: true }] });
    try {
      const agent = await api<{ status: string }>(page, "POST", `/api/v1/agents/${slot}/recheck`, {});
      if (agent.status !== "installed" && agent.status !== "ready") throw new Error(`fake agent not usable in slot ${slot}: ${agent.status}`);
      const newSession = () => api<SessionDto>(page, "POST", `/api/v2/projects/${projectId}/sessions`, { agentId: slot, approvalMode: "auto" });
      const send = (sessionId: string, text: string) => api(page, "POST", `/api/v1/sessions/${sessionId}/messages`, { content: [{ type: "text", text }] });

      // 1. 引用：会话 A 做完接口，会话 B 用 session_read 读 A。
      const a = await newSession();
      await send(a.id, "@say 导出接口：GET /export?month=2026-10");
      await waitRounds(page, a.id, 1);
      const b = await newSession();
      await send(b.id, `@call suduo_session_read {"sessionId":"${a.id}","view":"summary"}`);
      await waitRounds(page, b.id, 1);

      // 2. 委派：B 把补测试交给同一家的另一个会话，等它做完拿结果。
      await send(b.id, `@call suduo_delegate_start {"agentId":"${slot}","task":"@say 集成测试补好了"}\n@call suduo_delegate_wait {"delegationId":"$ID","maxSeconds":60}`);
      await waitRounds(page, b.id, 2);
      const delegations = (await api<{ items: DelegationDto[] }>(page, "GET", `/api/v1/sessions/${b.id}/delegations`)).items;
      if (delegations.length !== 1 || delegations[0]!.status !== "completed" || delegations[0]!.result?.finalMessage !== "集成测试补好了") {
        throw new Error(`delegation did not complete with the child's answer: ${JSON.stringify(delegations.map((item) => [item.status, item.result?.finalMessage]))}`);
      }

      // 3. 评审：请同一家只读评审（说明里写好它交回的意见），把意见交回 B。
      const review = await api<ReviewDto>(page, "POST", `/api/v1/sessions/${b.id}/reviews`, {
        agentId: slot,
        note: '@call suduo_review_submit {"findings":[{"severity":"high","file":"src/export.ts","line":3,"title":"空月份没处理","detail":"month 为空时会抛异常"}],"summary":"一处要改"}',
      });
      const submitted = await poll(async () => {
        const current = (await api<{ items: ReviewDto[] }>(page, "GET", `/api/v1/sessions/${b.id}/reviews`)).items.find((item) => item.id === review.id);
        return current !== undefined && current.status !== "queued" && current.status !== "running" ? current : null;
      }, "review");
      if (submitted.status !== "submitted" || submitted.findings.length !== 1) throw new Error(`review not submitted: ${submitted.status}`);
      await api(page, "POST", `/api/v1/reviews/${review.id}/apply`, { findingIds: submitted.findings.map((finding) => finding.id) });
      await waitRounds(page, b.id, 3);

      // 界面：B 的时间线上读到了 A 的回答，委派卡片已完成，评审卡片已交回。
      await page.goto(`${context.origin}/sessions/${encodeURIComponent(b.id)}`);
      await page.locator('[data-testid="delegation-card"][data-status="completed"]').waitFor({ timeout: TIMEOUT_MS });
      await page.locator('[data-testid="review-card"][data-status="submitted"]').waitFor({ timeout: TIMEOUT_MS });
      await page.getByText("GET /export?month=2026-10").first().waitFor({ timeout: TIMEOUT_MS });
      await capture(context, "multi-agent-walkthrough.png");

      // 4. 并行试做：项目目录变成 git 仓库，两版都交给假 Agent；比较后保留第一版的分支，清理两版。
      const git = (...args: string[]) => context.runCapture("git", ["-C", context.projectRoot, "-c", "user.name=gate", "-c", "user.email=gate@suduo.local", ...args], 0);
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "gate baseline", "--allow-empty");
      const trial = await api<TrialDto>(page, "POST", "/api/v1/trials", {
        target: { remoteProjectId: projectId },
        agents: [{ agentId: slot, approvalMode: "auto" }, { agentId: slot, approvalMode: "auto" }],
        task: "@say 这一版做完了",
      });
      const finished = await poll(async () => {
        const current = await api<TrialDto>(page, "GET", `/api/v1/trials/${trial.id}`);
        return current.entries.every((entry) => entry.state === "completed") ? current : null;
      }, "trial");
      if (finished.entries.some((entry) => entry.finalMessage !== "这一版做完了")) throw new Error("trial entries did not answer");
      const adopted = await api<TrialDto>(page, "POST", `/api/v1/trials/${trial.id}/adopt`, { entryId: finished.entries[0]!.id, mode: "keep-branch" });
      if (adopted.adoptResult?.kind !== "kept") throw new Error(`trial adopt failed: ${JSON.stringify(adopted.adoptResult)}`);
      const ids = finished.entries.map((entry) => entry.id);
      const cleaned = await api<TrialDto>(page, "POST", `/api/v1/trials/${trial.id}/cleanup`, { entryIds: ids, forceBranches: ids });
      if (cleaned.status !== "closed" || cleaned.entries.some((entry) => entry.state !== "removed")) throw new Error(`trial cleanup incomplete: ${cleaned.status}`);
      const branches = git("branch", "--list", "suduo/*").stdout.trim().split("\n").map((line) => line.replace(/^[*+ ]+/u, "").trim()).filter(Boolean);
      if (branches.length !== 1 || branches[0] !== finished.entries[0]!.branch) throw new Error(`unexpected branches after cleanup: ${branches.join(",")}`);

    } finally {
      // 中途失败也放回原来的路径覆盖（复用数据目录在本机跑时不会停在假 Agent 上）。
      await api(page, "PUT", "/api/v1/settings/agents", {
        agents: [{ id: slot, binOverride: previous?.binOverride ?? null, enabled: previous?.enabled ?? true }],
      });
    }
  },
};

/** 在页面里调本机服务的接口（同源，带幂等键）。 */
async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers: Record<string, string> = {};
      if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} → ${String(response.status)} ${text.slice(0, 300)}`);
      return (text === "" ? null : JSON.parse(text)) as T;
    },
    { method, path, body },
  ) as Promise<T>;
}

async function poll<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`multi-agent walkthrough: ${label} timed out`);
}

function waitRounds(page: Page, sessionId: string, count: number): Promise<unknown> {
  return poll(async () => {
    const rounds = (await api<{ items: Array<{ status: string }> }>(page, "GET", `/api/v1/sessions/${sessionId}/rounds`)).items;
    return rounds.length >= count && rounds.every((round) => round.status !== "running") ? rounds : null;
  }, `rounds of ${sessionId}`);
}
