import type { Messages } from "../zh-CN/index.js";

export const sessions = {
  checkpoints: {
    turnStart: "Auto-saved before turn",
    manual: (note: string) => `Checkpoint: ${note}`,
  },
} satisfies Messages["sessions"];
