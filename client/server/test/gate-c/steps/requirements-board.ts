import { setTimeout as delay } from "node:timers/promises";
import type { Locator, Page, Request, Response } from "playwright";
import {
  REQUIREMENT_STATUSES,
  type RequirementStatus,
} from "@suduo/cloud-contracts";
import { messagesFor } from "../../../src/i18n/messages/index.js";

// gate-c 固定按中文界面跑（技术设计 §五）：状态名取中文字典，与前端 `common.requirementStatus` 一致。
const REQUIREMENT_STATUS_LABELS: Readonly<Record<RequirementStatus, string>> = messagesFor("zh-CN").common.requirementStatus;
import { GATE_C_FIXTURE_COMMENT_AT, GATE_C_FIXTURE_IDS, GATE_C_FIXTURE_NUMBERS } from "../requirements-service-fixture.js";
import { capture, completeStartSessionDialog } from "./helpers.js";
import type { GateCStep, GateCStepContext } from "./types.js";

/**
 * 需求模块（UI/UX 重设计 P2）的浏览器级验收。
 *
 * 承接 pr7 / pr6 的核销意图，改成新交互：
 * 1. 七列各自加载——夹具把三条放 draft、一条放 in_refinement 和 on_hold，
 *    「单游标拉一页再前端 filter」会让 on_hold 列假空；这里既数卡片也数请求。
 * 2. 列序与列宽：新设计列宽约 272px、看板允许横向滚动（ADR-0006；技术设计 §7
 *    「需求看板：列宽 280–320，横向滚动」）。旧的「1440 宽度下七列不得横向滚动」
 *    断言随旧界面退役，改为断言七列齐全、列宽一致且合理、最右一列可滚动到达。
 * 3. 筛选写进 URL：按编号搜索、负责人「我负责的」。
 * 4. dnd-kit 指针拖拽改状态成功后卡片落到目标列。
 * 5. 失败分支：PATCH 恒 503、同一时刻同事已把它移到 in_testing；乐观更新回滚后重新拉取，
 *    卡片只出现在真实列 in_testing，既不回弹原列也不停在拖拽目标列。
 * 6. 键盘：聚焦卡片按 1–7 直接改状态。
 * 7. 速览：点卡片打开、URL 带 `?peek=<编号>`、Esc 关闭。
 * 8. 详情：旧 `/requirements/<uuid>` 链接换成编号地址；附件区没有发布入口，历史确认版只读可展开；
 *    另一窗口发的评论经 SSE 到达主窗口；删除附件经确认对话框后该行消失。
 * 9. 从速览「开始会话」进入 `/sessions/<id>`（gate-c 环境有真实 Codex）。
 */
export const requirementsBoardStep: GateCStep = {
  id: "requirements-board",
  async run(context) {
    const projectId = context.remoteProjectId;
    if (projectId === null) throw new Error("requirements-board 需要 v2-user-path 选定的远程项目");
    const page = context.page;
    const boardPath = `/p/${projectId}/requirements`;

    await verifyColumnsLoadIndependently(context, boardPath);
    await verifyUrlFilters(page);
    await capture(context, "06-requirements-board.png");

    // 拖拽改状态：draft → ready_for_development（第 3 列）。
    // 目标选在看板可视区中段：dnd-kit 指针靠近滚动容器边缘（20%）会自动滚动，拖到屏外列会让落点漂移。
    const moved = waitForPatch(page, GATE_C_FIXTURE_IDS.reqDraft2);
    await dragCard(page, GATE_C_FIXTURE_IDS.reqDraft2, "draft", "ready_for_development");
    if ((await moved).status() !== 200) throw new Error("拖拽改状态的 PATCH 未成功");
    await waitUntil(
      async () =>
        (await countIn(page, "ready_for_development", GATE_C_FIXTURE_IDS.reqDraft2)) === 1 &&
        (await countIn(page, "draft", GATE_C_FIXTURE_IDS.reqDraft2)) === 0,
      20_000,
      "拖拽成功后卡片应只在「待开发」列",
    );

    // 失败分支：拖到 in_refinement，PATCH 503；回滚并重新拉取后应落在真实列 in_testing。
    const failed = waitForPatch(page, GATE_C_FIXTURE_IDS.reqPatchFailure);
    await dragCard(page, GATE_C_FIXTURE_IDS.reqPatchFailure, "draft", "in_refinement");
    if ((await failed).status() !== 503) throw new Error("失败分支的 PATCH 应为 503");
    await page
      .locator('[data-testid="global-message"][data-feedback-result="global"]')
      .filter({ hasText: "未能保存" })
      .first()
      .waitFor({ timeout: 20_000 });
    await waitUntil(
      async () =>
        (await countIn(page, "in_testing", GATE_C_FIXTURE_IDS.reqPatchFailure)) === 1 &&
        (await countIn(page, "in_refinement", GATE_C_FIXTURE_IDS.reqPatchFailure)) === 0 &&
        (await countIn(page, "draft", GATE_C_FIXTURE_IDS.reqPatchFailure)) === 0,
      20_000,
      "PATCH 失败的卡片必须只出现在真实列 in_testing（不回弹 draft、不停在拖拽目标 in_refinement）",
    );
    await capture(context, "07-board-conflict-resolved.png");

    // 键盘：聚焦卡片后按 4 → 第 4 列 in_development。
    const keyed = waitForPatch(page, GATE_C_FIXTURE_IDS.reqRefinement1);
    await cardIn(page, "in_refinement", GATE_C_FIXTURE_IDS.reqRefinement1).focus();
    await page.keyboard.press(String(REQUIREMENT_STATUSES.indexOf("in_development") + 1));
    if ((await keyed).status() !== 200) throw new Error("按数字键改状态的 PATCH 未成功");
    await waitUntil(
      async () =>
        (await countIn(page, "in_development", GATE_C_FIXTURE_IDS.reqRefinement1)) === 1 &&
        (await countIn(page, "in_refinement", GATE_C_FIXTURE_IDS.reqRefinement1)) === 0,
      20_000,
      "按 4 后卡片应移到「开发中」列",
    );

    await verifyPeek(page);
    await verifyDetailAttachmentsAndRealtime(context, projectId);
    await verifyStartSessionFromPeek(context, boardPath);
  },
};

// ---------- 七列 ----------

async function verifyColumnsLoadIndependently(
  context: GateCStepContext,
  boardPath: string,
): Promise<void> {
  const page = context.page;
  const listPath = `/api/v2${boardPath.replace(/^\/p\//u, "/projects/")}`;
  const requestedStatuses = new Set<string>();
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    const status = url.searchParams.get("status");
    if (request.method() === "GET" && url.pathname === listPath && status !== null) {
      requestedStatuses.add(status);
    }
  };
  page.on("request", onRequest);
  try {
    // 不能用 networkidle：外壳常驻需求 SSE，网络永远不空闲。
    await page.goto(context.origin + boardPath + "?view=board", { waitUntil: "domcontentloaded" });
    await page.getByTestId("requirements-board").waitFor();
    await cardIn(page, "on_hold", GATE_C_FIXTURE_IDS.reqHold1).waitFor({ timeout: 20_000 });
    await cardIn(page, "in_refinement", GATE_C_FIXTURE_IDS.reqRefinement1).waitFor();
    await cardIn(page, "draft", GATE_C_FIXTURE_IDS.reqDraft1).waitFor();
    // 空列显示「暂无」而不是骨架：七列都落定后再断言。
    for (const status of REQUIREMENT_STATUSES) {
      await column(page, status)
        .getByTestId("requirement-card")
        .or(column(page, status).getByText("暂无", { exact: true }))
        .first()
        .waitFor({ timeout: 20_000 });
    }
  } finally {
    page.off("request", onRequest);
  }
  const missing = REQUIREMENT_STATUSES.filter((status) => !requestedStatuses.has(status));
  if (missing.length > 0) {
    throw new Error(`七列应各自请求，缺少：${missing.join(", ")}`);
  }

  const holdCount = await column(page, "on_hold").getByTestId("requirement-card").count();
  if (holdCount !== 1) {
    throw new Error(`on_hold 列应有 1 张卡（证明该列独立请求过），实际 ${String(holdCount)} 张`);
  }
  const refinementCount = await column(page, "in_refinement").getByTestId("requirement-card").count();
  if (refinementCount !== 1) {
    throw new Error(`in_refinement 列应有 1 张夹具卡，实际 ${String(refinementCount)} 张`);
  }
  const draftCount = await column(page, "draft").getByTestId("requirement-card").count();
  if (draftCount < 2) {
    throw new Error(`draft 列应有至少 2 张卡，实际 ${String(draftCount)} 张`);
  }

  const board = page.getByTestId("requirements-board");
  const layout = await board.evaluate((element) => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    columns: [...element.querySelectorAll<HTMLElement>("[data-status-column]")].map((node) => ({
      status: node.dataset["statusColumn"] ?? "",
      width: node.getBoundingClientRect().width,
    })),
  }));
  const order = layout.columns.map((item) => item.status);
  if (JSON.stringify(order) !== JSON.stringify(REQUIREMENT_STATUSES)) {
    throw new Error(`看板列序应为 ${REQUIREMENT_STATUSES.join(" / ")}，实际 ${order.join(" / ")}`);
  }
  if (layout.viewportWidth !== 1440 || layout.viewportHeight !== 900) {
    throw new Error(
      `看板布局基准必须为 1440x900，实际 ${String(layout.viewportWidth)}x${String(layout.viewportHeight)}`,
    );
  }
  // 依据 ADR-0006 与技术设计 §7：列宽固定（当前 272px），列多时看板横向滚动，不再压缩列宽塞进一屏。
  const widths = layout.columns.map((item) => item.width);
  const narrowest = Math.min(...widths);
  const widest = Math.max(...widths);
  if (narrowest < 240 || widest > 340 || widest - narrowest > 1) {
    throw new Error(`七列列宽应一致且在 240–340px 之间，实际 ${widths.join(" / ")}`);
  }
  console.info(
    `[requirements-board] viewport=1440x900 columnWidth=${String(narrowest)} clientWidth=${String(layout.clientWidth)} scrollWidth=${String(layout.scrollWidth)}`,
  );
  // 横向滚动由看板自己承担：看板不能被撑出内容面板（否则右侧几列被外层 overflow-hidden 裁掉，
  // 鼠标 / 触控板滚不到）；把看板滚到最右后，最后一列（暂缓）应完整落在内容面板内。
  // 不用 scrollIntoView：它会连带滚动 overflow-hidden 的外层，掩盖「用户滚不到」的问题。
  const reach = await board.evaluate((element) => {
    const panel = document.getElementById("main-content")?.getBoundingClientRect();
    const last = element.querySelector('[data-status-column="on_hold"]');
    if (panel === undefined || last === null) return null;
    const boardRight = element.getBoundingClientRect().right;
    element.scrollLeft = element.scrollWidth;
    const lastRect = last.getBoundingClientRect();
    const result = {
      panelLeft: Math.round(panel.left),
      panelRight: Math.round(panel.right),
      boardRight: Math.round(boardRight),
      lastLeft: Math.round(lastRect.left),
      lastRight: Math.round(lastRect.right),
      scrollLeft: element.scrollLeft,
    };
    element.scrollLeft = 0;
    return result;
  });
  if (
    reach === null ||
    reach.boardRight > reach.panelRight + 1 ||
    reach.lastLeft < reach.panelLeft - 1 ||
    reach.lastRight > reach.panelRight + 1
  ) {
    throw new Error(
      "看板应在内容面板内自行横向滚动，最右一列要能滚进可视区：" + JSON.stringify(reach),
    );
  }
}

// ---------- 筛选 ----------

async function verifyUrlFilters(page: Page): Promise<void> {
  const board = page.getByTestId("requirements-board");
  const visibleCards = () => board.getByTestId("requirement-card");
  const holdCode = `REQ-${String(GATE_C_FIXTURE_NUMBERS.reqHold1)}`;

  // 按编号搜索：列表接口的 search 同时匹配编号。
  await page.getByRole("textbox", { name: "搜索需求" }).fill(holdCode);
  await page.waitForURL((url) => url.searchParams.get("q") === holdCode, { timeout: 10_000 });
  await waitUntil(
    async () =>
      (await visibleCards().count()) === 1 &&
      (await countIn(page, "on_hold", GATE_C_FIXTURE_IDS.reqHold1)) === 1,
    20_000,
    `搜索 ${holdCode} 应只剩这一张卡`,
  );
  await page.getByRole("button", { name: "清除筛选", exact: true }).first().click();
  await page.waitForURL((url) => !url.searchParams.has("q"), { timeout: 10_000 });

  // 负责人「我负责的」：夹具只把「看板草稿一」指派给登录用户。
  await page.getByRole("button", { name: "负责人", exact: true }).click();
  await page.getByRole("menuitem", { name: "我负责的" }).click();
  await page.waitForURL((url) => url.searchParams.get("assignee") === "me", { timeout: 10_000 });
  await waitUntil(
    async () =>
      (await visibleCards().count()) === 1 &&
      (await countIn(page, "draft", GATE_C_FIXTURE_IDS.reqDraft1)) === 1,
    20_000,
    "负责人筛选「我负责的」应只剩「看板草稿一」",
  );
  await page.getByRole("button", { name: "清除筛选", exact: true }).first().click();
  await page.waitForURL((url) => !url.searchParams.has("assignee"), { timeout: 10_000 });
  await cardIn(page, "on_hold", GATE_C_FIXTURE_IDS.reqHold1).waitFor({ timeout: 20_000 });
  await cardIn(page, "draft", GATE_C_FIXTURE_IDS.reqPatchFailure).waitFor({ timeout: 20_000 });
  await board.evaluate((element) => element.scrollTo({ left: 0, top: 0 }));
}

// ---------- 速览 ----------

async function verifyPeek(page: Page): Promise<void> {
  const number = String(GATE_C_FIXTURE_NUMBERS.reqDraft1);
  await cardIn(page, "draft", GATE_C_FIXTURE_IDS.reqDraft1).click();
  const peek = page.getByTestId("requirement-peek");
  await peek.waitFor();
  // TanStack Router 默认把「像数字的字符串」按 JSON 加引号序列化（?peek=%221%22）；两种写法解析结果相同。
  await page.waitForURL(
    (url) => [number, JSON.stringify(number)].includes(url.searchParams.get("peek") ?? ""),
    { timeout: 10_000 },
  );
  await peek.getByRole("heading", { name: "看板草稿一" }).waitFor();
  await peek.getByText("发布材料.txt", { exact: true }).waitFor();
  // 速览要出现在用户看得见的地方：不能被挤到内容面板之外（等滑入动画结束再量）。
  let boxes: { panel: unknown; peek: unknown } = { panel: null, peek: null };
  await waitUntil(
    async () => {
      const panelBox = await page.locator("#main-content").boundingBox();
      const peekBox = await peek.boundingBox();
      boxes = { panel: panelBox, peek: peekBox };
      return (
        panelBox !== null &&
        peekBox !== null &&
        peekBox.x >= panelBox.x - 1 &&
        peekBox.x + peekBox.width <= panelBox.x + panelBox.width + 1
      );
    },
    5_000,
    "速览面板应落在内容面板内",
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}：${JSON.stringify(boxes)}`);
  });
  await page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForURL((url) => !url.searchParams.has("peek"), { timeout: 10_000 });
}

// ---------- 详情：附件区、跨窗口评论与删除附件 ----------

/**
 * 详情页的浏览器级核销：
 * - 附件区（需求附件评论文件与优先级 S2）：没有「发布确认版」入口；夹具预置的历史确认版收在底部，展开后只读可见。
 * - 第二个 Page 是同一浏览器上下文的另一窗口：它在评论框发一条评论，主窗口只能借 SSE
 *   收到 `comment.created` 后回查活动；主窗口不点刷新。
 * - 附件删除：先经同源 BFF 带外修改需求描述（夹具不广播），让主窗口持有旧数据；随后删除仍成功
 *   （删除不携带版本，没有拒绝式守卫，ADR-0004），确认对话框保留，删除后自动回查到最新描述。
 */
async function verifyDetailAttachmentsAndRealtime(
  context: GateCStepContext,
  projectId: string,
): Promise<void> {
  const requirementId = GATE_C_FIXTURE_IDS.reqDraft1;
  const detailPath = `/p/${projectId}/requirements/${String(GATE_C_FIXTURE_NUMBERS.reqDraft1)}`;
  const main = context.page;

  // 整页加载前先挂等待：主窗口的需求 SSE 必须在另一窗口发评论前已建立，事件才有处可去。
  const realtimeConnected = main.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v2/events" && response.status() === 200,
    { timeout: 20_000 },
  );
  // 旧链接只有需求 id：应落到当前项目下并换成编号地址。
  await main.goto(`${context.origin}/requirements/${requirementId}`, { waitUntil: "domcontentloaded" });
  await main.waitForURL((url) => url.pathname === detailPath, { timeout: 20_000 });
  await realtimeConnected;
  await main.getByTestId("requirement-detail").waitFor();
  await main.getByRole("heading", { level: 1, name: "看板草稿一" }).waitFor();
  const materials = main.getByTestId("materials-panel");
  await materials.getByText("发布材料.txt", { exact: true }).waitFor();
  await materials.getByText("待删除材料.txt", { exact: true }).waitFor();
  await main.getByTestId("activity-comment").filter({ hasText: "普通评论" }).waitFor();
  // 评论真的显示出来后，经 BFF 把已读位置记到这条评论（我的工作里的「有新评论」靠它）。
  await waitForReadMark(context, requirementId, GATE_C_FIXTURE_COMMENT_AT);
  const activity = main.getByRole("list", { name: "活动" });

  // 确认版已停用：没有发布入口；以前发布的那一版收在「历史确认版」里，只读。
  if ((await materials.getByRole("button", { name: "发布确认版" }).count()) !== 0) {
    throw new Error("附件区不应再有「发布确认版」按钮");
  }
  const history = materials.getByTestId("historical-versions");
  await history.getByRole("button", { name: "历史确认版（1）" }).click();
  await history.getByText("第 1 版", { exact: true }).waitFor();
  await history.getByRole("link", { name: "下载「发布材料.txt」" }).waitFor();
  if ((await history.getByRole("button", { name: /^删除/u }).count()) !== 0) {
    throw new Error("历史确认版里不应有删除按钮");
  }
  await activity.getByText("发布了确认版 · 第 1 版", { exact: false }).waitFor();
  await activity.getByText("历史发布说明", { exact: true }).waitFor();
  console.info("[requirements-attachments] 附件区无发布入口；历史确认版第 1 版只读可见，活动里的发布记录照常。");

  const publisher = await context.browserContext.newPage();
  try {
    await publisher.goto(context.origin + detailPath, { waitUntil: "domcontentloaded" });
    await publisher.getByRole("heading", { level: 1, name: "看板草稿一" }).waitFor();
    // 这次回查只可能来自主窗口收到 comment.created 后的查询失效：没有轮询、没有手动刷新。
    const eventDrivenRefresh = waitForGet(main, `/api/v2/requirements/${requirementId}/activity`);
    await publisher.locator("#comment-composer").fill("跨窗口评论");
    await publisher.getByRole("button", { name: /发表评论/u }).click();
    await publisher.getByTestId("activity-comment").filter({ hasText: "跨窗口评论" }).waitFor({ timeout: 20_000 });
    await eventDrivenRefresh;
    await main.getByTestId("activity-comment").filter({ hasText: "跨窗口评论" }).waitFor({ timeout: 20_000 });
    console.info("[requirements-attachments] 主窗口经 SSE（comment.created）回查到另一窗口发的评论。");
    await capture(context, "08-comment-realtime-sse.png");

    // 带外修改描述（夹具不广播 SSE）：主窗口仍显示旧描述。
    const outOfBandSummary = "带外补充的需求描述";
    const bumped = await publisher.evaluate(
      async ({ id, summary }) => {
        const response = await fetch(`/api/v2/requirements/${id}`, {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ summary }),
        });
        return response.status;
      },
      { id: requirementId, summary: outOfBandSummary },
    );
    if (bumped !== 200) throw new Error(`带外修改需求描述失败：HTTP ${String(bumped)}`);
  } finally {
    await publisher.close();
  }

  const refreshedAfterDelete = waitForGet(main, `/api/v2/requirements/${requirementId}`);
  const attachmentRow = main
    .getByTestId("materials-panel")
    .getByRole("listitem")
    .filter({ hasText: "待删除材料.txt" });
  await attachmentRow.getByRole("button", { name: "删除「待删除材料.txt」" }).click();
  const confirm = main.getByTestId("confirm-dialog");
  await confirm.getByRole("heading", { name: "删除「待删除材料.txt」？" }).waitFor();
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await refreshedAfterDelete;
  await attachmentRow.waitFor({ state: "detached", timeout: 20_000 });
  await main.getByText("带外补充的需求描述", { exact: true }).waitFor({ timeout: 20_000 });
  await activity.getByText("删除了「待删除材料.txt」", { exact: true }).waitFor({ timeout: 20_000 });
  console.info("[requirements-attachments] 附件删除成功：确认对话框保留，删除后回查到带外修改且附件行消失。");
  await capture(context, "10-attachment-deleted-after-refresh.png");
}

// ---------- 开始会话 ----------

async function verifyStartSessionFromPeek(context: GateCStepContext, boardPath: string): Promise<void> {
  const page = context.page;
  const number = String(GATE_C_FIXTURE_NUMBERS.reqDraft2);
  // 速览状态写在 URL 里：直接打开带 ?peek= 的地址即进入速览。
  await page.goto(`${context.origin}${boardPath}?view=board&peek=${number}`, {
    waitUntil: "domcontentloaded",
  });
  const peek = page.getByTestId("requirement-peek");
  await peek.getByRole("heading", { name: "看板草稿二" }).waitFor({ timeout: 20_000 });
  await peek.getByRole("button", { name: "开始会话" }).click();
  const sessionId = await completeStartSessionDialog(context);
  await page.getByTestId("conversation-stream").waitFor({ timeout: 30_000 });
  console.info(`[requirements-board] 从速览开始会话，进入 /sessions/${sessionId}`);
  await capture(context, "09-requirement-session-started.png");
}

// ---------- 工具 ----------

function column(page: Page, status: RequirementStatus): Locator {
  return page.locator(`[data-status-column="${status}"]`);
}

function cardIn(page: Page, status: RequirementStatus, requirementId: string): Locator {
  return column(page, status).locator(
    `[data-testid="requirement-card"][data-requirement-id="${requirementId}"]`,
  );
}

function countIn(page: Page, status: RequirementStatus, requirementId: string): Promise<number> {
  return cardIn(page, status, requirementId).count();
}

function waitForPatch(page: Page, requirementId: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/v2/requirements/${requirementId}`,
    { timeout: 20_000 },
  );
}

async function waitForReadMark(context: GateCStepContext, requirementId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (context.requirementsFixture.readMarkOf(requirementId) === expected) return;
    await delay(100);
  }
  throw new Error(
    `详情页显示出评论后应把已读位置记到 ${expected}，实际为 ${String(context.requirementsFixture.readMarkOf(requirementId))}`,
  );
}

function waitForGet(page: Page, pathname: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === pathname &&
      response.status() === 200,
    { timeout: 20_000 },
  );
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("拖拽源或目标不可见");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * dnd-kit 指针拖拽（PointerSensor，移动 5px 激活）：按下 → 小步越过激活阈值 → 移到目标列的
 * 放置区中心 → 等读屏播报确认「移到某列上方」→ 松开。HTML5 DragEvent 在新看板上不起作用。
 */
async function dragCard(
  page: Page,
  requirementId: string,
  from: RequirementStatus,
  to: RequirementStatus,
): Promise<void> {
  const source = cardIn(page, from, requirementId);
  await source.waitFor();
  const start = await centerOf(source);
  const end = await centerOf(column(page, to).locator(":scope > div"));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 8, start.y + 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page
    .getByText(`移到「${REQUIREMENT_STATUS_LABELS[to]}」上方`, { exact: true })
    .waitFor({ state: "attached", timeout: 5_000 });
  await page.mouse.up();
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`超时：${message}`);
}
