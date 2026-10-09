import { plural } from "@suduo/client-contracts";
import type { ReactNode } from "react";
import type { Messages } from "../zh-CN/index.js";

export const myWork = {
  header: {
    title: "My work",
    intro: "What needs you, running sessions, and your requirements across all projects.",
    refresh: "Refresh",
  },
  loading: "Loading",
  unavailable: (label: string, message: string) => `Can't load ${label} right now: ${message}`,
  retry: "Retry",
  fallback: {
    localProject: "Local project",
    project: "Project",
    requirement: "Requirement",
    requirementUnavailable: "Requirement unavailable",
    requirementSession: "Requirement session",
    untitledSession: "Untitled session",
    someone: "Someone",
  },
  attention: {
    title: "Needs your attention",
    unavailableLabel: "your to-dos",
    empty: "All caught up. Nothing needs you right now.",
    pendingApproval: {
      title: (session: string) => `Waiting for you · ${session}`,
      count: (count: number) =>
        plural("en", count, { one: "1 approval waiting for you", other: `${String(count)} approvals waiting for you` }),
      action: "Review",
    },
    pendingReview: {
      title: (session: string) => `Review feedback to handle · ${session}`,
      detail: (agent: string, count: number) => `${agent} returned ${plural("en", count, { one: "1 finding", other: `${String(count)} findings` })}, none handed back yet`,
      action: "Take a look",
    },
    failedTurn: {
      title: (session: string) => `Last turn didn't finish · ${session}`,
      action: "See why",
    },
    drift: {
      title: (requirement: string) => `Changed since you started · ${requirement}`,
      detail: (sessions: number) =>
        plural("en", sessions, {
          one: "1 session is working on it, and what it saw at the start is out of date",
          other: `${String(sessions)} sessions are working on it, and what they saw at the start is out of date`,
        }),
      action: "See what changed",
    },
    newComments: {
      title: (requirement: string) => `New comments · ${requirement}`,
      detail: (count: number) =>
        plural("en", count, { one: "1 comment you haven't read", other: `${String(count)} comments you haven't read` }),
      action: "View",
    },
    stale: {
      title: (requirement: string) => `Stalled · ${requirement}`,
      days: (days: number) => plural("en", days, { one: "No changes in 1 day", other: `No changes in ${String(days)} days` }),
      action: "Move it forward",
    },
    invalidMapping: {
      title: (project: string) => `Local folder unavailable · ${project}`,
      detail: "The folder may have been moved or deleted. Choose it again.",
      action: "Choose folder",
    },
  },
  requirements: {
    title: "My requirements",
    scopeLabel: "Requirement scope",
    scopeAll: "All projects",
    scopeCurrent: "Current project",
    workingUnavailableLabel: "requirements you're working on",
    listUnavailableLabel: "requirements assigned to or created by you",
    empty:
      "No requirements assigned to you, in progress, or created by you without an assignee. Assign one to yourself on the Requirements page, or start a session from a requirement.",
    statusUnknown: "Unknown status",
    drift: "Changed since you started",
    waiting: "Waiting for you",
    running: "Running",
    sessions: (count: number) => plural("en", count, { one: "1 session", other: `${String(count)} sessions` }),
    unreadComments: (count: number) => plural("en", count, { one: "1 new comment", other: `${String(count)} new comments` }),
    assignedToMe: "Assigned to you",
    createdUnassigned: "Created by you · Unassigned",
  },
  sessions: {
    title: "Sessions",
    activeCount: (count: number) => `${String(count)} in progress`,
    unavailableLabel: "local sessions",
    empty: "No sessions on this computer yet. Start one from a requirement on the Requirements page.",
    card: {
      running: "Running",
      approval: (count: number) =>
        plural("en", count, { one: "Waiting for you: 1 approval", other: `Waiting for you: ${String(count)} approvals` }),
      failedTurn: "Last turn didn't finish",
      error: "Session error",
      completed: "Completed",
      idle: "Idle",
    },
    elapsed: (duration: string) => `${duration} elapsed`,
    previewFromYou: "You: ",
  },
  recent: {
    title: "Recent activity",
    empty: "No one else has changed your requirements recently.",
    updated: (who: ReactNode, number: ReactNode, title: string): ReactNode[] => [who, " updated ", number, " ", title],
  },
  setupChecklist: {
    label: "Unfinished setup",
    remaining: (count: number) => plural("en", count, { one: "1 setup item left", other: `${String(count)} setup items left` }),
    dismiss: "Don't show again",
    link: "Link",
    recheck: "Check again",
  },
  fixMapping: {
    title: "Choose a new local folder",
    description: (project: string | null) =>
      `${project === null ? "This project's local folder" : `The local folder for “${project}”`} is no longer available. Choose a folder SuDuo can read and write. This project's sessions will run there from now on.`,
    pathRequired: "Choose a folder first.",
    pathInvalid: "This folder can't be used right now. Choose one SuDuo can read and write.",
    cancel: "Cancel",
    save: "Use this folder",
  },
} satisfies Messages["myWork"];
