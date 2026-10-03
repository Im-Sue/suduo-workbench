import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RpcInbound } from "@suduo/client-contracts";
import {
  StdioCodexTransport,
  initializeCodexConnection,
} from "../../src/infrastructure/transport/stdio-codex-transport.js";

interface Evidence {
  codexCliVersion: string;
  observed: {
    skills: { nativeType: string };
    mcp: { nativeType: string | null };
  };
  inheritedVerified: string[];
}

const evidencePath = fileURLToPath(
  new URL("./codex-global-notifications.evidence.json", import.meta.url),
);
const execFile = promisify(execFileCallback);

async function main(): Promise<void> {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Evidence;
  const fixtureRoot = await mkdtemp(join(tmpdir(), "suduo-codex-global-"));
  const codexHome = join(fixtureRoot, "codex-home");
  const skillsRoot = join(codexHome, "skills");
  const workspace = join(fixtureRoot, "workspace");
  const mcpScript = join(fixtureRoot, "local-mcp.mjs");
  const mcpTracePath = join(fixtureRoot, "mcp-trace.log");
  let connection: Awaited<ReturnType<StdioCodexTransport["connect"]>> | null = null;
  const abort = new AbortController();
  let collect: Promise<void> | null = null;
  let mcpStatus: unknown;
  try {
    const codexBin = await resolveFixtureCodexBin(
      evidence.codexCliVersion,
      isolatedEnvironment(codexHome),
    );
    const seedSkill = join(skillsRoot, "seed", "SKILL.md");
    await Promise.all([
      mkdir(dirname(seedSkill), { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    await writeFile(
      seedSkill,
      "---\nname: seed\ndescription: isolated watcher fixture\n---\n# seed\n",
      "utf8",
    );
    await writeFile(mcpScript, localMcpResponder(mcpTracePath), "utf8");
    const transport = new StdioCodexTransport();
    connection = await transport.connect({
      codexBin,
      env: isolatedEnvironment(codexHome),
      signal: abort.signal,
    });
    const observed: string[] = [];
    collect = collectNotifications(connection, abort.signal, observed);

    await initializeCodexConnection(connection, { signal: abort.signal });
    await connection.request(
      "skills/extraRoots/set",
      { extraRoots: [skillsRoot] },
      { timeoutMs: 20_000, signal: abort.signal },
    );
    await connection.request(
      "skills/list",
      { cwds: [workspace], forceReload: true },
      { timeoutMs: 20_000, signal: abort.signal },
    );
    const changedSkill = join(skillsRoot, "changed", "SKILL.md");
    await mkdir(dirname(changedSkill), { recursive: true });
    await writeFile(
      changedSkill,
      "---\nname: changed\ndescription: watcher trigger\n---\n# changed\n",
      "utf8",
    );
    await execFile(
      codexBin,
      ["mcp", "add", "fixture", "--", process.execPath, mcpScript],
      { env: isolatedEnvironment(codexHome), timeout: 20_000 },
    );
    await connection.request(
      "config/mcpServer/reload",
      null,
      { timeoutMs: 20_000, signal: abort.signal },
    );
    mcpStatus = await connection.request(
      "mcpServerStatus/list",
      { detail: "full" },
      { timeoutMs: 20_000, signal: abort.signal },
    );

    assertMcpStatus(mcpStatus);
    await waitForNativeTypes(observed, [
      ...evidence.inheritedVerified,
      evidence.observed.skills.nativeType,
    ], mcpStatus, await readFixtureTrace(mcpTracePath));
    process.stdout.write(
      JSON.stringify({
        fixture: "isolated CODEX_HOME",
        observedNativeTypes: [...new Set(observed)].sort(),
        unverifiedNativeTypes: evidence.observed.mcp.nativeType === null
          ? ["mcpServer/startupStatus/updated"]
          : [],
      }) + "\n",
    );
  } finally {
    abort.abort();
    await connection?.close();
    await collect?.catch((error: unknown) => {
      if (!isExpectedAbort(error)) {
        throw error;
      }
    });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function collectNotifications(
  connection: Awaited<ReturnType<StdioCodexTransport["connect"]>>,
  signal: AbortSignal,
  observed: string[],
): Promise<void> {
  try {
    for await (const message of connection.messages({ signal })) {
      const nativeType = notificationMethod(message);
      if (nativeType) {
        observed.push(nativeType);
      }
    }
  } catch (error) {
    if (!isExpectedAbort(error)) {
      throw error;
    }
  }
}

function notificationMethod(message: RpcInbound): string | null {
  return message.kind === "notification" ? message.method : null;
}

function assertMcpStatus(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray((value as { data?: unknown }).data) ||
    !(value as { data: unknown[] }).data.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { name?: unknown }).name === "fixture",
    )
  ) {
    throw new Error("isolated local MCP responder was not listed");
  }
}

async function waitForNativeTypes(
  observed: readonly string[],
  expected: readonly string[],
  mcpStatus: unknown,
  mcpTrace: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (expected.every((nativeType) => observed.includes(nativeType))) {
      return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    "expected global notifications were not observed: " +
      JSON.stringify({ expected, observed: [...new Set(observed)].sort(), mcpStatus, mcpTrace }),
  );
}

function isolatedEnvironment(codexHome: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env["CODEX_HOME"] = codexHome;
  return env;
}

async function resolveFixtureCodexBin(
  expectedVersion: string,
  env: Record<string, string>,
): Promise<string> {
  const override = process.env["SUDUO_CODEX_NOTIFICATION_FIXTURE_BIN"];
  const candidates = override
    ? [override]
    : (process.env["PATH"] ?? "")
        .split(delimiter)
        .map((directory) =>
          join(directory, process.platform === "win32" ? "codex.cmd" : "codex"),
        )
        .filter((candidate, index, values) =>
          existsSync(candidate) && values.indexOf(candidate) === index,
        );
  for (const candidate of candidates) {
    try {
      const version = (await execFile(candidate, ["--version"], {
        env,
        timeout: 20_000,
      })).stdout.trim();
      if (version === expectedVersion) {
        return candidate;
      }
    } catch {
      // PATH 中可能有不可执行或不兼容的同名命令，继续找钉版 CLI。
    }
  }
  throw new Error(
    "isolated fixture requires " +
      expectedVersion +
      "; set SUDUO_CODEX_NOTIFICATION_FIXTURE_BIN to its executable",
  );
}

function localMcpResponder(tracePath: string): string {
  return `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(tracePath)}, request.method + "\\n");
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [] }
      : request.method === "resources/list"
        ? { resources: [] }
        : request.method === "resources/templates/list"
          ? { resourceTemplates: [] }
          : { prompts: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;
}

async function readFixtureTrace(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function isExpectedAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("aborted") || error.message.includes("exited"))
  );
}

await main();
