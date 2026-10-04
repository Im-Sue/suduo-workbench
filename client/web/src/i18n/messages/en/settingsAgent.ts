import { plural } from "@suduo/client-contracts";
import type { Messages } from "../zh-CN/index.js";

const quoted = (names: readonly string[]) => names.map((name) => `“${name}”`).join(", ");

export const settingsAgent = {
  mcp: {
    description:
      "MCP servers connect Codex to external tools, such as databases, design files, and internal systems. The configuration is stored in Codex on this computer.",
    addServer: "Add server",
    startup: {
      unknown: "Connection unconfirmed",
      starting: "Connecting",
      ready: "Connected",
      failed: "Couldn't connect",
      cancelled: "Canceled",
    },
    auth: {
      notLoggedIn: "Not signed in",
      bearerToken: "Signed in with token",
      oAuth: "Signed in",
      unknown: "Sign-in status unknown",
    },
    disabled: "Disabled",
    transport: {
      stdio: "Local command",
      http: "Remote server",
    },
    toolCount: (count: number) => plural("en", count, { one: "1 tool", other: `${String(count)} tools` }),
    test: {
      title: "Connection test",
      description: "Have Codex reconnect to all MCP servers and refresh the status below.",
      statusUnavailable: "Can't read Codex's status right now.",
      statusUnavailableSuggestion: "Try again later. If this keeps happening, check Codex in Diagnostics.",
      noServers: "No MCP servers configured yet",
      noneEnabled: "No MCP servers are enabled",
      allConnected: (count: number, elapsed: string) =>
        plural("en", count, {
          one: `The enabled server is connected · ${elapsed}`,
          other: `All ${String(count)} enabled servers are connected · ${elapsed}`,
        }),
      troubled: (names: readonly string[]) =>
        plural("en", names.length, {
          one: `1 server couldn't connect: ${quoted(names)}`,
          other: `${String(names.length)} servers couldn't connect: ${quoted(names)}`,
        }),
      troubledSuggestion: "Click “See why” on the server below.",
    },
    list: {
      title: "Configured servers",
      label: "MCP servers",
      statusUnavailable:
        "Can't read Codex's status right now. Below is the configuration known on this computer, with connections shown as unconfirmed.",
      loading: "Loading MCP servers",
      loadFailed: (message: string) => `Couldn't load MCP servers: ${message}`,
      emptyTitle: "No MCP servers configured yet",
      emptyDescription: "Once added, you can test connections and sign in here.",
      diagnose: "See why",
      signIn: "Sign in",
      signInFailed: "Couldn't start sign-in",
      signInUrl: (url: string) => `If your browser didn't open, copy this address to finish signing in: ${url}`,
      enable: (name: string) => `Enable ${name}`,
      moreActions: (name: string) => `More actions for “${name}”`,
      edit: "Edit",
      signOut: "Sign out",
      signOutFailed: "Couldn't sign out",
      remove: "Delete",
      removeFailed: "Couldn't delete",
    },
    detail: {
      noReason:
        "Codex didn't provide connection details for this server. Check the command or server URL, then click “Test connection” to reconnect.",
      command: (command: string) => `Command: ${command}`,
      url: (url: string) => `Server URL: ${url}`,
      envVars: (names: readonly string[]) =>
        `Required environment variables: ${names.join(", ")} (values come from the system environment)`,
    },
    removeConfirm: {
      title: (name: string) => `Delete “${name}”?`,
      description: "Codex will no longer be able to use this server's tools. To get them back, add the server again.",
      confirm: "Delete",
    },
    form: {
      addTitle: "Add MCP server",
      editTitle: (name: string) => `Edit “${name}”`,
      description: "Codex starts or connects to the server using this configuration.",
      transport: "Connection type",
      transportChange: "When you change the connection type, Codex removes the old configuration and then adds the new one.",
      name: "Name",
      nameHint: "Start with a letter and use only letters, numbers, - or _, e.g. design-files.",
      nameRequired: "Enter a name",
      nameInvalid: "Start with a letter and use only letters, numbers, - or _",
      command: "Command",
      commandRequired: "Enter a command",
      args: "Arguments",
      argsHint: 'Separate with spaces, or leave empty. Wrap arguments that contain spaces in quotes, e.g. --root "/Users/me/My Projects".',
      argsUnclosedQuote: "A quote isn't closed. Check the arguments.",
      envVars: "Required environment variable names",
      envVarsHint: "Separate with commas or spaces.",
      url: "Server URL",
      urlProtocol: "The URL must start with http:// or https://",
      urlInvalid: "Enter a valid server URL",
      bearerEnv: "Token environment variable",
      bearerEnvHint: "Optional. For servers that need sign-in, click “Sign in” in the list after adding.",
      secretsNote:
        "Enter variable names only, not values. Values come from the system environment when SuDuo starts (e.g. the local service's environment file). Codex can't store secrets for you yet, so you can't enter secrets here for servers that need them.",
      cancel: "Cancel",
      add: "Add",
      save: "Save",
    },
  },
  skills: {
    description:
      "Skills are instructions that tell Codex how to do things. The more that are available, the less room each one gets. Turn off the ones you rarely use so Codex understands the rest better.",
    scope: {
      user: "Personal",
      repo: "Project",
      system: "Built-in",
      admin: "Admin",
    },
    scopeOther: "Other",
    global: {
      title: "Use personal Skills folder",
      description: "When off, only the Skills included in the project are used.",
      folder: (path: string) => `Folder: ${path}`,
      locked: "Your admin has locked this setting. Contact them to change it.",
    },
    project: {
      title: "Project",
      description: "Available Skills and which ones are on can differ between projects.",
      emptyTitle: "No local folder linked yet. Only installed Skills are shown.",
      emptyAction: "Link folder",
      placeholder: "Choose a project",
    },
    install: {
      title: "Install Skill",
      description: "Enter the full path to a Skill folder on this computer.",
      pathRequired: "Enter the full path to the Skill folder first",
      submit: "Install",
      stillWorking: "Still working…",
      failed: "Couldn't install",
    },
    list: {
      title: "Installed Skills",
      projectRequired: "Choose a project to see each Skill's source and on/off switch.",
      catalogUnavailable: "Can't read which Skills are on for this project right now. Only installed Skills are listed below.",
      loading: "Loading Skills",
      loadFailed: (message: string) => `Couldn't load Skills: ${message}`,
      emptyTitle: "No Skills installed yet",
      emptyDescription: "You can install one from a Skill folder on this computer.",
      emptyAction: "Install Skill",
      version: (version: string) => `Version ${version}`,
      noDescription: "No description",
      enable: (name: string) => `Enable ${name}`,
      toggleFailed: "Couldn't save",
      uninstall: "Uninstall",
      uninstallFailed: "Couldn't uninstall",
    },
    uninstallConfirm: {
      title: (name: string) => `Uninstall “${name}”?`,
      description: "This deletes the Skill's folder. You'll need to install it again to use it.",
      confirm: "Uninstall",
    },
  },
  execution: {
    description: "Choose how new sessions ask you to approve Codex's actions by default.",
    descriptionWithSessionNote:
      "Choose how new sessions ask you to approve Codex's actions by default. You can change it for each session below the composer.",
    loading: "Loading execution and safety settings",
    loadFailed: (message: string) => `Couldn't load local settings: ${message}`,
    modes: {
      ask: {
        label: "Ask every step",
        description: "Asks you before running any command or changing any file. Safest, but interrupts you the most.",
      },
      auto: {
        label: "Ask when out of bounds",
        description:
          "Reads, writes, and runs routine commands in the local folder without asking. Asks before going online or touching files outside the folder.",
      },
      full: {
        label: "Full access",
        description:
          "Never asks. All commands and network access are allowed. Use only when you fully trust the current task. You'll be asked to confirm when switching.",
      },
    },
    approval: {
      title: "Default approval mode for new sessions",
      recommended: "Recommended",
      blocked: "Limited by your admin",
      blockedBadge: "Limited",
      lockReason: (label: string) =>
        `Your admin has limited the highest mode to “${label}”, so higher options aren't available. Contact your admin if you need them.`,
    },
    matrix: {
      label: "What each mode allows",
      mode: "Mode",
      files: "Files",
      network: "Network",
      rows: {
        ask: { files: "Read-only, asks before writing", network: "Not allowed" },
        auto: { files: "Can write in the local folder", network: "Not allowed" },
        full: { files: "Unrestricted", network: "Allowed" },
      },
    },
    fullAccess: {
      title: "Sessions can switch to full access",
      description: "Whether a session can switch its approval mode to “Full access”.",
      allowed: "Yes",
      blocked: "No (limited by your admin)",
    },
    checkpoint: {
      title: "Auto-save before each turn",
      description:
        "When the project uses version control, a checkpoint is saved before each turn by default, so you can go back if something breaks.",
    },
    fullConfirm: {
      title: "Use full access by default?",
      description: "New sessions will never ask, and all commands and network access will be allowed. Use only in local folders you fully trust.",
      confirm: "Use full access",
    },
  },
  notifications: {
    description: "Only affects this browser on this computer.",
    system: {
      title: "System notifications",
      description:
        "Get a system notification when a background session finishes, fails, or is waiting for you. Alerts in the tab title are always on.",
    },
    status: {
      requesting: "Waiting for you to allow it in your browser…",
      off: "Off",
      on: "On",
      blocked: "On, but your browser is blocking notifications",
      notGranted: "On, but your browser hasn't allowed notifications yet",
    },
    sample: {
      button: "Send a test",
      title: "SuDuo notifications are on",
      body: "When a session needs you, you'll get a notification like this.",
      failed: "This browser doesn't let pages send notifications directly. Alerts in the tab title still work.",
    },
    unsupported: "This browser doesn't support system notifications. Alerts in the tab title still work.",
    blocked: {
      title: "Your browser is blocking SuDuo notifications",
      body: "Click the site icon to the left of the address bar and set Notifications to Allow. It takes effect when you come back here. If you don't want system notifications, turn off the switch above.",
    },
    requestPermission: "Ask your browser for permission",
  },
  appearance: {
    description: "Changes take effect immediately and only affect this computer.",
    theme: {
      title: "Theme",
      description: "System switches automatically with your computer's light or dark setting.",
      light: "Light",
      dark: "Dark",
      system: "System",
      systemRecommended: "System (recommended)",
      recommended: "Recommended",
    },
    density: {
      title: "Density",
      description: "Compact makes lists and controls shorter, so more fits on screen.",
      comfortable: "Comfortable",
      compact: "Compact",
    },
    locale: {
      title: "Language",
      description: "“Follow system” shows Chinese if your browser language is Chinese, and English otherwise.",
      confirm: {
        title: "Switch language?",
        body: "SuDuo reloads the interface in the new language. Open dialogs and unsaved edits on this page will be lost, and you may need to check whether messages being sent went through. Message drafts and queued messages are kept.",
        action: "Switch language",
      },
      otherTab: {
        message: (language: string) =>
          `Another tab changed the language to ${language}. This tab will switch once its open dialogs, unsaved edits, and messages being sent are done.`,
        switchNow: "Switch now",
      },
    },
  },
} satisfies Messages["settingsAgent"];
