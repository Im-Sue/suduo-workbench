import type { Messages } from "../zh-CN/index.js";

export const sessions = {
  effort: {
    none: "No reasoning",
    minimal: "Fastest",
    low: "Fast",
    medium: "Balanced",
    high: "Deep",
    xhigh: "Deepest",
    max: "Max",
    ultra: "Max+",
  },
  checkpoints: {
    turnStart: "Auto-saved before turn",
    manual: (note: string) => `Checkpoint: ${note}`,
  },
} satisfies Messages["sessions"];
