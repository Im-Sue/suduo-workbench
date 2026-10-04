import type { ServerMessages } from "../zh-CN/index.js";

export const checkpoint = {
  autoSubject: "SuDuo auto-save: before turn",
  manualPrefix: "SuDuo checkpoint: ",
  beforeRestore: "Saved before restore",
  restoredTo: (hash: string) => `Restored to ${hash}`,
  initSubject: "SuDuo: initialize version control",
} satisfies ServerMessages["checkpoint"];
