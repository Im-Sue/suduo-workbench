import { plural } from "@suduo/client-contracts";
import type { Messages } from "../zh-CN/index.js";

export const requirements = {
  page: {
    title: "Requirements",
    total: (count: number, more: boolean) =>
      `${String(count)}${more ? "+" : ""} ${plural("en", more ? 2 : count, { one: "requirement", other: "requirements" })}`,
    view: "View",
    viewBoard: "Board",
    viewList: "List",
    reconnecting: "Live updates disconnected. Reconnecting…",
    moreActions: "More actions",
    projectSettings: "Project settings",
    create: "New requirement",
    searchLabel: "Search requirements",
    searchPlaceholder: "Search by title or number",
    clearSearch: "Clear search",
    clearFilters: "Clear filters",
  },
  filter: {
    status: "Status",
    statusValue: (label: string) => `Status: ${label}`,
    allStatuses: "Show all statuses",
    assignee: "Assignee",
    assigneeValue: (label: string) => `Assignee: ${label}`,
    mine: "Me",
    someone: "Selected member",
    anyAssignee: "Any assignee",
  },
  noResult: {
    filteredTitle: "No matching requirements",
    filteredDescription: "Try different filters.",
    searchTitle: (query: string) => `No results for “${query}”`,
    searchDescription: "Try another keyword, or search by number, e.g. REQ-128",
  },
  peekMissing: {
    quoted: (ref: string) => `“${ref}”`,
    notFound: (label: string) => `Can't find ${label}`,
    notFoundDetail: "It may not be in this project, or the number may be wrong.",
    failed: (label: string) => `Couldn't open ${label}`,
    failedDetail: "The network or service may be unavailable right now.",
  },
  column: {
    empty: "No requirements",
    loadMore: "Load more",
    createIn: (label: string) => `New requirement in “${label}”`,
    loadFailed: (label: string, message: string) => `Couldn't load “${label}”: ${message}`,
  },
  board: {
    region: "Requirements board",
    dragInstructions: "Press 1 to 7 to change the status.",
    drag: {
      fallbackItem: "requirement",
      pickedUp: (item: string) => `Picked up ${item}`,
      overNone: "Not over a column",
      over: (column: string) => `Over “${column}”`,
      droppedUnchanged: (item: string) => `Dropped ${item}. Status unchanged`,
      moved: (item: string, column: string) => `Moved ${item} to “${column}”`,
      cancelled: (item: string) => `Canceled moving ${item}`,
    },
  },
  list: {
    region: "Requirements list",
    header: {
      number: "ID",
      title: "Title",
      assignee: "Assignee",
      counts: "Materials · Comments · Sessions",
      updated: "Updated",
    },
  },
  card: {
    description: (status: string, assignee: string) => `${status} · Assignee: ${assignee} · Press 1–7 to change status`,
    attachments: (count: number) =>
      plural("en", count, { one: "1 attachment", other: `${String(count)} attachments` }),
    comments: (count: number) => plural("en", count, { one: "1 comment", other: `${String(count)} comments` }),
    localSessions: (count: number) =>
      plural("en", count, { one: "1 local session", other: `${String(count)} local sessions` }),
  },
  assignee: {
    unassigned: "Unassigned",
    search: "Search members",
    loading: "Loading members…",
    loadFailed: "Couldn't load members",
    empty: "No matching members",
    unassignedKeywords: "Unassigned none",
    meKeywords: (name: string) => `me you ${name}`,
    meSuffix: "(you)",
  },
  statusMenu: {
    triggerLabel: (label: string, pending: boolean) => `Status: ${label}${pending ? ", saving" : ", click to change"}`,
  },
  create: {
    title: "New requirement",
    description: "Only the title is required. You can add the rest later.",
    discardLabel: "Discard this requirement?",
    discardPrompt: "Discard this requirement? It hasn't been created yet.",
    titleLabel: "Requirement title",
    titlePlaceholder: "Requirement title",
    titleRequired: "Add a title so everyone can recognize it on the board",
    summaryLabel: "Description",
    summaryPlaceholder: "Add background, goals, or acceptance criteria. Markdown is supported. You can also write this later.",
    addMaterials: "Add materials",
    pendingFiles: "Materials to upload",
    removeFile: (name: string) => `Remove ${name}`,
    rejectedItem: (name: string, reason: string) => `${name}: ${reason}`,
    rejected: (items: readonly string[], total: number) =>
      `${items.join("; ")}${total > items.length ? ` (${String(total)} files in total)` : ""}`,
    failed: (message: string) => `Couldn't create: ${message}`,
    createMore: "Create another",
    submit: "Create requirement",
    created: (code: string, uploading: number) =>
      `Created ${code}${
        uploading > 0
          ? plural("en", uploading, { one: ". Uploading 1 attachment", other: `. Uploading ${String(uploading)} attachments` })
          : ""
      }`,
    uploadFailed: (code: string, name: string) => `Couldn't upload “${name}” to ${code}`,
    view: "View",
  },
  peek: {
    label: "Requirement preview",
    labelWith: (code: string, title: string) => `Requirement preview: ${code} ${title}`,
    prev: "Previous",
    next: "Next",
    openFull: "Open full page",
    close: "Close preview",
    closeHint: "Close",
    loading: "Loading requirement",
    loadFailed: (message: string) => `Couldn't open this requirement: ${message}`,
    field: {
      assignee: "Assignee",
      created: "Created",
      updated: "Updated",
    },
    assigneeTrigger: (name: string) => `Assignee: ${name}, click to change`,
    noDescription: "No description yet. ",
    addDescription: "Add one",
    localSessions: "Local sessions",
    recentActivity: "Recent activity",
    startSession: "Start session",
  },
  startSession: {
    title: "Start session",
    directoryTitle: "Choose local folder",
    checking: "Checking the local folder and existing sessions",
    failed: (message: string) => `Couldn't start the session: ${message}`,
    backgroundFailed: "Couldn't prepare the session",
    choose: {
      intro: (count: number) =>
        `${plural("en", count, {
          one: "This requirement already has a local session.",
          other: `This requirement already has ${String(count)} local sessions.`,
        })} Continue a previous session to keep its context, or start a new one if the requirement has changed a lot.`,
      listLabel: "Existing sessions",
      untitled: "Untitled session",
      activity: (when: string, latest: boolean) => `${latest ? "Most recent · " : ""}Last active: ${when}`,
      resume: "Continue",
      more: (count: number) =>
        plural("en", count, {
          one: "Find the other session in Sessions.",
          other: `Find the other ${String(count)} sessions in Sessions.`,
        }),
      createNew: "New session",
    },
    directory: {
      intro:
        "Sessions run in this project's local folder. You only choose it once: later sessions in this project use it too. You can change it in project settings.",
      missing: (path: string | null) =>
        `The previously linked folder${path === null ? "" : ` ${path}`} no longer exists. It may have been moved, renamed, or deleted. Choose this project's local folder again.`,
      unusable: (path: string | null) =>
        `SuDuo can't read and write the previously linked folder${path === null ? "" : ` ${path}`}. Choose another folder, or check its permissions.`,
      unlinked: "This project's link to a local folder is no longer valid. Choose the folder again.",
      use: "Use this folder",
      useDisabledReason: "Choose a folder SuDuo can read and write first",
    },
    preparing: {
      directoryReady: "Local folder is available",
      syncAndStart: "Sync requirement materials and start session",
      start: "Start session",
      elapsed: (seconds: number) => `${String(seconds)}s elapsed`,
      enter: "Open session",
      slow: "This is taking longer than usual. The first Codex start or large requirement attachments take more time. You can close this, and you'll be notified when it's ready.",
      background: "Continue in background",
    },
  },
  directoryPicker: {
    manualLabel: "Absolute path to the code folder",
    up: "Parent folder",
    location: "Current location",
    loading: "Reading folders",
    loadFailed: (message: string) => `Couldn't read this folder: ${message}`,
    goHome: "Back to home folder",
    empty: "No subfolders here",
    listLabel: "Folders",
    listLabelIn: (path: string) => `Folders in ${path}`,
    gitRepo: "Git repository",
    truncated: "There are many folders, so only the first 500 are shown. You can enter a path instead.",
    recent: "Recent",
    checking: "Checking…",
    browse: "Browse folders",
    manual: "Enter path manually",
    verdict: {
      idle: "Select a folder (double-click or press → to open it)",
      missing: "This path doesn't exist",
      notDirectory: "This isn't a folder",
      noAccess: "SuDuo needs to read and write this folder",
      notGitRepo: "Readable and writable, but not a Git repository: sessions can't save checkpoints",
      ok: "Readable and writable · Git repository",
      okOnBranch: (branch: string) => `Readable and writable · Git repository · On branch ${branch}`,
    },
  },
} satisfies Messages["requirements"];
