import { capture } from "./helpers.js";
import type { GateCStep } from "./types.js";

export const changesAndDiffStep: GateCStep = {
  id: "changes-and-diff",
  async run(context) {
    await context.page
      .getByTestId("change-item")
      .filter({ hasText: "GATE_C_ACCEPT.md" })
      .waitFor({ timeout: 30_000 });
    await context.page.getByTestId("change-item").filter({ hasText: "GATE_C_ACCEPT.md" }).click();
    await context.page.getByTestId("diff-view").waitFor();
    await capture(context, "02-diff-view.png");
    await context.page.keyboard.press("Escape");
    await context.page.getByTestId("diff-view").waitFor({ state: "hidden" });
  },
};
