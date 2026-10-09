import { plural } from "@suduo/client-contracts";
import type { Messages } from "../zh-CN/index.js";

const files = (count: number) => plural("en", count, { one: "1 file", other: `${count} files` });

export const collab = {
  delegation: {
    title: (agent: string) => `Delegated · ${agent}`,
    status: {
      queued: "Queued",
      running: "Running",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      interrupted: "Interrupted",
    },
    waitingApproval: (count: number) => `${plural("en", count, { one: "1 action needs", other: `${count} actions need` })} your approval`,
    fromUser: "Started by you",
    fromAgent: "Started by the agent",
    autoHandback: "Hands back automatically",
    stop: "Stop",
    open: "Open child session",
    childDeleted: "Child session deleted",
    handback: "Let the original agent continue",
    handedBack: "Result handed back",
    finalMessage: "Child session's final answer",
    noFinalMessage: "The child session gave no text answer.",
    changedFiles: (count: number, additions: number, deletions: number) => `Changed ${files(count)} · +${additions} −${deletions}`,
    error: (message: string) => `Reason: ${message}`,
    failures: {
      stop: "Couldn't stop the delegation",
      handback: "Couldn't hand back the result",
      start: "Couldn't delegate",
    },
    started: (agent: string) => `Delegated to ${agent}`,
    textOnly: "Delegations can only carry text for now. After delegating, open the child session to send it attachments or skills.",
    oneAgent: "You can delegate to one agent at a time.",
  },
  queue: {
    queued:
      "This message is in the local queue (this computer is running as many turns as it's allowed to, or earlier messages in this session haven't started yet). It starts automatically when it's its turn. Check its position under Runs in the sidebar.",
    dequeued: "The queued message was cancelled and wasn't sent to the agent.",
    dequeuedRestart: "The local service restarted, so this queued message wasn't sent. Send it again if you still need it.",
    dequeuedInactive: "The session was archived or deleted, so this queued message wasn't sent.",
    dequeuedRequeued: "The local service restarted, so this queued delegated task was queued again automatically.",
    startFailed: (message: string) => `This turn couldn't start: ${message}`,
    cancel: "Cancel",
    cancelFailed: "Couldn't cancel the queued message",
  },
  approval: {
    origin: (agent: string, task: string) => `From a delegation: ${agent} · ${task}`,
  },
  cascade: {
    title: "Stop the subtasks too?",
    description: (count: number) =>
      `This session has ${plural("en", count, { one: "1 unfinished delegation", other: `${count} unfinished delegations` })}. When you stop this turn, you can stop them too (recommended) or let them keep going.`,
    stopAll: "Stop all",
    stopThis: "Stop this turn only",
  },
  panel: {
    button: "Runs",
    buttonLabel: (running: number, queued: number) => `${running} running and ${queued} queued on this computer`,
    title: "Running on this computer",
    summary: (running: number, global: number) => `Running ${running}/${global}`,
    agentUsage: (running: number, limit: number) => `${running}/${limit}`,
    queuedTitle: "Queued",
    empty: "Nothing is running right now.",
    position: (position: number) => `#${position}`,
    promote: "Run next",
    cancel: "Cancel",
    stop: "Stop",
    open: "Open session",
    source: { user: "Session", delegate: "Delegation", room: "Room task", review: "Review", trial: "Trial" },
    loadFailed: (message: string) => `Couldn't load what's running: ${message}`,
    settings: "Adjust limits",
  },
  palette: {
    agents: "Delegate to an agent",
    agentHint: (agent: string) => `Hand this message to ${agent} as a task`,
  },
  settings: {
    title: "Running at the same time",
    description:
      "How many turns can run at once on this computer. Anything beyond the limit is queued, never refused. Lower it if a personal subscription has usage limits.",
    global: "All agents combined",
    perAgent: (agent: string) => `${agent} at most`,
  },
} satisfies Messages["collab"];
