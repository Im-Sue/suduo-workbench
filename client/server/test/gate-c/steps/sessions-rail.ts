import { capture, openSection } from "./helpers.js";
import type { GateCStep } from "./types.js";

/**
 * pr8 认领的 gate-c 步骤：会话页三段导航与同屏形态。
 *
 * 核销 pr1 断言迁移矩阵中责任片为 pr8 的三条：`new-session`、`rail-tab-sessions`、
 * `rail-tab-files` / `.file-row .blue-dot`。旧壳那三个 testid 属 `LeftRail`（本片已删），
 * 这里落成 V2 等价物。
 *
 * 最关键的一条是**切会话时左栏状态不丢**——这正是否决「给 SessionRuntime 加 railSlot」
 * 方案的理由，只有真跑才能证明外壳没跟着运行时一起重挂。
 */
export const sessionsRailStep: GateCStep = {
  id: "sessions-rail",
  async run(context) {
    if (context.sessionId === null || context.localProjectId === null) {
      throw new Error("sessions-rail 需要前序步骤建立的会话");
    }
    const sessionId = context.sessionId;

    // 深链接首载：P1 起会话地址是 /sessions/<id>，应直接定位到该会话
    // （旧 /sessions?projectId=&sessionId= 的重定向由 overview-workbench 断言）。
    // 不能用 networkidle：会话建立后 SSE 长连接常驻，网络永远不空闲。
    await context.page.goto(`${context.origin}/sessions/${sessionId}`, {
      waitUntil: "domcontentloaded",
    });

    // 同屏形态：左栏与会话区必须同时在场（旧形态是先列表页再跳独立页面）
    await context.page.getByTestId("sessions-workbench").waitFor();
    await context.page.getByTestId("sessions-rail").waitFor();
    await context.page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });

    // `new-session` 的 V2 等价物（旧壳同名 testid 属已删除的 LeftRail）
    await context.page.getByTestId("new-session").waitFor();

    const activeRow = context.page.locator('[data-testid="session-row"][data-active="true"]');
    await activeRow.waitFor();
    const activeId = await activeRow.getAttribute("data-session-id");
    if (activeId !== sessionId) {
      throw new Error(
        `深链接应高亮当前会话：期望 ${sessionId}，实际 ${String(activeId)}`,
      );
    }

    // `rail-tab-files` / 蓝点的 V2 等价物：文件树迁到右侧改动面板的标签页
    await context.page.getByTestId("side-tab-files").click();
    await context.page.getByTestId("side-file-tree").waitFor();
    await context.page.getByTestId("side-tab-changes").click();
    await capture(context, "08-sessions-rail.png");

    // 核心断言：搜索词是左栏状态，切会话后必须还在
    const search = context.page.getByTestId("session-search");
    await search.fill("gate");
    const beforeKeyword = await search.inputValue();
    if (beforeKeyword !== "gate") {
      throw new Error("搜索框未接受输入");
    }

    // 在左栏再点一次当前会话（切会话的真实入口），验证外壳未整体重挂
    await context.page
      .locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
      .getByRole("button")
      .first()
      .click();
    await context.page.waitForURL((url) => url.pathname === `/sessions/${sessionId}`);

    await context.page.getByTestId("sessions-rail").waitFor();
    const afterKeyword = await context.page.getByTestId("session-search").inputValue();
    if (afterKeyword !== "gate") {
      throw new Error(
        `切会话后左栏搜索词丢失：期望 "gate"，实际 "${afterKeyword}"——外壳被整体重挂了`,
      );
    }

    // 前进/后退：经主导航切到需求页再后退，会话应按路由参数正确恢复。
    // 这条专门验证 pr8 补的缺口——旧实现 popstate 只同步 mode，不同步当前会话，
    // 后退后地址栏对了但右侧还停在上一个会话。
    await openSection(context.page, "需求");
    await context.page.getByTestId("requirements-board").waitFor({ timeout: 20_000 });

    await context.page.goBack();
    await context.page.getByTestId("sessions-rail").waitFor({ timeout: 20_000 });
    const restored = context.page.locator(
      '[data-testid="session-row"][data-active="true"]',
    );
    await restored.waitFor({ timeout: 20_000 });
    const restoredId = await restored.getAttribute("data-session-id");
    if (restoredId !== sessionId) {
      throw new Error(
        `后退后应恢复原会话：期望 ${sessionId}，实际 ${String(restoredId)}`,
      );
    }
    await capture(context, "09-rail-state-preserved.png");
  },
};
