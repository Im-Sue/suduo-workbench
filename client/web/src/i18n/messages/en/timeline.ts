import { plural } from "@suduo/client-contracts";
import type { Messages } from "../zh-CN/index.js";

export const timeline = {
  joinList: (items: readonly string[]) => items.join(", "),
  step: {
    run: (command: string) => `Run ${command}`,
    runCommand: "Run command",
    read: (name: string) => `Read ${name}`,
    readFiles: (count: number) => plural("en", count, { one: "Read 1 file", other: `Read ${String(count)} files` }),
    search: (query: string) => `Search for “${query}”`,
    searchCode: "Search code",
    listPath: (path: string) => `List ${path}`,
    listFiles: "List files",
    thinking: "Thinking",
    thinkingAbout: (heading: string) => `Thinking: ${heading}`,
    callMcpTool: (server: string, tool: string) => `Call ${server} · ${tool}`,
    callTool: (tool: string) => `Call ${tool}`,
    callUnnamedTool: "Call tool",
    webSearch: (query: string) => `Search the web for “${query}”`,
    webSearchAny: "Search the web",
    viewImage: (name: string) => `View image ${name}`,
    contextCompaction: "Compacted earlier conversation to free up context",
    enterReview: "Start code review",
    exitReview: "End code review",
    sleep: "Wait",
    generateImage: "Generate image",
    collabAgent: "Agent collaboration",
    toolCall: "Tool call",
  },
  process: {
    command: "Run command",
    file: "Edit files",
  },
  imageAttachment: "Image",
  approval: {
    files: (count: number) => plural("en", count, { one: "1 file", other: `${String(count)} files` }),
    action: {
      command: "Run command",
      stdin: "Send input to a running command",
      fileChange: "Edit files",
      permissions: "Change permissions",
      other: "Continue",
    },
    subject: {
      command: (command: string) => `Run ${command}`,
      stdin: (command: string) => `Send input to ${command}`,
      fileChange: (target: string) => `Edit ${target}`,
      permissions: (scopes: readonly string[]) => `Change permissions (${scopes.join(", ")})`,
    },
    state: {
      waiting: (what: string) => `Waiting for you: ${what}`,
      accepted: (what: string) => `Approved: ${what}`,
      acceptedForSession: (what: string) => `Approved (won't ask again this session): ${what}`,
      declined: (what: string) => `Declined: ${what}`,
      cancelled: (what: string) => `Declined and stopped: ${what}`,
      deliveryFailed: (what: string) => `Approval not delivered: ${what}`,
      expired: (what: string) => `Approval no longer valid: ${what}`,
    },
  },
  permission: {
    read: "Read",
    write: "Write",
    deny: "No access to",
    network: "Network access",
  },
  notice: {
    runtimeRecovered: "The runtime connection is back. You can keep working.",
    threadRebuilt:
      "This session's earlier context couldn't be restored, so a new thread was started to continue. The AI no longer remembers the earlier conversation, but the conversation history and file changes are all kept.",
    connectionRebuilt: "The connection to Codex dropped and was re-established. A turn in progress may have been interrupted.",
    unsupportedQuestion: "Codex asked you a question, but SuDuo can't answer it here yet, so it was skipped. Codex will keep going.",
    unsupportedElicitation:
      "Codex asked you to confirm an MCP tool action, but SuDuo doesn't support this kind of confirmation yet, so it was declined for you. Codex will try another way.",
    unsupportedRequest: "Codex sent a request SuDuo doesn't support yet, so it was skipped. Codex will keep going.",
    runEventsTruncated: (omitted: number) =>
      `The run details were too long, so ${plural("en", omitted, {
        one: "1 record in the middle was",
        other: `${String(omitted)} records in the middle were`,
      })} left out (the beginning and end are kept). The full details are in the room task session on the owner's computer.`,
    skillsBudget:
      "Many skills are available, so their descriptions were shortened to fit Codex's context budget. Every skill can still be used. Turn off skills you rarely use in Settings to keep descriptions complete.",
    unknownModel:
      "The current model isn't in Codex's built-in model list, so Codex runs it with default parameters: about 270K tokens of context (or your lower limit from Settings), no reasoning effort sent to the model service, and some tools unavailable. Add this model to the model catalog in your Codex config to clear this notice.",
    serviceTier:
      "The model service doesn't advertise support for the configured service tier, so it was ignored for this request. Nothing else is affected.",
    websocketFallback: "Couldn't connect to the model service over WebSocket, so it switched to HTTPS.",
    ignoredConfig: (count: number, keys: readonly string[], more: boolean) =>
      `Codex ignored ${plural("en", count, {
        one: "1 unrecognized config setting",
        other: `${String(count)} unrecognized config settings`,
      })} (possibly a typo, or no longer supported)${
        keys.length > 0 ? `: ${keys.join(", ")}${more ? ", and more" : ""}` : ""
      }. Nothing else is affected. Fix or remove ${plural("en", count, { one: "it", other: "them" })} in your Codex config to clear this notice.`,
    bubblewrapMissing:
      "This machine doesn't have bubblewrap installed, so Codex is using its bundled sandbox for now. Install bubblewrap following OpenAI's instructions (Ubuntu / Debian: sudo apt install bubblewrap; Ubuntu 24.04 also needs the official AppArmor profile loaded). See “Command sandbox” in Settings → Diagnostics.",
    userNamespaces:
      "Codex's Linux sandbox can't create user namespaces, so commands that need approval or restricted execution will fail. See “Command sandbox” in Settings → Diagnostics.",
  },
  error: {
    turn: {
      rateLimited: {
        text: "The model service is rate limiting requests (429) and automatic retries failed. Wait a few minutes before sending again. If it keeps happening, ask your admin to check the quota.",
        brief: "The model service is rate limiting requests (429)",
      },
      unauthorized: {
        text: "Model service authentication failed (401). Check the credentials under Model service in Settings, or ask your admin to set it up again.",
        brief: "Model service authentication failed (401)",
      },
      forbidden: {
        text: "The model service refused the request (403). The current credentials may not have access to this model.",
        brief: "The model service refused the request (403). The credentials may not have access to this model",
      },
      serverError: {
        text: "The model service had a temporary error. Try again later.",
        brief: "The model service had a temporary error",
      },
      timeout: {
        text: "The model service timed out. Try again later.",
        brief: "The model service timed out",
      },
    },
    unknown: "This turn failed for an unknown reason.",
    waitingForNetwork: "Lost the connection to the model service. Waiting for the network to reconnect…",
    connectionLost: "Lost the connection to the model service",
    reconnecting: (reason: string, attempt: number, max: number) =>
      `${reason}. Reconnecting (${String(attempt)}/${String(max)})…`,
    // 迁移期本机服务的原文可能是中文，以「。」结尾。
    retrying: (reason: string) => `${reason.replace(/[。.]$/, "")}. Retrying…`,
    noResponseRetrying: "The model service isn't responding. Retrying…",
    codex: {
      contextWindowExceeded:
        "This conversation is longer than the model's context window. Start a new session, or ask Codex to summarize before continuing.",
      usageLimitExceeded: "Model usage has reached its limit. Try again later, or ask your admin to raise the quota.",
      unauthorized:
        "Model service authentication failed (401). Check the credentials under Model service in Settings, or ask your admin to set it up again.",
      serverOverloaded: "The model service is busy right now. Wait a moment and try again.",
      internalServerError: "The model service had a temporary error. Try again later.",
      badRequest: "The model service rejected this request. A parameter or attachment may not be supported.",
      sandboxError: "The command couldn't run in the sandbox. Check the approval mode and the project folder's permissions.",
      rateLimitExceeded: "The model service is rate limiting requests. Wait a few minutes before sending again.",
      flexUnavailable: "The model service's current processing tier is temporarily unavailable. Try again later.",
      misalignmentPolicyViolation:
        "This request triggered the model service's safety policy, so the turn stopped. Try rephrasing.",
      tooManyDenials: "Too many actions were declined, so the turn stopped. Change the approval mode or try another approach.",
      sessionBudgetExceeded: "This session's usage budget is used up. Start a new session to continue.",
      cyberPolicy: "The request involves cybersecurity content and was blocked by the model service's safety policy.",
      threadRollbackFailed: "Couldn't roll back the conversation. Try again.",
    },
  },
  suDuoTool: {
    labels: {
      suduo_requirement_get: "View requirement",
      suduo_requirement_comments: "View comments",
      suduo_requirement_attachments: "View attachment list",
      suduo_attachment_view: "View attachment",
      suduo_artifact_versions: "View confirmed versions",
      suduo_artifact_fetch: "Fetch confirmed version",
      suduo_notes_read: "Read conclusion notes",
      suduo_notes_save: "Update conclusion notes",
      suduo_comment_submit: "Post comment",
      suduo_artifact_publish: "Publish confirmed version",
    },
    roomLabels: {
      suduo_room_history: "Browse room messages",
      suduo_room_search: "Search room messages",
      suduo_room_file_view: "View room file",
    },
    commentOn: (target: string) => `Comment on ${target}`,
    publishTo: (target: string) => `Publish confirmed version to ${target}`,
    requirement: {
      codeAndTitle: (code: string, title: string) => `${code} “${title}”`,
      title: (title: string) => `“${title}”`,
      unnamed: "this requirement",
    },
    duplicatePending: (at: string) => `This session already has a confirmation card with the same content (${at})`,
    duplicateSent: (at: string) => `This session already sent the same content at ${at}`,
    projectFile: (ref: string) => `Project file ${ref}`,
    existingAttachment: "Existing attachment",
    attachments: (ids: readonly string[]) =>
      `${plural("en", ids.length, { one: "Attachment", other: "Attachments" })} ${ids.join(", ")}`,
    version: (version: number) => `v${String(version)}`,
    quote: (text: string) => `“${text}”`,
    imageOutput: "(image)",
  },
} satisfies Messages["timeline"];
