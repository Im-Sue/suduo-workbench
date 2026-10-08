import { plural } from "@suduo/client-contracts";
import type { ServerMessages } from "../zh-CN/index.js";

export const room = {
  codexNotRemovable: "Codex is registered on this computer by default and can't be removed",
  agentNotReadOnly: (name: string) =>
    `${name} can't run read-only (it may write files without asking), so it can't be shared in rooms or run room tasks`,
  agentDisabled: (name: string) => `${name} is turned off in this computer's AI agent settings, so it doesn't run room tasks`,
  agentUnsupported: (agentId: string) => `This version of SuDuo can't use ${agentId} in rooms`,
  clipped: (total: number) =>
    `… (cut off here; ${plural("en", total, { one: "1 character", other: `${String(total)} characters` })} in total)`,
  noTextReply: "(No text answer this time. See the run details.)",
  replyClipped:
    "\n\n… (The answer was too long, so the rest was cut off. The full answer is in the room task session on the owner's computer.)",
} satisfies ServerMessages["room"];
