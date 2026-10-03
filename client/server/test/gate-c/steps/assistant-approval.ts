import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { capture, pickSkill, waitForFile, waitForTurnTerminal } from "./helpers.js";
import type { GateCStep } from "./types.js";

export const assistantApprovalStep: GateCStep = {
  id: "assistant-approval",
  async run(context) {
    await pickSkill(context.page, "gate-c-workflow");
    await context.page.getByTestId("message-input").fill(
      "执行 accept 阶段：严格按 skill 指令实际运行命令并创建 GATE_C_ACCEPT.md，然后简短回复。",
    );
    await context.page.getByTestId("send-message").click();
    await context.page.getByTestId("approval-card").waitFor({ timeout: 180_000 });
    await capture(context, "01-approval-card.png");
    await context.page.getByTestId("approval-accept").click();
    await waitForFile(resolve(context.projectRoot, "GATE_C_ACCEPT.md"), true, 60_000);
    await context.page.getByTestId("approval-card").waitFor({ state: "hidden", timeout: 60_000 });
    await waitForTurnTerminal(context.page);

    await pickSkill(context.page, "gate-c-workflow");
    await context.page.getByTestId("message-input").fill(
      "执行 decline 阶段：严格按 skill 指令尝试运行命令创建 GATE_C_DECLINE.md。",
    );
    await context.page.getByTestId("send-message").click();
    await context.page.getByTestId("approval-card").waitFor({ timeout: 180_000 });
    await context.page.getByTestId("approval-decline").click();
    await context.page.getByTestId("approval-card").waitFor({ state: "hidden", timeout: 60_000 });
    await waitForTurnTerminal(context.page);
    if (existsSync(resolve(context.projectRoot, "GATE_C_DECLINE.md"))) {
      throw new Error("declined skill command created GATE_C_DECLINE.md");
    }
  },
};
