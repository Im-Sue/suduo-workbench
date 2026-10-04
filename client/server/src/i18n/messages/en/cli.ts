import type { ServerMessages } from "../zh-CN/index.js";

export const cli = {
  hostMustBeLoopback: "SUDUO_HOST must be exactly 127.0.0.1",
  transportStdioOnly: "SUDUO_CODEX_TRANSPORT only supports stdio in M1",
  integerOutOfRange: (name: string, minimum: number, maximum: number) =>
    `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
  codexVersionMismatch: (configured: string, pinned: string) =>
    `SUDUO_CODEX_VERSION=${configured} in the install config doesn't match the pinned Codex ${pinned}. Run the installer again (pnpm install:m1) to update it.`,
  codexHomeMissing: (path: string) =>
    `The directory CODEX_HOME points to doesn't exist: ${path}. Codex won't be able to start. Check SUDUO_CODEX_HOME / CODEX_HOME, or remove the setting to use the default ~/.codex.`,
  runtimeConfigPathRequired: "--runtime-config requires a config file path",
  runtimeConfigKeyNotAllowed: (key: string) => `runtime config contains an environment variable that isn't allowed: ${key}`,
  runtimeConfigNotObject: "runtime config must be a JSON object",
  runtimeConfigSchemaVersion: "runtime config schemaVersion must be 1",
  runtimeConfigEnvironmentNotObject: "runtime config environment must be an object",
  runtimeConfigValueNotString: (key: string) => `runtime config environment values must be non-empty strings: ${key}`,
  runtimeConfigPathNotRelative: (key: string) => `${key} must be a path relative to the install directory`,
  runtimeConfigPathOutsideInstall: (key: string) => `${key} must not point outside the install directory`,
  pinnedCodexNotFound: (version: string) =>
    `Couldn't find the Codex ${version} pinned in the workspace. Set SUDUO_CODEX_BIN to an absolute or relative path.`,
  databaseAdapterLoadFailed:
    "Couldn't load the better-sqlite3 native adapter. Make sure your Node version matches the prebuilt package for this platform, then run pnpm install again.",
  legacyMigrations: (versions: readonly number[]) =>
    `The local database has legacy migration versions [${versions.join(", ")}]. Delete it and restart to recreate it (see D4).`,
  maxApprovalModeInvalid: "SUDUO_MAX_APPROVAL_MODE must be ask, auto, or full",
  requirementsSettingsInvalid: "The local requirements service settings file (V2) has an invalid format",
  serverAddressEmpty: "The server address can't be empty",
  serverAddressNotUrl: "The server address isn't a valid URL",
  serverAddressProtocol: "The server address must use http or https",
  serverAddressCredentials: "The server address can't include a username or password",
  serverAddressOriginOnly: "The server address can only have a protocol, host, and optional port",
  privateJsonUnreadable: "Couldn't read or parse a local settings file (V2)",
} satisfies ServerMessages["cli"];
