import { capture, openSection } from "./helpers.js";
import type { GateCStep } from "./types.js";

/**
 * MCP 设置页（UI/UX 重设计 P4 起为独立分组 `/settings/mcp`）。
 *
 * 这是 D7 全局投影链路的最终验收点之一，也是「用户能不能自己看出问题」的检验：
 * 配一个**命令不存在**的 stdio 服务器，设置页必须显示「没有连上 / 未确认连接」，
 * 分组导航亮起提示点，展开「查看原因」后给出可执行的信息。
 *
 * 关于失败原文：codex 0.143 不暴露失败原因（曾记为验收豁免）；升级到 0.159 后状态列表的 `toolsError`
 * 带启动失败原文，所以本步骤断言状态是 failed、且「查看原因」里显示的是 Codex 给的原文。
 */
export const mcpSettingsStep: GateCStep = {
  id: "mcp-settings",
  async run(context) {
    // 用 CLI 直接配一台命令不存在的 stdio 服务器——确定性、可重复，不手工构造界面状态。
    context.runCapture(
      context.codexBin,
      ["mcp", "add", "gate-c-broken", "--", "/nonexistent/gate-c-mcp"],
      0,
    );
    try {

      // 不能用 networkidle：SSE 长连接常驻。
      await context.page.goto(context.origin + "/settings/mcp", {
        waitUntil: "domcontentloaded",
      });
      await context.page.getByTestId("mcp-panel").waitFor({ timeout: 30_000 });

      const row = context.page.locator('[data-testid="mcp-server-row"][data-server-name="gate-c-broken"]');
      await row.waitFor({ timeout: 30_000 });

      // 1. 状态必须是 failed（「没有连上」）——Codex 的 toolsError 给出了失败原文。
      const startup = await row.getAttribute("data-startup");
      if (startup !== "failed") {
        throw new Error(`命令不存在的 stdio 服务器应显示为没有连上，实际 startupState=${String(startup)}`);
      }
      // 分组导航亮起提示点（启用了但没连上）
      const navLink = context.page
        .getByRole("navigation", { name: "设置分组" })
        .getByRole("link", { name: /^MCP 服务/ });
      if (!/有问题|需要留意/.test((await navLink.textContent()) ?? "")) {
        throw new Error("有 MCP 服务没连上时，「MCP 服务」分组应有提示点");
      }

      // 2. 展开「查看原因」后必须给出说明（有官方原文就显示原文，没有则明说没有）
      await row.getByRole("button", { name: "查看原因" }).click();
      const detail = context.page.getByTestId("mcp-failure-detail");
      await detail.waitFor();
      const reason = (await detail.getByTestId("mcp-failure-reason").textContent()) ?? "";
      if (reason.trim() === "") {
        throw new Error("诊断区必须给出说明，不能留空");
      }
      // 必须是 Codex 给的原文（不是「Codex 没有提供……」的兜底说明）。
      if (reason.includes("Codex 没有提供")) {
        throw new Error(`应显示 Codex 给出的失败原文，实际是兜底说明：${reason}`);
      }
      await capture(context, "13-mcp-failure.png");

      // 3. 诊断页的 MCP 一项接上真实数据（不是「没能完成检查」）
      await context.page.goto(context.origin + "/settings/diagnostics", { waitUntil: "domcontentloaded" });
      const mcpHealth = context.page
        .getByRole("list", { name: "健康检查" })
        .locator('[data-testid="health-item"][data-key="mcp"]:not([data-status="checking"])');
      await mcpHealth.waitFor({ timeout: 60_000 });
      const mcpHealthText = (await mcpHealth.textContent()) ?? "";
      if ((await mcpHealth.getAttribute("data-status")) === "unknown" || !mcpHealthText.includes("gate-c-broken")) {
        throw new Error(`诊断里的 MCP 一项应读到列表并点名没连上的服务，实际：${mcpHealthText}`);
      }

      // 4. 新增表单只收变量名、不收密钥值（R3/R4）
      await context.page.goto(context.origin + "/settings/mcp", { waitUntil: "domcontentloaded" });
      await context.page.getByRole("button", { name: "添加服务" }).first().click();
      const form = context.page.getByTestId("mcp-create-form");
      await form.waitFor();
      await context.page.getByTestId("mcp-env-vars").waitFor();
      const formText = (await form.textContent()) ?? "";
      if (!formText.includes("只填变量名")) {
        throw new Error("本机命令表单必须说清只填变量名、值来自系统环境");
      }
      await context.page.keyboard.press("Escape");
      await form.waitFor({ state: "hidden" });

    } finally {
      // 即使断言失败也必须清理隔离 Codex home，避免下一轮 doctor 被残留配置阻断。
      context.runCapture(context.codexBin, ["mcp", "remove", "gate-c-broken"], 0);
    }

    // P1 起经主导航回到当前项目的需求页（旧的 pushState("/requirements") 只剩重定向）。
    await openSection(context.page, "需求");
    await context.page.getByTestId("requirements-board").waitFor({ timeout: 20_000 });
  },
};
