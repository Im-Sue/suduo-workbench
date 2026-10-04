import { capture, completeStartSessionDialog, pickSkill } from "./helpers.js";
import { GATE_C_FIXTURE_IDS, GATE_C_FIXTURE_NUMBERS } from "../requirements-service-fixture.js";
import type { GateCStep } from "./types.js";

/**
 * PR8 交付闸门：新增页面不只靠 DOM 单测，而是在真实 BFF、会话材料和远程夹具上
 * 验证路由穿透、材料漂移、待审批直达与独立降级。
 *
 * UI/UX 重设计 P1 / P2 起：URL 是项目上下文的唯一真相（/p/<项目>/…、/sessions/<会话>），
 * 旧路径只做重定向；这里既走新路径，也断言旧深链接落到新地址。
 * P4 起「我的工作」改为：需要你处理 / 我的需求 / 会话 / 最近动态，各区块独立降级。
 */
export const overviewWorkbenchStep: GateCStep = {
  id: "overview-workbench",
  async run(context) {
    if (
      context.localProjectId === null ||
      context.sessionId === null ||
      context.remoteProjectId === null
    ) {
      throw new Error("overview-workbench 需要前序步骤建立的远程项目与会话");
    }

    await assertRouteSemantics(context);
    await assertOverviewNavigation(context);

    // 先开工（本机登记开工版本），再让夹具改变远程标题（版本 +1）；这是真实的
    // 「开工后需求有变化」链路，不是构造 API 响应绕过 BFF 比对。
    await context.page
      .getByTestId("requirement-detail")
      .getByRole("button", { name: "开始会话" })
      .click();
    const requirementSessionId = await completeStartSessionDialog(context);
    await context.page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
    context.requirementsFixture.changeRequirement(GATE_C_FIXTURE_IDS.reqDraft1, {
      title: "发生材料漂移的需求",
    });
    try {
      await context.page.goto(context.origin + "/my", { waitUntil: "domcontentloaded" });
      const driftRow = context.page.getByTestId(
        `workbench-requirement-${GATE_C_FIXTURE_IDS.reqDraft1}`,
      );
      await driftRow.waitFor({ timeout: 30_000 });
      await driftRow.getByText("开工后需求有变化", { exact: true }).waitFor();
      await driftRow.getByText("开工后需求有变化", { exact: true }).click();
      await context.page.getByRole("heading", { name: "发生材料漂移的需求" }).waitFor();
      await assertWorkbenchApprovalAndDegradation(context, requirementSessionId);
    } finally {
      context.requirementsFixture.restoreRequirement(GATE_C_FIXTURE_IDS.reqDraft1);
    }
    // changes-and-diff 的会话基线必须涵盖 assistant-approval 创建的文件；因此该步骤
    // 验证完 requirement session 后回到原 Gate C 会话，不能污染共享 context.sessionId。
    await context.page.goto(`${context.origin}/sessions/${context.sessionId}`, {
      waitUntil: "domcontentloaded",
    });
    await context.page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
    await capture(context, "14-overview-workbench.png");
  },
};

/** 新路径可达，旧深链接（P1 之前的地址）落到对应的新地址。 */
async function assertRouteSemantics(context: Parameters<GateCStep["run"]>[0]): Promise<void> {
  const page = context.page;
  const projectPath = `/p/${context.remoteProjectId!}`;

  await page.goto(context.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === "/my", { timeout: 20_000 });
  await page.getByRole("heading", { level: 1, name: "我的工作" }).waitFor();

  await page.goto(context.origin + "/requirements", { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === `${projectPath}/requirements`, { timeout: 20_000 });
  await page.getByTestId("requirements-board").waitFor();

  await page.goto(context.origin + `/requirements/${GATE_C_FIXTURE_IDS.reqDraft1}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForURL(
    (url) => url.pathname === `${projectPath}/requirements/${String(GATE_C_FIXTURE_NUMBERS.reqDraft1)}`,
    { timeout: 20_000 },
  );
  await page.getByRole("heading", { name: "看板草稿一" }).waitFor();

  for (const legacy of ["/", "/sessions"]) {
    const sessionUrl = new URL(context.origin + legacy);
    sessionUrl.searchParams.set("projectId", context.localProjectId!);
    sessionUrl.searchParams.set("sessionId", context.sessionId!);
    await page.goto(sessionUrl.toString(), { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === `/sessions/${context.sessionId!}`, {
      timeout: 20_000,
    });
    await page.getByTestId("sessions-workbench").waitFor();
  }
}

async function assertOverviewNavigation(context: Parameters<GateCStep["run"]>[0]): Promise<void> {
  const page = context.page;
  const projectPath = `/p/${context.remoteProjectId!}`;
  await page.goto(context.origin + "/overview", { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === `${projectPath}/overview`, { timeout: 20_000 });
  const funnel = page.getByTestId("overview-status-funnel");
  await funnel.waitFor({ timeout: 30_000 });
  await page.getByTestId("overview-stale-requirements").waitFor();
  await page.getByTestId("overview-transition-chart").waitFor();
  await funnel.getByRole("button").first().click();
  await page.getByTestId("requirements-board").waitFor();
  const filtered = await page.evaluate(() => ({
    pathname: window.location.pathname,
    status: new URL(window.location.href).searchParams.get("status"),
  }));
  if (filtered.pathname !== `${projectPath}/requirements` || filtered.status === null) {
    throw new Error(`漏斗点击应进入带筛选的看板，实际 ${JSON.stringify(filtered)}`);
  }

  await page.goto(context.origin + `${projectPath}/overview`, { waitUntil: "domcontentloaded" });
  const stale = page.getByTestId("overview-stale-requirements");
  await stale.getByRole("button").first().waitFor({ timeout: 30_000 });
  await stale.getByRole("button").first().click();
  await page.getByRole("heading", { name: "看板草稿一" }).waitFor();
  await page.waitForURL(
    (url) => url.pathname === `${projectPath}/requirements/${String(GATE_C_FIXTURE_NUMBERS.reqDraft1)}`,
    { timeout: 20_000 },
  );
}

async function assertWorkbenchApprovalAndDegradation(
  context: Parameters<GateCStep["run"]>[0],
  requirementSessionId: string,
): Promise<void> {
  const sessionUrl = `${context.origin}/sessions/${requirementSessionId}`;
  await context.page.goto(sessionUrl, { waitUntil: "domcontentloaded" });
  await context.page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
  await pickSkill(context.page, "gate-c-workflow");
  await context.page.getByTestId("message-input").fill(
    "执行 decline 阶段：严格按 skill 指令尝试运行命令创建 GATE_C_DECLINE.md。",
  );
  await context.page.getByTestId("send-message").click();
  await context.page.getByTestId("approval-card").waitFor({ timeout: 180_000 });

  await context.page.goto(context.origin + "/my", { waitUntil: "domcontentloaded" });
  const pendingAction = context.page.getByTestId(
    `workbench-action-pending_approval-${requirementSessionId}`,
  );
  await pendingAction.waitFor({ timeout: 30_000 });
  await pendingAction.click();
  await context.page.getByTestId("approval-card").waitFor({ timeout: 30_000 });
  await context.page.getByTestId("approval-decline").click();
  await context.page.getByTestId("approval-card").waitFor({ state: "hidden", timeout: 60_000 });
  await context.page.getByTestId("interrupt-turn").waitFor({ state: "hidden", timeout: 60_000 });

  await context.page.goto(context.origin + "/my", { waitUntil: "domcontentloaded" });
  await context.page
    .getByTestId(`workbench-requirement-${GATE_C_FIXTURE_IDS.reqDraft1}`)
    .waitFor({ timeout: 30_000 });
  context.requirementsFixture.setRemoteFailure(true);
  try {
    await context.page.getByTestId("workbench-refresh").click();
    const requirements = context.page.getByTestId("workbench-requirements");
    await requirements.getByText("我在做的需求暂不可用", { exact: false }).waitFor({
      timeout: 30_000,
    });
    await context.page.getByTestId("workbench-actions").getByText("需要你处理").waitFor();
    const sessionRows = await context.page
      .getByTestId("workbench-sessions")
      .locator('[data-testid^="workbench-session-"]')
      .count();
    if (sessionRows === 0) {
      throw new Error("远程失败时本机会话区块不应随远程需求区块一起消失");
    }
    await capture(context, "15-workbench-remote-unavailable.png");
  } finally {
    context.requirementsFixture.setRemoteFailure(false);
  }
  const requirements = context.page.getByTestId("workbench-requirements");
  // 「我在做的」与「我负责的」各自降级、各有重试；先重试前者。
  await requirements.getByRole("button", { name: "重试", exact: true }).first().click();
  await requirements.getByText("开工后需求有变化", { exact: true }).waitFor({ timeout: 30_000 });

  await context.page.goto(sessionUrl, { waitUntil: "domcontentloaded" });
  await context.page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
}
