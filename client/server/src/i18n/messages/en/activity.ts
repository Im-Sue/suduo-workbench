import { plural } from "@suduo/client-contracts";
import type { ServerMessages } from "../zh-CN/index.js";

export const activity = {
  step: {
    thinking: "Thinking",
    replying: "Replying",
    justFinished: (step: string) => `Just finished: ${step}`,
    runCommand: "Run command",
    runCommandWith: (command: string) => `Run ${command}`,
    editFiles: "Edit files",
    editFile: (name: string) => `Edit ${name}`,
    editFilesMany: (name: string, count: number) =>
      plural("en", count - 1, {
        one: `Edit ${name} and 1 more file`,
        other: `Edit ${name} and ${String(count - 1)} more files`,
      }),
    callTool: "Call tool",
    callToolWith: (tool: string) => `Call ${tool}`,
    webSearch: "Search the web",
  },
  agent: {
    notSignedIn: "Not signed in to the requirements service yet",
    registering: "Registering your local agent",
    signInExpired: "Your sign-in to the requirements service has expired. Sign in again.",
    registerFailed: (reason: string) => `Couldn't register your local agent: ${reason}`,
    needsReregister: "Your local agent needs to register again",
    heartbeatFailed: (reason: string) => `Local agent heartbeat failed: ${reason}`,
  },
} satisfies ServerMessages["activity"];
