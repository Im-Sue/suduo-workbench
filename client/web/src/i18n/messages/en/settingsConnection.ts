import { plural } from "@suduo/client-contracts";
import type { Messages } from "../zh-CN/index.js";

export const settingsConnection = {
  network: {
    codes: {
      ECONNREFUSED: "the connection was refused; nothing may be listening on that port",
      ECONNRESET: "the connection was reset",
      ETIMEDOUT: "the connection timed out",
      ENOTFOUND: "this address can't be found",
      EAI_AGAIN: "this address can't be resolved right now",
      EHOSTUNREACH: "the network is unreachable",
      ENETUNREACH: "the network is unreachable",
      CERT_HAS_EXPIRED: "the server's certificate has expired",
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's certificate can't be verified",
      SELF_SIGNED_CERT_IN_CHAIN: "the server uses a self-signed certificate",
    },
    withCode: (text: string, code: string) => `${text} (${code})`,
    invalidBaseUrl: "the model service URL is invalid, so the connection can't be checked",
    invalidProxy: "the proxy variables in the startup environment are invalid, so the connection can't be checked",
    connectionFailed: "connection failed",
  },
  model: {
    groupName: "Model service",
    intro: "Codex uses this service to call models.",
    description:
      "Codex uses this service to call models. Your API key is stored only on this computer. Changes take effect from the next turn.",
    loading: "Loading model service settings",
    loadFailedPill: "Can't read settings",
    loadFailed: (message: string) => `Can't read Codex's model settings right now: ${message}`,
    status: {
      notConfigured: "Not configured",
      warning: "Has warnings",
      unreachable: "Unreachable",
      connected: "Connected",
      checking: "Checking",
    },
    origin: {
      project: "project config",
      system: "system config",
      sessionFlags: "launch flags",
      managed: "admin config",
      other: "other config",
      badge: (label: string) => `From ${label}`,
      badgeTitle: (label: string) => `The value in effect comes from ${label}. Changing it here may have no effect.`,
    },
    validation: {
      baseUrlRequired: "Enter the model service URL first, e.g. https://llm-gateway.example.com/v1",
      baseUrlProtocol: "The URL must start with http:// or https://",
      baseUrlInvalid: "This isn't a valid URL, e.g. https://llm-gateway.example.com/v1",
      apiKeyIncomplete: "This API key looks incomplete. Paste the whole key.",
      apiKeyRequired: "To use your team's model service, enter its API key",
      modelName: "Model names can only contain letters, numbers, and . _ : / -",
      contextWindowInteger: "Enter a whole number, e.g. 200000",
      contextWindowRange: "Enter a whole number from 4000 to 100000000",
    },
    banner: {
      warningTitle: "Codex has a warning about the current settings",
      warningFallback: "Your settings contain items Codex doesn't recognize. The model service may run with default behavior.",
      details: "View details",
      firstTimeTitle: "You're using Codex's built-in default model service",
      firstTimeBody:
        "To use your team's model service, enter its URL and API key, then save. Saving only writes the settings. SuDuo then tries the address once and tells you the result. You can click “Test connection” anytime to check again.",
      degradedTitle: "Can't get Codex's model list right now",
      degradedBody: "Your saved settings are shown below. You can still edit them.",
      overriddenTitle: "Saved, but not in effect",
      restore: "Restore previous settings",
      saveFailedTitle: "Couldn't save",
    },
    save: {
      saved: "Model service saved. Changes take effect from the next turn.",
      savedUnreachable: (reason: string) =>
        `Model service saved, but this address can't be reached right now: ${reason}. Check the address or network proxy, then click “Test connection” to try again.`,
      restored: "Restored the settings from before you saved",
      restoreFailed: "Couldn't restore",
    },
    baseUrl: {
      label: "Service URL",
      description: "An OpenAI-compatible API URL.",
    },
    apiKey: {
      label: "API key",
      description: "Hidden for security. Saving replaces the old key.",
      placeholder: "Paste a new API key",
      cancelReplace: "Cancel",
      notConfigured: "Not configured",
      add: "Add",
      replace: "Replace",
      fromCommand:
        "The key comes from a key command in your Codex config (e.g. one that reads from Keychain), not from here. To change the key, change what that command reads.",
      fromEnv:
        "The key is read from an environment variable named in your Codex config, not from here. To change the key, change that variable in the environment SuDuo starts with.",
      replaceNote: "After you save, this key replaces Codex's current sign-in (including a ChatGPT account sign-in).",
    },
    chatgpt: {
      label: "ChatGPT account",
      description: "Sign in to Codex with your ChatGPT account. You authorize it in your web browser; Codex keeps the sign-in itself and SuDuo never handles it.",
      loading: "Reading Codex's sign-in status…",
      unavailable: (reason: string) => `Couldn't read Codex's sign-in status: ${reason}`,
      signedIn: (email: string | null, plan: string | null) =>
        `Signed in with a ChatGPT account${email === null ? "" : `: ${email}`}${plan === null ? "" : ` (${plan})`}`,
      apiKey: "Currently signed in with an API key",
      other: "Currently signed in another way",
      none: "Not signed in",
      customProvider: "You're using a custom model service; signing in with ChatGPT only applies to OpenAI's default service.",
      signIn: "Sign in with ChatGPT",
      signOut: "Sign out",
      waiting: "The sign-in page is open in your browser. This updates when you finish.",
      openAgain: "Open the sign-in page again",
      cancel: "Cancel",
      succeeded: "Signed in to Codex with your ChatGPT account",
      failed: (reason: string) => `Couldn't sign in: ${reason}`,
      cancelled: "Sign-in cancelled",
      signedOut: "Signed out",
      failures: { start: "Couldn't start signing in", signOut: "Couldn't sign out" },
      replacesApiKey: "Signing in replaces the current API key sign-in.",
      reasons: { timeout: "authorization wasn't completed within 10 minutes", codexExited: "Codex exited unexpectedly", unknown: "unknown reason" },
    },
    defaultModel: {
      label: "Default model",
      description: "The model new sessions use. You can switch models in each session.",
      loadingPlaceholder: "Loading available models…",
      unavailablePlaceholder: "Can't read the model list. You can enter a model name directly.",
      followCodex: "Use Codex default",
    },
    effort: {
      label: "Default reasoning effort",
      descriptionUnset: "When not set, Codex decides. You can adjust it in each session.",
      description: "You can adjust it in each session.",
    },
    contextWindow: {
      label: "Context limit",
      description:
        "In tokens. Leave blank to use Codex's known limit for the model (about 270K for models it doesn't recognize). You can only lower it: if the model's actual limit is smaller, enter that value here.",
      placeholder: "e.g. 200000",
    },
    test: {
      label: "Connection test",
      description: "Run one check with the saved settings: can Codex read the model list, and is the service URL reachable?",
      dirty: "You have unsaved changes. Save first, then test.",
      ok: (count: number, elapsed: string) =>
        `Connected · ${plural("en", count, { one: "1 model available", other: `${String(count)} models available` })} · ${elapsed}`,
      okBuiltin: (count: number) =>
        `Codex can read the model list · ${plural("en", count, { one: "1 model", other: `${String(count)} models` })} · Using the built-in default service, so there's no address to test`,
      unreachable: (reason: string) => `Can't reach the model service: ${reason}`,
      unreachableSuggestion: "Check that the service URL is correct. If your company network needs a proxy, set it up in “Network proxy”.",
      openProxy: "Set up network proxy",
      noModels: (message: string) => `The model service didn't return any usable models: ${message}`,
      noModelsSuggestion: "Make sure the API key is valid and hasn't expired. You can also check Diagnostics for more details.",
    },
  },
  proxy: {
    groupName: "Network proxy",
    intro: "The proxy Codex uses to connect to the model service.",
    description:
      "The proxy Codex uses to connect to the model service. If all fields are blank, the proxy environment variables from when the local service started are used (HTTP_PROXY and so on; with none, it connects directly). After you save, Codex reconnects once and running turns are interrupted.",
    loading: "Loading proxy settings",
    loadFailed: (message: string) => `Couldn't load proxy settings: ${message}`,
    fields: {
      httpProxy: { label: "HTTP proxy", description: "Used for http:// addresses." },
      httpsProxy: { label: "HTTPS proxy", description: "Used for https:// addresses. The model service usually goes through this one." },
      allProxy: { label: "Proxy for other connections", description: "Used when the two above are blank, and for other protocols. Supports SOCKS." },
      noProxy: { label: "No-proxy addresses", description: "Separate multiple entries with commas, e.g. internal domains, localhost." },
    },
    validation: {
      invalid: "This isn't a valid proxy address, e.g. http://127.0.0.1:7890",
      protocol: "Only http, https, and socks5 proxies are supported",
      host: "The proxy address needs a hostname or IP",
      credentials: "Proxies with a username and password aren't supported yet",
      path: "Enter the proxy address up to the port, without a path",
      noProxyNewline: "Line breaks aren't allowed. Separate multiple addresses with commas.",
    },
    saved: "Proxy saved. Codex reconnected with the new settings.",
    saveFailedTitle: "Couldn't save",
    test: {
      label: "Connection test",
      descriptionDraft: "Try connecting to the model service once with what you've entered. Nothing is saved.",
      descriptionEnv:
        "Try connecting to the model service with the proxy environment variables from when the local service started (or directly, if there are none).",
      descriptionSaved: "Try connecting to the model service with the saved proxy.",
      fixFirst: "Fix the addresses marked in red above before testing.",
      noTarget:
        "There's no model service address to test yet: Codex is using its built-in default service, or the model service URL hasn't been entered.",
      noTargetSuggestion: "Enter the URL in “Model service”, then come back to test the proxy.",
      viaProxy: "via proxy",
      direct: "direct",
      ok: (route: string, elapsed: string, target: string) =>
        `Model service reachable · ${route} · ${elapsed}${target === "" ? "" : ` · ${target}`}`,
      unreachable: (route: string, reason: string) => `Can't reach the model service (${route}): ${reason}`,
      suggestionProxy:
        "Check that the proxy address and port are correct and that your proxy app is running. You can add internal addresses to “No-proxy addresses”.",
      suggestionDirect: "If your company network needs a proxy to reach the model service, enter the proxy address above and try again.",
    },
    interrupt: {
      titleUnknown: "Codex will reconnect after you save",
      titleBusy: (count: number) =>
        plural("en", count, {
          one: "1 session is running or waiting for you",
          other: `${String(count)} sessions are running or waiting for you`,
        }),
      descriptionUnknown:
        "Couldn't check whether any sessions are running. After you save, Codex reconnects: turns in progress are interrupted and actions waiting for you are canceled.",
      descriptionBusy:
        "After you save, Codex reconnects: turns in progress in these sessions are interrupted and actions waiting for you are canceled. You can wait for them to finish before saving.",
      confirm: "Save anyway",
    },
  },
  workspace: {
    description:
      "The folder on your computer that holds each project's code. Sessions read and write code there. Your code is never uploaded to the requirements service.",
    recheck: "Check again",
    link: "Link local folder",
    linkedProjects: "Linked projects",
    loading: "Loading local folders",
    loadFailed: (message: string) => `Couldn't load local folders: ${message}`,
    empty: {
      title: "No local folders linked yet",
      description: "Link one to start sessions on this computer. You'll also be asked to choose one the first time you start a session.",
    },
    availability: {
      ok: "Available",
      missing: "Folder no longer exists",
      noPermission: "SuDuo doesn't have permission to read and write this folder",
      unavailable: "Folder is unavailable right now",
    },
    rowLabel: (name: string, status: string) => `${name}: ${status}`,
    change: "Change folder",
    reselect: "Choose again",
    moreActions: (name: string) => `More actions for “${name}”`,
    unlink: "Unlink",
    unlinkFailed: "Couldn't unlink",
    unavailableHint:
      "The folder may have been moved or deleted, or its permissions changed. Click “Choose again” to pick another folder. If you restore the original folder, click “Check again”.",
    unlinkConfirm: {
      title: (name: string) => `Unlink the local folder for “${name}”?`,
      description: "You'll need to choose a folder again before starting a session for this project. The code in the folder won't be deleted.",
      confirm: "Unlink",
    },
    dialog: {
      titleLink: "Link local folder",
      titleChange: (name: string) => `Change local folder for “${name}”`,
      description: "Choose the folder on your computer that holds this project's code. SuDuo needs to be able to read and write it.",
      project: "Project",
      projectPlaceholder: "Choose a project",
      alreadyLinked: " (already linked; replaces the current folder)",
      projectRequired: "Choose a project first",
      pathRequired: "Choose a local folder first",
      pathUnusable: "This folder can't be used right now. Choose one SuDuo can read and write.",
      cancel: "Cancel",
      link: "Link",
      useFolder: "Use this folder",
    },
  },
} satisfies Messages["settingsConnection"];
