import { plural } from "@suduo/client-contracts";
import type { ServerMessages } from "../zh-CN/index.js";

export const activity = {
  step: {
    thinking: "Thinking",
    replying: "Replying",
    // 「Running npm test」→「Just finished running npm test」。
    justFinished: (step: string) => `Just finished ${step.charAt(0).toLowerCase()}${step.slice(1)}`,
    runCommand: "Running a command",
    runCommandWith: (command: string) => `Running ${command}`,
    editFiles: "Editing files",
    editFile: (name: string) => `Editing ${name}`,
    editFilesMany: (name: string, count: number) =>
      plural("en", count - 1, {
        one: `Editing ${name} and 1 more file`,
        other: `Editing ${name} and ${String(count - 1)} more files`,
      }),
    callTool: "Calling a tool",
    callToolWith: (tool: string) => `Calling ${tool}`,
    webSearch: "Searching the web",
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
