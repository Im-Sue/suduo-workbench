import { plural } from "@suduo/client-contracts";
import type { ServerMessages } from "../zh-CN/index.js";

export const delegation = {
  spec: {
    agentList:
      "Read-only: list the agents on this computer you can delegate to (id, name, status, running / queued turns, and the concurrency limit). Check it before delegating.",
    start: {
      description:
        "Hand a subtask to another agent on this computer (in a new child session). Returns a delegation ID right away without waiting for it to finish. " +
        "The child session works in the same folder with permissions no higher than this session's. It can't see your conversation, so spell out what to do, when it's done, and the relevant files. " +
        "Then use suduo_delegate_wait for the result; you can do other work in the meantime. The child session's approvals show up in the user's UI.",
      agentId: "Which agent to delegate to (an id from suduo_agent_list, such as claude-code or codex).",
      task: "The task: what to do, how to tell it's done, and anything to watch out for.",
      files: "Relevant files (paths relative to the project), optional.",
      autoHandback:
        "If you've already ended this turn when the subtask finishes, whether to start a new turn automatically to hand you the result (default no: the user decides in the UI).",
      approvalMode: "The child session's permission: readonly / ask / auto / full, no higher than this session's. Defaults to this session's.",
    },
    wait: {
      description:
        "Wait for a delegated subtask. When it's done, returns the result (final answer, changed files, child session ID); otherwise returns progress after maxSeconds so you can wait again or do something else.",
      delegationId: "The delegation ID from suduo_delegate_start.",
      maxSeconds: "How many seconds to wait at most. Defaults to 240 (can't exceed the tool timeout).",
    },
    send: {
      description: "Send the child session another message (more requirements, or an answer to its question). It starts the child session's next turn.",
      delegationId: "The delegation ID.",
      message: "What to add.",
    },
    cancel: {
      description: "Cancel a delegation: a queued one won't start, a running one is interrupted.",
      delegationId: "The delegation ID.",
    },
  },

  reply: {
    agentsHeader: "Agents you can delegate to:",
    agentLine: (id: string, name: string, status: string, running: number, queued: number, limit: number) =>
      `- ${id} (${name}) · ${status} · running ${running}/${limit}${queued > 0 ? ` · queued ${queued}` : ""}`,
    noAgents: "There are no agents to delegate to on this computer (they may not be installed, signed in, or may be turned off in settings).",
    agentStatus: { ready: "ready", installed: "installed", unknown: "unconfirmed" } as Record<string, string>,
    started: (id: string, agent: string, status: string) =>
      `Delegated to ${agent}. Delegation ID: ${id} (${status}). Use suduo_delegate_wait for the result.`,
    status: {
      queued: "queued",
      running: "running",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
      interrupted: "interrupted",
    } as Record<string, string>,
    header: (agent: string, task: string, status: string) => `Delegated to ${agent}: “${task}” · ${status}`,
    childSession: (id: string) => `Child session: suduo://session/${id} (read it with suduo_session_read when you need details)`,
    pendingApprovals: (count: number) =>
      `${plural("en", count, { one: "1 action is", other: `${count} actions are` })} waiting for the user's approval in the child session.`,
    queuePosition: (position: number) => `Position ${position} in this computer's queue.`,
    progress: (steps: number, last: string | null) =>
      `Progress: ${plural("en", steps, { one: "1 step", other: `${steps} steps` })} so far${last === null ? "" : `; latest: ${last}`}`,
    stillRunning: "Not done yet. You can wait again or do something else first.",
    finalMessage: "[The child session's final answer]",
    noFinalMessage: "(The child session gave no text answer.)",
    changedFiles: (count: number, additions: number, deletions: number) =>
      `[Changed files: ${plural("en", count, { one: "1 file", other: `${count} files` })}, +${additions} −${deletions}]`,
    fileLine: (path: string, kind: string) => `- ${path} (${kind})`,
    fileKind: { add: "added", delete: "deleted", update: "modified" } as Record<string, string>,
    error: (message: string) => `Reason: ${message}`,
    delegationIdMissing: "Missing delegationId.",
    agentIdMissing: "Missing agentId (an id from suduo_agent_list).",
    taskMissing: "Missing task (the task description).",
    messageMissing: "Missing message.",
    notFound: (id: string) => `There's no delegation with the ID ${id} (or it wasn't started by this session).`,
    notMain: "A child session can't delegate further (only main sessions the user started can delegate).",
    childGone: "The child session was deleted, so you can't send it more messages.",
    cancelled: "Cancelled.",
    unknownAgent: (agentId: string) => `There's no agent called ${agentId} (use suduo_agent_list to see who you can delegate to).`,
    agentUnavailable: (agentId: string) => `This version of SuDuo can't delegate to ${agentId} yet.`,
    agentDisabled: (name: string) => `${name} is turned off in the AI agent settings, so you can't delegate to it.`,
  },

  role: (parentAgent: string, parentSessionId: string) =>
    [
      "# Delegated subtask",
      `You're running a subtask delegated by ${parentAgent} (the delegating session: suduo://session/${parentSessionId}; read it with suduo_session_read when you need background).`,
      "- Do only what the task asks. When you're done, sum up in one paragraph what you did, which files you changed, and what's left.",
      "- You can't delegate to other agents.",
    ].join("\n"),
  firstMessage: (task: string, files: readonly string[]) =>
    files.length === 0 ? task : `${task}\n\nRelevant files:\n${files.map((file) => `- ${file}`).join("\n")}`,
  handback: (agent: string, task: string, status: string, body: string, childSessionId: string | null) =>
    [
      `Delegation result (${agent}: “${task}” · ${status}):`,
      "",
      body,
      ...(childSessionId === null ? [] : ["", `Child session: suduo://session/${childSessionId}`]),
      "",
      "Please continue based on this result.",
    ].join("\n"),
  restartInterrupted: "The local service restarted before it finished",
} satisfies ServerMessages["delegation"];
