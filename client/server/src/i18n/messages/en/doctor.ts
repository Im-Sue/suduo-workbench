import type { ServerMessages } from "../zh-CN/index.js";

export const doctor = {
  names: {
    codexDoctor: "Codex doctor",
    linuxSandbox: "Codex sandbox (Linux)",
    port: "Listening port",
    toolServer: "SuDuo local tool server",
  },
  version: {
    pinned: (actual: string) => `${actual} (pinned)`,
    mismatch: (expected: string, actual: string | null) =>
      actual === null ? `Needs ${expected}; not available` : `Needs ${expected}; found ${actual}`,
    supported: (actual, minimum) => `${actual} (needs ${minimum.split(".")[0] ?? minimum}.x, ${minimum} or later)`,
    belowMinimum: (minimum, actual) => `Needs ${minimum.split(".")[0] ?? minimum}.x, ${minimum} or later; found ${actual}`,
  },
  command: {
    windowsOk: (expected: string, output: string) =>
      `The command runs (the project pins ${expected}); output for diagnostics only: ${output}`,
    windowsFailed: (status: string, stderr: string) => `The command failed with status=${status}; stderr: ${stderr}`,
  },
  codex: {
    invalidJson: (detail: string) => `codex doctor --json returned invalid JSON: ${detail}`,
    runFailed: (status: string, stderr: string) => `codex doctor --json failed with status=${status}; stderr: ${stderr}`,
    mustBeObject: (label: string) => `${label} must be an object`,
    missingField: (field: string) => `codex doctor --json is missing ${field}`,
    noSummary: "No summary provided",
    noChecks: (overallStatus: string) => `codex doctor --json returned no checks (overallStatus=${overallStatus})`,
    cliPinned: (version: string) => `codex-cli ${version} (pinned in the workspace)`,
    cliMismatch: (expected: string, actual: string | null) =>
      `Needs codex-cli ${expected}; found ${actual ?? "an unknown version"}`,
  },
  sandbox: {
    readySystem: (path: string) => `The sandbox works, using the system bubblewrap (${path})`,
    readyBundled:
      "The sandbox works, but it uses the bubblewrap bundled with Codex. OpenAI recommends installing the system bubblewrap.",
    readyBundledRemediation: (docs: string) =>
      `sudo apt install bubblewrap (Fedora: sudo dnf install bubblewrap). See ${docs}`,
    timedOut: (seconds: number) =>
      `The sandbox command didn't finish within ${String(seconds)} seconds, so it's unclear whether the sandbox works`,
    timedOutRemediation:
      "Check again later on the Diagnostics page. If it keeps happening, run codex sandbox -P :workspace -- true in a terminal to see where it gets stuck.",
    exitCode: (status: string) => `exit code ${status}`,
    notRun: (detail: string) => `Couldn't run Codex's sandbox command, so it's unclear whether the sandbox works (${detail})`,
    notRunRemediation: "Fix the problems under “Codex doctor” and “Codex CLI” above first, then check again",
    causes: {
      container: "SuDuo runs in a container, and containers don't allow creating user namespaces by default",
      noSystemBwrap: "the system bubblewrap isn't installed",
      apparmorRestricted: "the system restricts unprivileged user namespaces with AppArmor (the default on Ubuntu 24.04)",
    },
    steps: {
      container:
        "allow the container to create user namespaces (for example, add --security-opt seccomp=unconfined --security-opt apparmor=unconfined for Docker), or install SuDuo on the host",
      installBwrap: "sudo apt install bubblewrap (Fedora: sudo dnf install bubblewrap)",
      loadApparmorProfile: (command: string) => `load OpenAI's AppArmor profile that allows it: ${command}`,
      reinstallService:
        "SuDuo runs as a system service, so run the installer again (pnpm install:m1) to update the service config, then restart the service",
    },
    unavailable: (causes: readonly string[], detail: string) =>
      "Codex's sandbox can't start on this machine, so commands that need approval or restricted execution will fail" +
      (causes.length > 0 ? `: ${causes.join("; ")}` : "") +
      ` (${detail})`,
    remediation: (steps: readonly string[], docs: string, loosen: boolean) =>
      (steps.length > 0 ? `To fix: ${steps.join("; then ")}. ` : "") +
      `Follow OpenAI's sandbox prerequisites: ${docs}` +
      (loosen
        ? ". If it still doesn't work, you can relax the restriction: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
        : ""),
  },
  sqlite: {
    ok: "The native addon loads, and migrations and WAL reads and writes work on a temporary database",
  },
  port: {
    available: (address: string) => `${address} is available`,
    inUseBySuDuo: (address: string) => `${address} is in use (the service is running)`,
    inUseByOther: (address: string) => `${address} is in use by another program`,
  },
  agent: {
    separator: "; ",
    ready: (version: string | null) => (version === null ? "Ready (version unreadable)" : `Ready, version ${version}`),
    installed: (version: string | null) =>
      `${version === null ? "Installed (version unreadable)" : `Installed, version ${version}`}; sign-in is confirmed on first use`,
    checkTimeout: "Installed; reading the version timed out (common on first run). It still works",
    authRequired: (version: string | null) => `${version === null ? "" : `Version ${version}; `}needs sign-in`,
    notInstalledDefault: "Executable not found (it's the default agent, so new sessions can't use it)",
    versionUnsupported: (version: string, minimum: string) => `Version ${version} is below the minimum ${minimum}`,
    checking: "Still checking. Check again in a moment",
    error: (detail: string) => `Check failed: ${detail}`,
    unverified: (version: string, verified: string) =>
      `Version ${version} isn't in the range SuDuo has verified (${verified}). It usually works; if you hit problems, try a verified version first`,
    path: (path: string) => `at ${path}`,
    loginRemediation: (command: string) => `Run ${command} in a terminal to sign in (SuDuo never reads or stores your credentials)`,
    installRemediation: (url: string) => `Install it following the official instructions: ${url}, or pick another default agent in Settings > AI Agents`,
  },
  toolServer: {
    listening: (url: string) => `At ${url} (agents other than Codex use it for requirement, session, and delegation tools)`,
    notListening: "Not listening yet: agents other than Codex can't use SuDuo's tools for now",
  },
  page: {
    title: "SuDuo self-check",
    heading: "Local environment self-check",
    checkedAt: (time: string) => `Checked at ${time}`,
    remediation: (text: string) => `Suggested fix: ${text}`,
    copy: "Copy diagnostics",
    copied: "Diagnostics copied",
  },
  cli: {
    passed: "Self-check passed. You can start SuDuo.",
    failed: "Self-check failed. Fix the problems above first; SuDuo won't start the service until they pass.",
    invalidPort: "--port must be an integer between 1 and 65535",
  },
} satisfies ServerMessages["doctor"];
