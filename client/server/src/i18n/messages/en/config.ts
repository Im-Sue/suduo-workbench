import type { ServerMessages } from "../zh-CN/index.js";

export const config = {
  fields: {
    proxy: {
      httpProxy: "HTTP proxy",
      httpsProxy: "HTTPS proxy",
      allProxy: "Proxy for other connections",
      noProxy: "No-proxy addresses",
    },
    model: {
      baseUrl: "Service URL",
      apiKey: "API key",
      model: "Default model",
      reasoningEffort: "Default reasoning effort",
      contextWindow: "Context limit",
    },
  },
  mustBeString: (field: string) => `${field} must be text`,
  userLayerVersionMissing:
    "Codex didn't return a version for your user config layer, so the change wasn't written without version protection",
  proxy: {
    invalidUrl: (field: string) => `${field} isn't a valid proxy URL`,
    unsupportedProtocol: (field: string) => `${field} supports only http, https, socks5, and socks5h`,
    hostRequired: (field: string) => `${field} must include a proxy host`,
    credentialsUnsupported: (field: string) => `${field} can't include a username or password yet`,
    extraPartsUnsupported: (field: string) => `${field} can't include a path, query, or fragment`,
    noLineBreaks: (field: string) => `${field} can't contain line breaks`,
  },
  connectivity: {
    invalidBaseUrl: "The model service URL is invalid, so the connection can't be checked",
    invalidProxy: "The proxy variables in the environment are invalid, so the connection can't be checked",
    reached: (statusCode: number) =>
      `Reached the model service (HTTP ${String(statusCode)}; 401/403 only means it still needs Codex credentials)`,
    unreachable: (reason: string) => `Couldn't connect to the model service: ${reason}`,
    connectionFailed: "connection failed",
  },
  model: {
    nothingToUpdate: "Nothing to change: no fields were provided",
    baseUrlRequiredFirstTime: "Enter a service URL to set up the model service for the first time",
    invalidUrl: (field: string) => `${field} isn't a valid URL`,
    httpOnly: (field: string) => `${field} must use http or https`,
    invalidFormat: (field: string) => `${field} isn't in a valid format`,
    invalidModelName: (field: string) => `${field} isn't a valid model name`,
    contextWindowRange: (field: string) => `${field} must be a whole number from 4,000 to 100,000,000 (tokens)`,
    keyFromCommand: (program: string) => `Provided by a local command (${program})`,
    commandFallback: "command",
    keyFromEnv: (name: string, present: boolean) =>
      `From the environment variable ${name}${present ? "" : " (not set when the local service started)"}`,
    keyManagedByCodex: "Managed by Codex",
    savedOverridden: (effective: string | null, detail: string | null) =>
      (effective === null
        ? "Saved to your config, but a higher-level config overrides it."
        : `Saved to your config, but a higher-level config overrides it. The value in effect is still ${effective}.`) +
      (detail === null || detail === "" ? "" : ` ${detail}`),
    saved: "Saved. Codex has loaded the new config, which takes effect from the next turn.",
    rollbackConflict: (original: string, rollback: string) =>
      `Codex couldn't validate the model, and the automatic revert ran into a version conflict: ${original}; revert error: ${rollback}`,
    loginFailed: (detail: string) => `Codex couldn't sign in with the API key: ${detail}`,
  },
  mcp: {
    created: "Added the MCP server through Codex's official interface and reloaded it.",
    updatedAtomically: "Updated the MCP server atomically through Codex config/batchWrite and reloaded it.",
    updatedNonAtomically:
      "Replaced the server non-atomically with the Codex CLI. If a later step fails, recreate the server from its original config.",
    atomicUpdateFailed: (detail: string) => `Couldn't update the Codex MCP config atomically: ${detail}`,
    cliCannotExpress:
      "Codex RPC is unavailable, and this change includes fields the CLI can't express safely, so no non-atomic replacement was made.",
    listLabel: "The Codex MCP list",
    detailLabel: "The Codex MCP details",
    returnedInvalidJson: (label: string) => `${label} returned invalid JSON`,
    listNotArray: "The Codex MCP list returned invalid JSON",
    detailNameMismatch: "The Codex MCP details returned a different server name",
    statusPagesUnfinished: "Codex MCP status paging didn't finish",
    createCleanupFailed:
      "Couldn't write the official config after adding the MCP server, and the automatic cleanup also failed. Check the Codex config and delete the server manually.",
    createCleanedUp: (detail: string) =>
      `Couldn't write the official config after adding the MCP server, so it was removed again: ${detail}`,
    commandTimedOut: "The Codex MCP command timed out",
    commandOutputTooLarge: "The Codex MCP command's output went over the safety limit",
    commandFailed: (detail: string) => `The Codex MCP command failed: ${detail}`,
    createBodyInvalid: "The MCP create request must be a JSON object",
    updateBodyInvalid: "The MCP edit request must be a JSON object",
    nothingToUpdate: "Nothing to change: no MCP fields were provided",
    transportNotObject: "transport must be a JSON object",
    transportTypeInvalid: "transport.type must be stdio or http",
    httpNoEnvVars: "HTTP MCP servers don't support envVars",
    configMissingTransport: "The Codex MCP config is missing its transport fields",
    entryNotObject: "A Codex MCP entry isn't an object",
    entryMissingTransport: "A Codex MCP entry is missing transport",
    entryMissingEnabled: "A Codex MCP entry is missing enabled",
    unknownTransport: "Codex MCP returned an unknown transport",
    protocolFieldInvalid: (label: string) => `${label} is invalid`,
    nameInvalid:
      "MCP names must start with a letter and use only letters, digits, underscores, or hyphens (up to 64 characters)",
    commandInvalid: "The MCP stdio command is invalid",
    argsInvalid: "MCP args must be a list of at most 64 strings",
    argInvalid: "MCP args contain an invalid string",
    secretInArgs:
      "Secrets must come from system environment variables; stdio arguments can't pass a token, key, password, or secret",
    urlInvalid: "The MCP HTTP URL is invalid",
    urlUnsupported: "The MCP HTTP URL must be an http or https address without credentials",
    envVarsInvalid: "envVars must be a list of at most 32 environment variable names",
    envVarInvalid: "Environment variables must be valid variable names, not values",
    scopesInvalid: "scopes must be a list of at most 32 strings",
    scopeInvalid: "The OAuth scope is invalid",
    mustBeBoolean: (field: string) => `${field} must be a boolean`,
    timeoutInvalid: (field: string) => `${field} must be a whole number of seconds from 1 to 86400`,
    serverNotFound: (name: string) => `Codex MCP server not found: ${name}`,
  },
  skill: {
    zipEmptyContent: "The zip has no content",
    zipTooLarge: "The zip is over the 30 MiB limit",
    zipCorrupted: "Couldn't unzip the file. It may be damaged.",
    zipEmpty: "The zip is empty",
    zipTooManyFiles: "The zip has more than 2,000 files",
    unpackedTooLarge: "The unzipped files are over the 50 MiB limit",
    zipMissingSkillFile: "The zip must contain SKILL.md at its root or in its only top-level folder",
    folderRequired: "A folder path is required",
    folderNotFound: (path: string) => `Folder not found: ${path}`,
    folderMissingSkillFile: "This folder has no SKILL.md",
    alreadyExists: (name: string) => `A global Skill named “${name}” already exists. Confirm to overwrite it.`,
    notRecognized: "No valid SKILL.md was found after installing",
    pathRequired: "A Skill path is required",
    outsideGlobalRoot: "Only Skills in the global Skills folder can be managed here",
    zipUnsafePath: (path: string) => `The zip contains an invalid path: ${path}`,
    zipEntryEscapes: "A zip entry points outside the install folder",
    nameUnresolvable: "Couldn't work out a valid Skill name from the source",
  },
  settings: {
    mustBeBoolean: (field: string) => `${field} must be a boolean`,
    globalSkillsLocked: "globalSkills is locked by the SUDUO_GLOBAL_SKILLS environment variable",
    approvalModeInvalid: "defaultApprovalMode must be ask, auto, or full",
  },
  configFile: {
    onlyCurrentHome: "Only config.toml in the current CODEX_HOME can be opened",
    missing: "The Codex config file doesn't exist, so it can't be opened",
    openFailed: "Couldn't open the Codex config file in the system editor",
  },
} satisfies ServerMessages["config"];
