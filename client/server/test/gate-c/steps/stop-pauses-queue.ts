import { capture, closeWaitWindow, startWaitWindow } from "./helpers.js";
import type { GateCStep } from "./types.js";

export const stopPausesQueueStep: GateCStep = {
  id: "stop-pauses-queue",
  async run(context) {
    const text = "PR7 queued message must not send after stop";
    await startWaitWindow(context);
    try {
      await context.page.getByTestId("message-input").fill(text);
      await context.page.getByTestId("queue-message").click();
      await context.page.getByTestId("queue-item").waitFor();
      await context.page.getByTestId("interrupt-turn").click();

      const paused = context.page.getByTestId("queue-paused");
      await paused.waitFor({ timeout: 10_000 });
      if (await paused.getAttribute("data-reason") !== "user_stop") {
        throw new Error("用户停止后 queue-paused 的原因不是 user_stop");
      }
      await paused.getByText("你点了停止", { exact: false }).waitFor();
      if (await context.page.getByTestId("queue-item").count() !== 1) {
        throw new Error("停止后队列项不应被自动取走");
      }
      if (await context.page.locator("[data-testid='user-message']").filter({ hasText: text }).count() !== 0) {
        throw new Error("停止中的排队文本不应已发送");
      }
      await capture(context, "18-stop-pauses-queue.png");

      await context.page.getByTestId("interrupt-turn").waitFor({ state: "hidden", timeout: 60_000 });
      await context.page.getByTestId("queue-item-delete").click();
      if (await context.page.getByTestId("queue-item").count() !== 0) {
        throw new Error("删除暂停队列项后仍有残留");
      }
      await context.page.getByTestId("queue-resume").click();
      await paused.waitFor({ state: "hidden", timeout: 10_000 });
      if (await context.page.locator("[data-testid='user-message']").filter({ hasText: text }).count() !== 0) {
        throw new Error("恢复空队列后不应补发已删除的文本");
      }
    } finally {
      await closeWaitWindow(context).catch(() => undefined);
    }
  },
};
