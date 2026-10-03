import {
  capture,
  closeWaitWindow,
  MODEL_WRAP_UP_TIMEOUT_MS,
  removeWaitWindowMarker,
  startWaitWindow,
  waitForTurnTerminal,
} from "./helpers.js";
import type { GateCStep } from "./types.js";

export const queueAutoDispatchStep: GateCStep = {
  id: "queue-auto-dispatch",
  async run(context) {
    const text = "PR7 queued message dispatches after terminal";
    await startWaitWindow(context);
    try {
      await context.page.getByTestId("message-input").fill(text);
      await context.page.getByTestId("queue-message").click();
      const queueItem = context.page.getByTestId("queue-item");
      await queueItem.waitFor();
      if (await queueItem.getAttribute("data-index") !== "0") {
        throw new Error("新排队项不是队首 data-index=0");
      }
      // 有队列项时，旧回合 terminal 与新回合 started 间的 hidden 极短；不能先等 hidden。
      const queuedMessage = context.page.locator("[data-testid='user-message']").filter({ hasText: text }).last();
      // 要等前一轮（sleep 45 + 模型收尾）结束才会出队。
      await queuedMessage.waitFor({
        timeout: MODEL_WRAP_UP_TIMEOUT_MS,
      });
      await context.page.getByTestId("interrupt-turn").waitFor({ timeout: 30_000 });
      await context.page.waitForFunction(
        (queuedText) => {
          const user = [...document.querySelectorAll<HTMLElement>("[data-testid='user-message']")]
            .find((node) => node.textContent?.includes(queuedText));
          return user !== undefined && [...document.querySelectorAll("[data-testid='assistant-text']")].some(
            (assistant) => Boolean(user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING),
          );
        },
        text,
        { timeout: 60_000 },
      );
      const attribution = queuedMessage.getByTestId("message-attribution");
      await attribution.waitFor();
      if (await attribution.getAttribute("data-attribution") !== "new-turn") {
        throw new Error("自动出队消息未作为终态后的独立新一轮归属");
      }
      await waitForTurnTerminal(context.page, MODEL_WRAP_UP_TIMEOUT_MS);
      if (await context.page.getByTestId("queue-item").count() !== 0) {
        throw new Error("队首自动发出后仍残留 queue-item");
      }
      if (await context.page.getByTestId("queue-paused").count() !== 0) {
        throw new Error("队首自动发出不应进入暂停态");
      }
      removeWaitWindowMarker(context);
      await capture(context, "17-queue-auto-dispatch.png");
    } finally {
      await closeWaitWindow(context).catch(() => undefined);
    }
  },
};
