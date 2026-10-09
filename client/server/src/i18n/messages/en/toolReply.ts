import { plural } from "@suduo/client-contracts";
import type { ServerMessages } from "../zh-CN/index.js";

const characters = (count: number) =>
  plural("en", count, { one: "1 character", other: `${String(count)} characters` });
const files = (count: number) => plural("en", count, { one: "1 file", other: `${String(count)} files` });

const navigation = (nextCursor: string | null) =>
  nextCursor === null ? "This is the last page." : `Next page: cursor=${nextCursor}`;

export const toolReply = {
  what: {
    neededInfo: "the information needed",
    requirement: (number: string) => `requirement ${number}`,
    currentRequirement: "the current requirement",
    comments: (label: string) => `the comments on ${label}`,
    attachmentList: (label: string) => `the attachment list of ${label}`,
    attachmentContent: (fileName: string) => `the content of attachment “${fileName}”`,
    file: (fileName: string) => `the file “${fileName}”`,
  },
  args: {
    missing: (name: string) => `Missing parameter ${name}.`,
    numberType: "The number parameter should be a requirement number, e.g. \"REQ-12\" or 12.",
    numberFormat: (value: string) => `The requirement number “${value}” isn't in the right format. It should be REQ-12 or 12.`,
    projectSession:
      "This is a project session with no linked requirement. Give a requirement number in the number parameter, e.g. REQ-12.",
  },
  files: {
    body: (version: number) => `requirement-description-v${String(version)}.md`,
    fallbackName: "attachment",
    empty: (fileName: string) => `Couldn't look up the file “${fileName}”: the requirements service returned empty content.`,
    saveFailed: (fileName: string, reason: string) => `The file “${fileName}” wasn't saved: ${reason}.`,
  },
  get: {
    status: (status: string, priority: string, assignee: string, version: number) =>
      `- Status: ${status}; Priority: ${priority}; Assignee: ${assignee}; Current version: v${String(version)}`,
    startVersion: (version: number) => ` (v${String(version)} when work started)`,
    created: (createdBy: string, createdAt: string, updatedBy: string, updatedAt: string) =>
      `- Created: ${createdBy}, ${createdAt}; Last edited: ${updatedBy}, ${updatedAt}`,
    counts: (comments: number, attachments: number) =>
      `- ${plural("en", comments, { one: "1 comment", other: `${String(comments)} comments` })}; ` +
      `${plural("en", attachments, { one: "1 attachment", other: `${String(attachments)} attachments` })} ` +
      "(view them with suduo_requirement_comments / suduo_requirement_attachments)",
    changesHeading: (startedAt: string) => `## Changes since work started (work started at ${startedAt})`,
    anchorUnknown:
      "- Note: the requirements service's change-log boundary wasn't available when work started, so the list below uses the local start time. Changes within a few minutes of it may be off.",
    bodyHeading: "## Description",
    bodyEmpty: "(The description is empty)",
    bodySaved: (length: number, path: string) =>
      `The description has ${characters(length)}, which is too long. The full text was saved to ${path}; read that file directly. The beginning:`,
    previewEllipsis: "…",
  },
  changes: {
    unavailable: (reason: string) =>
      `- Couldn't look up the changes since work started: ${reason}. This doesn't mean there were no changes.`,
    none: "- No changes since work started.",
    limited: (total: number, shown: number) =>
      `- (${plural("en", total, { one: "1 change", other: `${String(total)} changes` })} in total; ` +
      `${plural("en", shown, { one: "only the latest one is listed", other: `only the latest ${String(shown)} are listed` })})`,
    partial: "- (There are many changes; only the latest ones are listed)",
  },
  activity: {
    created: "created the requirement",
    commented: (text: string) => `commented: “${text}”`,
    attachmentAdded: (fileName: string) => `uploaded attachment “${fileName}”`,
    attachmentDeleted: (fileName: string) => `deleted attachment “${fileName}”`,
    published: (version: number | string, fileCount: number) =>
      `published confirmed version v${String(version)} (${files(fileCount)})`,
    titleChanged: (from: string, to: string) => `changed the title from “${from}” to “${to}”`,
    summaryChanged: "edited the description (see the current description above)",
    statusChanged: (from: string, to: string) => `changed the status from “${from}” to “${to}”`,
    assigneeChanged: (from: string, to: string) => `changed the assignee from “${from}” to “${to}”`,
    priorityChanged: (from: string, to: string) => `changed the priority from “${from}” to “${to}”`,
    updated: "updated the requirement",
    join: (parts: readonly string[]) => parts.join(", "),
  },
  comments: {
    none: (label: string) => `${label} has no comments yet.`,
    header: (label: string, count: number, nextCursor: string | null) =>
      `Comments on ${label} (${String(count)} on this page; ` +
      `${nextCursor === null ? "this is the last page" : `next page: cursor=${nextCursor}`}):`,
    navigation,
    clipped: (length: number) =>
      `… (This comment has ${characters(length)}; the rest is cut off. For the full text, ask the user to view it on the requirement page.)`,
    publishNote: " (publish note for a confirmed version)",
    filesHeading: (count: number) =>
      `${plural("en", count, { one: "1 file attached", other: `${String(count)} files attached` })} (view them with suduo_attachment_view, passing the file ID as attachmentId):`,
    system: {
      artifactPublished: (versionNumber: number, fileCount: number) =>
        `Published confirmed version ${String(versionNumber)} with ${files(fileCount)}.`,
      commentFiles: (fileCount: number) => `(no text, just ${files(fileCount)} attached)`,
    },
  },
  attachments: {
    none: (label: string) => `${label} has no attachments.`,
    header: (label: string, count: number) =>
      `Attachments of ${label} (${plural("en", count, { one: "1 attachment", other: `${String(count)} attachments` })}, newest first; ` +
      "where content overlaps, the newer one wins; where it doesn't, they complement each other; if unsure, ask the user. View their content with suduo_attachment_view):",
    notFound: (label: string, id: string) =>
      `${label} has no attachment with ID ${id} (it may have been deleted, or it belongs to another requirement). First check the attachment list with suduo_requirement_attachments.`,
    head: (fileName: string, contentType: string, size: string, uploader: string, time: string) =>
      `Attachment “${fileName}” (${contentType}, ${size}, uploaded by ${uploader} at ${time})`,
    savedLong: (path: string) => `The content is long, so it was saved in the project at ${path}. Read that file directly.`,
    saved: (path: string) => `Saved in the project at ${path}. You can read that file directly.`,
  },
  notes: {
    none: (label: string, path: string) => `${label} has no conclusion notes on this computer yet (${path}).`,
    tooLong: (label: string, length: number, path: string) =>
      `The conclusion notes of ${label} have ${characters(length)}, which is too long to show here. ` +
      `Read the full text of the file ${path} directly; to update them, revise on top of the full text and write the whole thing back with suduo_notes_save.`,
    content: (label: string, path: string) => `Conclusion notes of ${label} (${path}):`,
    saved: (label: string, path: string) =>
      `Updated the conclusion notes of ${label}: ${path} (on this computer only; not shared automatically).`,
    backup: (path: string) => `The old content was archived: ${path}`,
    changedSinceRead:
      "Note: after you last read them, the notes were changed by the user or another session; the old content was archived. Tell the user, and confirm that this write didn't drop what they added.",
  },
  write: {
    commentEmpty: "The comment can't be empty.",
    commentTooLong: (limit: number, length: number) =>
      `A comment can be at most ${characters(limit)}; this one is ${characters(length)}. Shorten it before sending.`,
    requirementSessionOnly: "Only a session created from a requirement can post comments.",
    requirementTitleOnly: (title: string) => `requirement “${title}”`,
    commentSent: (label: string, author: string, time: string, id: string) =>
      `Posted the comment to ${label} (${author}, ${time}, comment ID ${id}).`,
    incomplete: "The confirmation card is incomplete, so nothing was done.",
    notSent: (_kind: "comment", reason: string) => `Couldn't post the comment: ${reason}.`,
    unconfirmed: (_kind: "comment", reason: string) =>
      `The result of posting the comment is unconfirmed: ${reason}. Ask the user to check on the requirement page whether it was posted. Don't post it again before they check.`,
  },
  dispatch: {
    failed: (reason: string) => `SuDuo ran into an error while running the tool: ${reason}`,
    noProject: "This session isn't linked to a SuDuo project, so it can't use suduo tools.",
    roomReadOnly: (tool: string) => `A shared agent in a room can only use read-only tools; it can't call ${tool}.`,
    threadMissing: "Couldn't find the session thread, so nothing was done.",
    roomToolsUnavailable: "Room tools are unavailable right now.",
    sessionToolsUnavailable: "Session tools are unavailable right now.",
    delegationToolsUnavailable: "Delegation tools are unavailable right now.",
    reviewToolsUnavailable: "Review tools are unavailable right now.",
    handoffToolsUnavailable: "Handoff tools are unavailable right now.",
    unknownTool: (tool: string) => `SuDuo has no tool named ${tool}.`,
    declinedComment: "The user didn't approve, so the comment wasn't posted.",
    commentDraftSaved: "The user hasn't confirmed yet, so the comment was saved as a draft (not posted). The user can send or discard it from SuDuo later; don't call the comment tool again.",
    retired: (tool: string) =>
      `${tool} has been retired: SuDuo no longer has confirmed versions, and all requirement materials are attachments. ` +
      "List them with suduo_requirement_attachments (newest first) and view their content with suduo_attachment_view.",
    sessionUnlinked: "The session is no longer linked to a SuDuo project, so nothing was done.",
    runFailed: (reason: string) => `An error occurred while running it: ${reason}`,
    image: "(image)",
  },
} satisfies ServerMessages["toolReply"];
