import { capture, openSection } from "./helpers.js";
import type { GateCStep } from "./types.js";

/**
 * 设置页里依赖 Codex 的部分：模型服务、Skills、诊断。
 *
 * 最关键的一条是 **Codex 的配置提醒真的能被看见**——它同时端到端验收 pr3 建的全局状态投影链路：
 * codex 发出无 `threadId` 的 `configWarning` → 白名单判定 → 内存投影 →
 * `/api/v1/codex/status` 推送 → 模型服务分组的提醒横幅 + 分组导航提示点。
 *
 * 告警来源必须是**确定性的**：Codex 0.159 起配置里有它不认识的键，每次启动都会发 configWarning。
 * `scripts/gate-c-vm.sh` 给 gate-c 的 CODEX_HOME 顶层加了 `suduo_gate_c_probe = true`；
 * 在别的 gate-c 主机上，Linux 没装 bubblewrap 时 Codex 也会发（「could not find bubblewrap on PATH」）。
 */
export const settingsCodexStep: GateCStep = {
  id: "settings-codex",
  async run(context) {
    const page = context.page;
    const nav = page.getByRole("navigation", { name: "设置分组" });
    // 不能用 networkidle：SSE 长连接常驻，网络永远不空闲。
    await page.goto(context.origin + "/settings/model", { waitUntil: "domcontentloaded" });
    await page.getByTestId("settings-page").waitFor();
    await page.getByRole("heading", { level: 2, name: "模型服务" }).waitFor();

    // 1. 配置提醒经推送到达界面（横幅），分组导航亮起提示点
    const warning = page.getByTestId("model-config-warning");
    await warning.waitFor({ timeout: 30_000 }).catch((error: unknown) => {
      throw new Error(
        "等不到 Codex 的配置提醒：gate-c 的 CODEX_HOME 需要能确定性触发它——在 config.toml 顶层加一个 Codex 不认识的键" +
          "（如 suduo_gate_c_probe = true；scripts/gate-c-vm.sh 会自动加），或在没装 bubblewrap 的 Linux 上跑。原始错误：" +
          String(error),
      );
    });
    const warningText = (await warning.textContent()) ?? "";
    if (!warningText.includes("Codex 对当前配置有提醒")) {
      throw new Error(`模型服务分组应显示 Codex 的配置提醒，实际：${warningText}`);
    }
    const modelLink = nav.getByRole("link", { name: /^模型服务/ });
    const modelLinkText = (await modelLink.textContent()) ?? "";
    if (!/需要留意|有问题/.test(modelLinkText)) {
      throw new Error(`有配置提醒时「模型服务」分组应有提示点，实际：${modelLinkText}`);
    }

    // 2. API Key 全程脱敏，界面上不出现明文（R4）
    const masked = page.getByTestId("model-api-key-masked");
    await masked.waitFor();
    const maskedText = (await masked.textContent()) ?? "";
    // 服务端只说密钥从哪里来、从不回传密钥：脱敏串（sk-xxxx****yyyy）、「未配置」、
    // Codex 登录时的「由 Codex 管理」、提供方配置了取 Key 命令 / 环境变量时的「由本机命令提供（…）」「来自环境变量 …」。
    const looksMasked =
      maskedText.includes("*") ||
      maskedText === "未配置" ||
      maskedText.includes("由 Codex 管理") ||
      maskedText.startsWith("由本机命令提供") ||
      maskedText.startsWith("来自环境变量");
    if (!looksMasked) {
      throw new Error(`API Key 必须脱敏展示，实际：${maskedText}`);
    }
    if (/sk-[A-Za-z0-9]{12,}/.test(maskedText)) {
      throw new Error("界面上出现了未脱敏的 API Key 明文，违反 R4");
    }
    await capture(context, "11-settings-model.png");

    // 3. Skills 与 MCP 各有分组
    await nav.getByRole("link", { name: /^Skills/ }).click();
    await page.getByRole("switch", { name: "使用个人 Skills 目录" }).waitFor();
    await nav.getByRole("link", { name: /^MCP 服务/ }).click();
    await page.getByTestId("mcp-panel").waitFor({ timeout: 30_000 });

    // 4. 诊断：每项给出确定结论；MCP 一项必须读到列表（不接受「没能完成检查」）
    await nav.getByRole("link", { name: /^诊断/ }).click();
    const health = page.getByRole("list", { name: "健康检查" });
    await health.waitFor();
    // 异步读取，首帧必然是「检查中」——等它落定再断言，而不是把断言放宽。
    const mcpItem = health.locator('[data-testid="health-item"][data-key="mcp"]:not([data-status="checking"])');
    await mcpItem.waitFor({ timeout: 60_000 });
    if ((await mcpItem.getAttribute("data-status")) === "unknown") {
      throw new Error(`诊断里的 MCP 一项应读到服务器列表，实际：${(await mcpItem.textContent()) ?? ""}`);
    }
    await health.locator('[data-testid="health-item"][data-key="model"]:not([data-status="checking"])').waitFor({ timeout: 60_000 });

    // 5. 自检的处理建议必须透出——团队成员卡住时最需要这个。界面上「处理建议」的条数必须等于
    //    自检结果里「没通过且带处理建议」的项数（有就不能漏）。Codex 0.143 时 installation / updates
    //    两项在 pnpm 工作区里必失败并带建议；0.159 起它们认得 pnpm 安装、通常是 ok，所以按实际结果对照。
    await page.getByTestId("settings-doctor-checks").waitFor({ timeout: 60_000 });
    const expectedRemediations = await page.evaluate(async () => {
      const response = await fetch("/api/v1/doctor");
      const body = (await response.json()) as { checks: Array<{ status: string; remediation?: string | null }> };
      return body.checks.filter(
        (check) => check.status !== "pass" && typeof check.remediation === "string" && check.remediation !== "",
      ).length;
    });
    const remediationCount = await page.getByTestId("doctor-remediation").count();
    if (remediationCount !== expectedRemediations) {
      throw new Error(`自检里有 ${String(expectedRemediations)} 项带处理建议，界面只透出了 ${String(remediationCount)} 条`);
    }
    await capture(context, "12-settings-doctor.png");

    // 回需求页，避免影响后续步骤的路由上下文
    await openSection(page, "需求");
    await page.getByTestId("requirements-board").waitFor({ timeout: 20_000 });
  },
};
