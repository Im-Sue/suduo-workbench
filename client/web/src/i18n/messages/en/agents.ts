import type { Messages } from "../zh-CN/index.js";

export const agents = {
  section: {
    description:
      "SuDuo starts work with the AI agents installed and signed in on this computer. Sign-in always happens in each agent's own tool; SuDuo never reads or stores your accounts, tokens, or keys.",
    defaultTitle: "Default for new sessions",
    defaultDescription: "Preselected when you start a session; the agent you used last comes first.",
    listTitle: "Agents on this computer",
    listLabel: "AI agents",
    recheckAll: "Check all again",
    termsNote: "Service regions and terms of use are set by each vendor.",
    channel: {
      "codex-app-server": "Bundled with SuDuo",
      "claude-sdk": "Official SDK",
      acp: "Standard protocol",
    },
    channelHint: "Connected through the open Agent Client Protocol",
    status: {
      checking: "Checking",
      ready: "Ready",
      installed: "Installed",
      not_installed: "Not installed",
      auth_required: "Sign-in needed",
      version_unsupported: "Version too old",
      error: "Check failed",
    },
    installedHint: "Sign-in is confirmed the first time you start a session",
    reason: {
      binary_not_found: "Not found on this computer",
      version_unreadable: "Couldn't read the version",
      version_below_minimum: "Older than the minimum version",
      auth_check_failed: "Couldn't confirm sign-in",
      not_logged_in: "Not signed in",
      check_timeout: "The check timed out",
      check_failed: "The check failed",
      disabled: "Turned off",
    },
    minVersion: (version: string) => `Needs ${version} or later`,
    version: (version: string) => `Version ${version}`,
    defaultBadge: "Default",
    setDefault: "Make default",
    actions: {
      copy_install_command: "Copy install command",
      open_terminal_login: "Sign in in Terminal",
      recheck: "Check again",
      open_homepage: "Website",
      open_terms: "Terms of use",
    },
    copied: "Install command copied. Paste it into a terminal to run it.",
    loginOpened: "Terminal is open. Finish signing in there, then click “Check again”.",
    loginManual: (command: string) => `Run “${command}” in a terminal, then click “Check again” once you're signed in.`,
  },
  picker: {
    agent: "Agent",
    manage: "Manage agents",
    permission: "Permissions",
    model: "Model",
    modelDefault: "Default",
    effort: "Reasoning effort",
    effortDefault: "Default",
    start: "Start",
    unavailable: (status: string) => `(${status})`,
    projectSettingsNote:
      "Claude Code loads this repository's own .claude settings (including allow rules and hooks), the same as when you open it in a terminal.",
    openSettings: "Open AI agent settings",
  },
  approval: {
    acceptAlways: {
      title: "Always allow",
      description: "Never ask about this kind of action again (the agent remembers this, possibly in its own settings).",
    },
    declineAlways: {
      title: "Always deny",
      description: "Deny this kind of action from now on (the agent remembers this).",
    },
  },
  badge: (name: string) => `Agent: ${name}`,
} satisfies Messages["agents"];
