import { capture } from "./helpers.js";
import type { GateCStep } from "./types.js";

export const interruptAndReopenStep: GateCStep = {
  id: "interrupt-and-reopen",
  async run(context) {
    await context.page.getByTestId("message-input").fill(
      "请逐行输出从 1 到 10000，每行一个数字，不要省略。",
    );
    await context.page.getByTestId("send-message").click();
    await context.page.getByTestId("interrupt-turn").waitFor({ timeout: 60_000 });
    await context.page.close();
    const page = await context.browserContext.newPage();
    page.on("pageerror", (error) => context.pageErrors.push(error.message));
    context.page = page;
    if (!context.localProjectId || !context.sessionId) {
      throw new Error("interrupt-and-reopen requires the V2 project and session route state");
    }
    // P1 起会话深链接是 /sessions/<id>（旧 ?projectId=&sessionId= 只做重定向）。
    await page.goto(`${context.origin}/sessions/${context.sessionId}`, {
      waitUntil: "domcontentloaded",
    });
    // P3：消息流按回合渲染，任一回合出现即说明历史已回放。
    await page.getByTestId("turn").first().waitFor({ timeout: 20_000 });
    await capture(context, "03-page-recovery.png");
    const interrupt = page.getByTestId("interrupt-turn");
    if (await interrupt.isVisible().catch(() => false)) {
      await interrupt.click();
      await interrupt.waitFor({ state: "hidden", timeout: 60_000 });
    }
  },
};
