import { capture } from "./helpers.js";
import type { GateCStep } from "./types.js";

export const finalInterruptStep: GateCStep = {
  id: "final-interrupt",
  async run(context) {
    await context.page.getByTestId("message-input").fill(
      "请从 1 数到 10000，每行一个数字，不要省略。",
    );
    await context.page.getByTestId("send-message").click();
    await context.page.getByTestId("interrupt-turn").waitFor({ timeout: 60_000 });
    await context.page.getByTestId("interrupt-turn").click();
    await context.page.getByTestId("interrupt-turn").waitFor({ state: "hidden", timeout: 60_000 });
    await capture(context, "05-final-suduo.png");
    if (context.pageErrors.length > 0) {
      throw new Error("browser page errors: " + context.pageErrors.join(" | "));
    }
  },
};
