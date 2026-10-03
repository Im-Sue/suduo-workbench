import {
  capture,
  findCodexDescendant,
  waitForNewCodexDescendant,
  waitForTurnTerminal,
} from "./helpers.js";
import type { GateCStep } from "./types.js";

export const supervisorRecoveryStep: GateCStep = {
  id: "supervisor-recovery",
  async run(context) {
    const mainPid = Number(
      context.runCapture(
        "systemctl",
        ["--user", "show", "suduo-gate-c.service", "--property", "MainPID", "--value"],
        0,
      ).stdout.trim(),
    );
    context.runtimePidBeforeCrash = findCodexDescendant(context, mainPid);
    process.kill(context.runtimePidBeforeCrash, "SIGKILL");
    context.runtimePidAfterCrash = await waitForNewCodexDescendant(
      context,
      mainPid,
      context.runtimePidBeforeCrash,
      30_000,
    );
    await context.page
      .getByRole("alert")
      .filter({ hasText: "会话已恢复，可继续工作" })
      .waitFor({ timeout: 30_000 });
    await context.page.getByTestId("message-input").fill("请只回复 supervisor recovered ok。");
    await context.page.getByTestId("send-message").click();
    await context.page.locator("[data-testid='assistant-text']").filter({
      hasText: "supervisor recovered ok",
    }).waitFor({ timeout: 180_000 });
    await waitForTurnTerminal(context.page);
    await capture(context, "04-supervisor-recovered.png");
  },
};
