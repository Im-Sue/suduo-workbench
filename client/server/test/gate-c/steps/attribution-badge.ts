import { capture, closeWaitWindow, startWaitWindow } from "./helpers.js";
import type { GateCStep } from "./types.js";

/**
 * PR7 的运行中第二次 turn/start 真实探针。
 * 不接受“已提交”永久停留：只有服务端回填 clientId 并投影到账本，归属才有意义。
 */
export const attributionBadgeStep: GateCStep = {
  id: "attribution-badge",
  async run(context) {
    const text = "PR7 attribution probe: running second turn";
    await startWaitWindow(context);
    try {
      await context.page.getByTestId("message-input").fill(text);
      await context.page.getByTestId("send-message").click();
      const userMessage = context.page.locator("[data-testid='user-message']").filter({ hasText: text }).last();
      await userMessage.waitFor({ timeout: 30_000 });
      const attribution = userMessage.getByTestId("message-attribution");
      await attribution.waitFor();
      if (await attribution.getAttribute("data-attribution") !== "submitted") {
        throw new Error("运行中第二次发送的归属标记未先显示 submitted");
      }
      await capture(context, "16-attribution-badge.png");
      await closeWaitWindow(context);
      const finalAttribution = await attribution.getAttribute("data-attribution");
      if (finalAttribution !== "merged" && finalAttribution !== "new-turn") {
        throw new Error(
          `运行中第二次 turn/start 未被真实归属：data-attribution=${String(finalAttribution)}`,
        );
      }
    } finally {
      await closeWaitWindow(context).catch(() => undefined);
    }
  },
};
