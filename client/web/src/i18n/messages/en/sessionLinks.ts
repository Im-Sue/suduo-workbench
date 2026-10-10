import type { Messages } from "../zh-CN/index.js";

export const sessionLinks = {
  read: {
    title: (agent: string, title: string, view: string) => `Read ${agent} · “${title}” · ${view}`,
    pending: (view: string) => `Read a session · ${view}`,
    views: {
      summary: "summary",
      conversation: (rounds: number) => (rounds === 1 ? "last exchange" : `last ${rounds} exchanges`),
      turns: "list of turns",
      turn: (turn: number) => `turn ${turn}`,
      changes: "accumulated changes",
    },
  },
  chip: {
    open: (title: string) => `Open session “${title}”`,
  },
  palette: {
    sessions: "Sessions",
    files: "Files",
    sessionMeta: (agent: string, project: string) => `${agent} · ${project}`,
  },
  continue: {
    button: "Hand off to another agent",
    title: "Hand off to another agent",
    description: (title: string) =>
      `Start a new session that picks up “${title}”. The new session references this one, and its first message is filled in for you to review before sending. The working directory and linked requirement stay the same.`,
    start: "Start",
    failed: (message: string) => `Couldn't start the new session: ${message}`,
    prefill: (link: string) => `Continue from ${link}: `,
  },
  banner: {
    continuedFrom: "Continued from",
    continuedBy: "Continued in",
    deleted: "(deleted)",
    session: (agent: string, title: string) => `${agent} · “${title}”`,
  },
  list: {
    continuedFrom: (title: string) => `Continued from “${title}”`,
  },
} satisfies Messages["sessionLinks"];
