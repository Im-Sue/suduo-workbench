import type { GateCStep } from "./types.js";
import { GATE_C_FIXTURE_IDS } from "../requirements-service-fixture.js";
import { completeStartSessionDialog } from "./helpers.js";

const REMOTE_LOGIN_NAME = "gate-c-user";
const REMOTE_PASSWORD = "gate-c-password";
const REMOTE_PROJECT_NAME = "Gate C 远程项目";
/** gate-c 给项目会话起的名字（用户输入，中英两种验收都用它）。 */
export const GATE_C_SESSION_TITLE = "Gate C 会话";

/**
 * V2 用户主路径（UI/UX 重设计 P1 / P2 起的新外壳）：
 * 登录页 → 项目切换器选定远程项目 → ⌘K 命令面板「在本机开始项目会话」→
 * 「开始会话」对话框里第一次关联本机代码目录 → 进入 `/sessions/<id>`。
 * 中文全量与英文冒烟（`SUDUO_GATE_LOCALE=en`）共用这一步，界面文字取自 `context.ui`。
 *
 * 向 context 写入后续步骤依赖的三项路由状态：
 * - `remoteProjectId`：项目切换器记住的上次使用项目（localStorage `suduo.v2.remoteProjectId`）；
 * - `sessionId`：`/sessions/$sessionId` 路由参数；
 * - `localProjectId`：会话接口 `GET /api/v1/sessions/:id` 的 `projectId`，并与本机目录映射交叉核对。
 */
export const v2UserPathStep: GateCStep = {
  id: "v2-user-path",
  async run(context) {
    const page = context.page;
    const ui = context.ui;
    // 服务已配置、尚未登录：根路由把任何页面都送到登录页。
    await page.goto(context.origin, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 20_000 });
    await page.getByRole("heading", { name: ui.login.title }).waitFor();
    await page.getByLabel(ui.login.loginName).fill(REMOTE_LOGIN_NAME);
    await page.getByLabel(ui.login.password).fill(REMOTE_PASSWORD);
    await page.getByRole("button", { name: ui.login.submit, exact: true }).click();

    // 登录后回到原先要去的地址（根路径 → 我的工作），外壳侧栏出现。
    await page.waitForURL((url) => url.pathname === "/my", { timeout: 20_000 });
    const nav = page.getByTestId("app-nav");
    await nav.waitFor();

    // 项目切换器：显式选定远程项目（选择会被记住，供不在项目路由下的页面回落）。
    await page.getByTestId("project-switcher").click();
    await page.getByRole("option", { name: REMOTE_PROJECT_NAME }).click();
    await page
      .getByTestId("project-switcher")
      .and(page.getByRole("button", { name: ui.projectSwitcher(REMOTE_PROJECT_NAME) }))
      .waitFor();

    // ⌘K（Linux 上为 Ctrl+K）命令面板里发起项目级本机会话。
    await page.keyboard.press("ControlOrMeta+KeyK");
    const palette = page.getByRole("dialog", { name: ui.palette.title });
    await palette.waitFor();
    await palette.getByRole("combobox").fill(ui.palette.query);
    await palette.getByRole("option", { name: ui.palette.startProjectSession }).click();

    // 首次建会话：项目还没有本机代码目录，对话框会先请用户选择目录。
    context.sessionId = null;
    const sessionId = await completeStartSessionDialog(context);

    await page.getByTestId("session-title").waitFor({ timeout: 30_000 });
    await page.getByTestId("rename-session").click();
    await page.getByTestId("session-title-input").fill(GATE_C_SESSION_TITLE);
    await page.getByTestId("session-title-input").press("Enter");
    await page.getByRole("heading", { name: GATE_C_SESSION_TITLE }).waitFor();

    const routeState = await page.evaluate(async (id) => {
      const session = await fetch(`/api/v1/sessions/${encodeURIComponent(id)}`).then(
        (response) => response.json() as Promise<{ projectId?: string }>,
      );
      const mappings = await fetch("/api/v2/project-mappings").then(
        (response) =>
          response.json() as Promise<{
            items?: Array<{ remoteProjectId: string; localProjectId: string; rootPath: string }>;
          }>,
      );
      return {
        pathname: window.location.pathname,
        localProjectId: session.projectId ?? null,
        mappings: mappings.items ?? [],
        remoteProjectId: localStorage.getItem("suduo.v2.remoteProjectId"),
      };
    }, sessionId);
    const mapping = routeState.mappings.find(
      (item) => item.remoteProjectId === GATE_C_FIXTURE_IDS.project,
    );
    if (
      routeState.pathname !== `/sessions/${sessionId}` ||
      !routeState.localProjectId ||
      routeState.remoteProjectId !== GATE_C_FIXTURE_IDS.project ||
      mapping?.localProjectId !== routeState.localProjectId ||
      mapping.rootPath !== context.projectRoot
    ) {
      throw new Error(
        "V2 路由状态未保留远程项目、本机目录映射与会话：" + JSON.stringify({ ...routeState, sessionId }),
      );
    }
    context.remoteProjectId = routeState.remoteProjectId;
    context.localProjectId = routeState.localProjectId;
    context.sessionId = sessionId;
  },
};
