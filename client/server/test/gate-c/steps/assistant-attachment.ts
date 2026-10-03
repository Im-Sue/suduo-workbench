import { pasteTinyPng, waitForTurnTerminal } from "./helpers.js";
import type { GateCStep } from "./types.js";

export const assistantAttachmentStep: GateCStep = {
  id: "assistant-attachment",
  async run(context) {
    await pasteTinyPng(context.page);
    await context.page.getByTestId("attachment-chip").waitFor();
    await context.page.getByTestId("message-input").fill(
      "查看粘贴的图片，只回复 image input ok。",
    );
    await context.page.getByTestId("send-message").click();
    await context.page.locator("[data-testid='assistant-text']").filter({
      hasText: "image input ok",
    }).waitFor({ timeout: 180_000 });
    await waitForTurnTerminal(context.page);
  },
};
