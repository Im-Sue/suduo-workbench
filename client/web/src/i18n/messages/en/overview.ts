import { plural } from "@suduo/client-contracts";
import type { Messages } from "../zh-CN/index.js";

/** "posted 3 comments" */
const items = (verb: string, one: string, other: string) => (count: number) =>
  plural("en", count, { one: `${verb} 1 ${one}`, other: `${verb} ${String(count)} ${other}` });
/** "updated the project 3 times" */
const times = (what: string) => (count: number) =>
  plural("en", count, { one: `${what} once`, other: `${what} ${String(count)} times` });

export const overview = {
  header: {
    title: "Overview",
    intro: (project: string | null) =>
      `Status breakdown, flow, and stalled requirements for ${project === null ? "the current project" : `“${project}”`}.`,
    realtime: {
      live: "Live",
      reconnecting: "Live updates disconnected. Reconnecting…",
      connecting: "Connecting to live updates…",
    },
  },
  failure: (label: string, message: string) => `Couldn't load ${label}: ${message}`,
  retry: "Retry",
  status: {
    title: "Status breakdown",
    total: (count: number) => plural("en", count, { one: "1 requirement", other: `${String(count)} requirements` }),
    failureLabel: "statistics",
    empty: "This project doesn't have any requirements yet.",
    createFirst: "Create the first one",
    tile: (status: string, count: number) =>
      plural("en", count, {
        one: `${status}: 1 requirement, show it`,
        other: `${status}: ${String(count)} requirements, show them`,
      }),
  },
  trend: {
    title: "Status flow",
    summary: (days: number, count: number) =>
      plural("en", count, {
        one: `1 status change in the last ${String(days)} days`,
        other: `${String(count)} status changes in the last ${String(days)} days`,
      }),
    rangeLabel: "Time range",
    rangeOption: (days: number) => `${String(days)} days`,
    failureLabel: "the status flow",
    empty: "No requirement changed status in this period.",
    tableCaption: (days: number) => `Times requirements moved to each status per day, last ${String(days)} days`,
    date: "Date",
    total: "Total",
    entered: (status: string) => `Moved to ${status}`,
    other: "Other",
    times: (count: number) => plural("en", count, { one: "1 time", other: `${String(count)} times` }),
  },
  stale: {
    title: "Stalled requirements",
    truncated: (total: number, shown: number) =>
      plural("en", shown, {
        one: `${String(total)} in total, showing the most urgent one`,
        other: `${String(total)} in total, showing the ${String(shown)} most urgent`,
      }),
    legacyRule:
      "The requirements service is an older version, so only the stalled requirements it reports are listed here. Once it's upgraded, each status's own pace is used.",
    rule: (rhythm: string) => `Listed after this long without changes: ${rhythm}. Longest stalled first.`,
    rhythmItem: (statuses: string, days: number) =>
      plural("en", days, { one: `${statuses} 1 day`, other: `${statuses} ${String(days)} days` }),
    rhythmSeparator: ", ",
    failureLabel: "stalled requirements",
    empty: "No stalled requirements. Everything is moving at its own pace.",
    lastUpdated: (name: string, when: string) => `Last updated by ${name} · ${when}`,
    warning: "Stalled",
    notice: "Needs a nudge",
    idleDays: (days: number) => plural("en", days, { one: "Idle 1 day", other: `Idle ${String(days)} days` }),
  },
  activity: {
    title: "Recent activity",
    failureLabel: "recent activity",
    empty: "No activity in this project yet.",
    showAll: (count: number) => `Show all ${String(count)}`,
    showLess: "Show less",
  },
  audit: {
    actions: {
      "project.created": "created the project",
      "project.updated": "updated the project",
      "project.archived": "archived the project",
      "project.restored": "restored the project",
      "requirement.created": "created a requirement",
      "requirement.updated": "updated a requirement",
      "requirement.status_changed": "changed a requirement's status",
      "comment.created": "posted a comment",
      "attachment.created": "uploaded an attachment",
      "attachment.downloaded": "downloaded an attachment",
      "attachment.deleted": "deleted an attachment",
      "artifact_version.published": "published a confirmed version",
    },
    resources: {
      project: "project",
      requirement: "requirement",
      comment: "comment",
      attachment: "attachment",
    },
    unknown: (resource: string, action: string) => `performed ${action} on ${resource}`,
    groups: {
      "project.created": items("created", "project", "projects"),
      "project.updated": times("updated the project"),
      "project.archived": times("archived the project"),
      "project.restored": times("restored the project"),
      "requirement.created": items("created", "requirement", "requirements"),
      "requirement.updated": items("made", "requirement update", "requirement updates"),
      "requirement.status_changed": items("made", "status change", "status changes"),
      "comment.created": items("posted", "comment", "comments"),
      "attachment.created": items("uploaded", "attachment", "attachments"),
      "attachment.downloaded": items("downloaded", "attachment", "attachments"),
      "attachment.deleted": items("deleted", "attachment", "attachments"),
      "artifact_version.published": items("published", "confirmed version", "confirmed versions"),
    },
    groupFallback: items("handled", "record", "records"),
    statusChanged: "Status changed",
  },
} satisfies Messages["overview"];
