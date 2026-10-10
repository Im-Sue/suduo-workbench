import type { ServerMessages } from "../zh-CN/index.js";

export const toolSpec = {
  // 前导空格：接在上一句说明后面。
  textReturn: (name: string) => ` Returns Markdown text (a string); in exec, view it with text(await tools.${name}({...})).`,
  numberParam:
    "Requirement number, e.g. REQ-12 or 12. In a requirement session, omit it to use the current requirement; in a project session, it's required.",

  requirementGet:
    "Look up a SuDuo requirement: number, title, status, priority, assignee, version, and full description. For the current requirement, it also gives the version when work started and the changes since then (who, when, and what changed).",
  requirementComments: {
    description:
      "View the requirement's comments (author, time, body; publish notes for confirmed versions are marked), up to 20 per call. The cursor for the next page is given at both the start and the end of the result.",
    cursor: "The cursor given at the end of the previous page's result. Omit it for the first page.",
  },
  requirementAttachments:
    "List the requirement's attachments (newest first): attachment ID, file name, type, size, uploader, and time. Attachments are the requirement's materials (PRDs, screenshots, third-party docs, archives, etc.); " +
    "where content overlaps, the newer one wins; where it doesn't, they complement each other; if unsure, ask the user. To view the content, use suduo_attachment_view.",
  attachmentView: {
    description: (snippet: string) =>
      "View the content of a requirement attachment. Images are handed to you to view directly; text files return their content directly; other types (PDF, archives, video, etc.) are saved to the project's .suduo/ folder and their path is returned. " +
      "Returns a string: the first line describes the attachment; for image attachments, each following line is a data:image/... URL. In exec, view it like this: " +
      snippet +
      "Don't print data:image URLs with text().",
    attachmentId: "Attachment ID (from the attachment list), or the ID of a file attached to a comment (from suduo_requirement_comments).",
  },
  notesRead:
    "Read this requirement's conclusion notes on this computer (entry files, confirmed conclusions, open questions, key decisions). The notes stay on this computer and aren't shared automatically.",
  notesSave: {
    description:
      "Overwrite this requirement's conclusion notes (Markdown) with complete new content. Call it when the user says “note this down” or “capture this”. First read the existing content with suduo_notes_read, organize it from there, and write the whole document back. Don't drop anything the user wrote. " +
      "The old content is archived automatically.",
    content: "Full text of the notes (Markdown).",
  },
  commentSubmit: {
    description:
      "Post a comment on the current requirement (visible to the whole team; it can't be withdrawn once posted). Call it only when the user explicitly asks. Don't suggest posting a comment on your own. " +
      "After the call, it pauses until the user confirms in the SuDuo interface, which can take from tens of seconds to a few minutes. While waiting, don't output progress messages such as “still waiting”. In exec, set the wait / yield time to the maximum allowed; after yielding, just keep waiting, and reply to the user once you have the result. " +
      "Returns a string: posted (with the comment details), declined by the user, or not posted, with the reason.",
    body: "Full text of the comment (Markdown, up to 4000 characters).",
  },

  roomLimit: "Number of messages. Default 20, max 50.",
  roomHistory: {
    description:
      "Read-only: browse earlier messages in the current room (sequence number, time, author, first 500 characters of the text, attachment names and file IDs), oldest first, up to 50 per call. The end of the result gives the beforeSeq for paging further back.",
    beforeSeq: "Only messages with a sequence number below this. Omit it to start from the latest and go back.",
  },
  roomSearch: {
    description:
      "Read-only: find messages in the current room by keyword (the text contains the keyword, case-insensitive). Same result format as suduo_room_history, up to 50 per call.",
    query: "Keyword.",
  },
  roomFileView: {
    description: (snippet: string) =>
      "Read-only: view a file in the room (messages give the file ID). Images are handed to you to view directly; text files return their content directly; other types (video, PDF, archives, etc.) are saved to the project's .suduo/rooms/<room>/files/ and their path is returned, so you can read them directly afterward. " +
      "Returns a string: the first line describes the file; for images, each following line is a data:image/... URL. In exec, view it like this: " +
      snippet +
      "Don't print data:image URLs with text().",
    fileId: "File ID (the value after “file ID” in the message).",
  },

  /**
   * Descriptions when served through the SuDuo local MCP tool service (ADR-0015): no code-mode instructions;
   * results come back as MCP text / image content. Other tools reuse the Codex wording without the return-format
   * sentence, with the suduo_ prefix dropped from tool names.
   */
  mcp: {
    attachmentView:
      "View the content of a requirement attachment. Images are handed to you to view directly; text files return their content directly; other types (PDF, archives, video, etc.) are saved to the project's .suduo/ folder and their path is returned.",
    roomFileView:
      "Read-only: view a file in the room (messages give the file ID). Images are handed to you to view directly; text files return their content directly; other types (video, PDF, archives, etc.) are saved to the project's .suduo/rooms/<room>/files/ and their path is returned, so you can read them directly afterward.",
    commentSubmit:
      "Post a comment on the current requirement (visible to the whole team; it can't be withdrawn once posted). Call it only when the user explicitly asks. Don't suggest posting a comment on your own. " +
      "After the call, it waits until the user confirms in the SuDuo interface, which can take from tens of seconds to a few minutes. Don't output progress messages while waiting. " +
      "Returns: posted (with the comment details), declined by the user, saved as a draft to send (the wait took too long; the user can still send it from SuDuo later), or not posted, with the reason.",
  },
} satisfies ServerMessages["toolSpec"];
