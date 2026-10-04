import { plural } from "@suduo/client-contracts";
import type { ServerMessages } from "../zh-CN/index.js";

export const room = {
  clipped: (total: number) =>
    `… (cut off here; ${plural("en", total, { one: "1 character", other: `${String(total)} characters` })} in total)`,
  noTextReply: "(No text answer this time. See the run details.)",
  replyClipped:
    "\n\n… (The answer was too long, so the rest was cut off. The full answer is in the room task session on the owner's computer.)",
} satisfies ServerMessages["room"];
