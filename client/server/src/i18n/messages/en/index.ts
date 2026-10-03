import type { ServerMessages } from "../zh-CN/index.js";

export const en = {
  checkpoint: {
    autoSubject: "SuDuo auto-save: before turn",
    manualPrefix: "SuDuo checkpoint: ",
    beforeRestore: "Saved before restore",
    restoredTo: (hash: string) => `Restored to ${hash}`,
  },
} satisfies ServerMessages;
