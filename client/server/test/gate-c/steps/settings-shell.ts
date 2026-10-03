import { capture, openSection } from "./helpers.js";
import type { GateCStep } from "./types.js";

/**
 * 设置页外壳（UI/UX 重设计 P4 起按分组路由 `/settings/$section`）。
 *
 * 四件必须真跑：
 * 1. 分组深链接刷新后仍停在原组；旧版 `/settings#组` 重定向到对应分组。
 * 2. 分组导航可达各组（按可访问名定位，异常红点不影响名称前缀）。
 * 3. `SUDUO_MAX_APPROVAL_MODE` 生效时「执行与安全」显示锁定态：「完全访问」不可选，
 *    说明写清是管理员限制、该找谁（界面主文案不出现环境变量名）。
 * 4. 多字段表单有未保存的更改时，离开分组先提醒：继续编辑留在原处，放弃后才离开。
 */
export const settingsShellStep: GateCStep = {
  id: "settings-shell",
  async run(context) {
    const page = context.page;
    const nav = page.getByRole("navigation", { name: "设置分组" });

    // 不能用 networkidle：会话已建立后 SSE 长连接常驻，网络永远不空闲。
    await page.goto(context.origin + "/settings/workspace", { waitUntil: "domcontentloaded" });
    await page.getByTestId("settings-page").waitFor();

    // 1. 深链接：刷新后仍停在代码目录；旧版锚点重定向
    await page.getByRole("heading", { level: 2, name: "代码目录" }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 2, name: "代码目录" }).waitFor({ timeout: 20_000 });
    await page.goto(context.origin + "/settings#security", { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === "/settings/execution", { timeout: 20_000 });

    // 2. 分组导航
    await nav.getByRole("link", { name: /^模型服务/ }).click();
    await page.getByRole("heading", { level: 2, name: "模型服务" }).waitFor();
    await nav.getByRole("link", { name: /^Skills/ }).click();
    await page.getByRole("heading", { level: 2, name: "Skills" }).waitFor();

    // 3. 锁定态：gate-c 的服务以 SUDUO_MAX_APPROVAL_MODE=auto 启动
    await nav.getByRole("link", { name: /^执行与安全/ }).click();
    await page.getByRole("heading", { level: 2, name: "执行与安全" }).waitFor();
    const fullOption = page.getByRole("radio", { name: /^完全访问/ });
    await fullOption.waitFor();
    if (!(await fullOption.isDisabled())) {
      throw new Error("cap=auto 时默认确认方式里的「完全访问」必须不可选");
    }
    const lockReason = page.getByTestId("settings-lock-reason").first();
    await lockReason.waitFor();
    const reasonText = (await lockReason.textContent()) ?? "";
    if (!reasonText.includes("管理员已限制最高权限")) {
      throw new Error(`锁定说明必须写明是管理员限制，实际为：${reasonText}`);
    }
    if (!reasonText.includes("联系管理员")) {
      throw new Error(`锁定说明必须告知联系管理员，实际为：${reasonText}`);
    }
    if (reasonText.includes("SUDUO_")) {
      throw new Error(`锁定说明不应出现环境变量名，实际为：${reasonText}`);
    }
    await capture(context, "10-settings-shell.png");

    // 4. 未保存提醒：改服务地址 → 切分组 → 继续编辑 / 放弃更改
    await nav.getByRole("link", { name: /^需求服务/ }).click();
    const baseUrl = page.getByLabel("服务地址");
    await baseUrl.waitFor();
    const original = await baseUrl.inputValue();
    await baseUrl.fill(original + "/draft");
    await page.getByRole("region", { name: "未保存的更改" }).waitFor();
    await nav.getByRole("link", { name: /^代码目录/ }).click();
    const unsaved = page.getByRole("dialog", { name: "有未保存的更改" });
    await unsaved.waitFor();
    await unsaved.getByRole("button", { name: "继续编辑" }).click();
    await unsaved.waitFor({ state: "hidden" });
    if (new URL(page.url()).pathname !== "/settings/service" || (await baseUrl.inputValue()) !== original + "/draft") {
      throw new Error("选择「继续编辑」后应留在需求服务分组，草稿不丢");
    }
    await nav.getByRole("link", { name: /^代码目录/ }).click();
    await unsaved.waitFor();
    await unsaved.getByRole("button", { name: "放弃更改" }).click();
    await page.getByRole("heading", { level: 2, name: "代码目录" }).waitFor();

    // 回需求页，避免影响后续步骤的路由上下文
    await openSection(page, "需求");
    await page.getByTestId("requirements-board").waitFor({ timeout: 20_000 });
  },
};
