import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CODEX_VERSION,
  type ApprovalDto,
  type EventEnvelope,
  type JsonValue,
  type SendMessageAccepted,
  type SessionDto,
} from "@suduo/client-contracts";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";

const serverRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(serverRoot, "..");
const artifactRoot = resolve(workspaceRoot, "artifacts", "gate-b");
const projectRoot = resolve(artifactRoot, "project");
const databasePath = resolve(artifactRoot, "gate-b.sqlite");
const resultPath = resolve(artifactRoot, "result.json");
const serverEntry = resolve(serverRoot, "dist", "main.js");
const codexBin = resolve(
  workspaceRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "codex.cmd" : "codex",
);
const codexHome =
  process.env["SUDUO_CODEX_HOME"] ?? process.env["CODEX_HOME"];

async function main(): Promise<void> {
  rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(projectRoot, { recursive: true });
writeFileSync(
  resolve(projectRoot, "README.md"),
  "# Gate B fixture\n\nHTTP + SSE + resume integration fixture.\n",
);

  const codexVersion = spawnSync(codexBin, ["--version"], {
  encoding: "utf8",
  env: runtimeEnvironment(),
}).stdout.trim();
if (codexVersion !== `codex-cli ${CODEX_VERSION}`) {
  throw new Error(`Gate B requires codex-cli ${CODEX_VERSION}, received ` + codexVersion);
}

  const port = await availablePort();
  const origin = "http://127.0.0.1:" + String(port);
  let processHandle: ChildProcess | null = null;
  let stream: SseClient | null = null;

try {
  processHandle = await startServer(port);
  let cookie = "";

  const projectResponse = await api(origin, cookie, "POST", "/api/v1/projects", {
    key: "gate-b-project",
    body: { rootPath: projectRoot, name: "Gate B" },
  });
  assertStatus(projectResponse, 201, "create project");
  const project = await projectResponse.json() as { id: string };
  const projectReplay = await api(origin, cookie, "POST", "/api/v1/projects", {
    key: "gate-b-project",
    body: { rootPath: projectRoot, name: "Gate B" },
  });
  assertStatus(projectReplay, 201, "replay project");
  if (JSON.stringify(await projectReplay.json()) !== JSON.stringify(project)) {
    throw new Error("project idempotency replay changed the first response");
  }
  const projectConflict = await api(
    origin,
    cookie,
    "POST",
    "/api/v1/projects",
    {
      key: "gate-b-project",
      body: { rootPath: projectRoot, name: "different" },
    },
  );
  assertStatus(projectConflict, 409, "project idempotency conflict");

  const sessionResponse = await api(
    origin,
    cookie,
    "POST",
    `/api/v1/projects/${project.id}/sessions`,
    { key: "gate-b-session", body: { title: "Gate B" } },
  );
  assertStatus(sessionResponse, 201, "create session");
  const session = await sessionResponse.json() as SessionDto;
  if (session.threads.length !== 1 || !session.threads[0]?.primary) {
    throw new Error("Gate B session does not have one primary thread");
  }

  stream = await SseClient.connect(origin, cookie, session.id, 0);
  const streamBody = {
    content: [{ type: "text", text: "请只回复一句：gate stream ok。" }],
  };
  const streamMessage = await sendMessage(
    origin,
    cookie,
    session.id,
    "gate-b-stream",
    streamBody,
  );
  const streamCompleted = await stream.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === streamMessage.turnRef.turnId,
    180_000,
  );
  if (
    !stream.events.some(
      (event) =>
        event.type === "message.delta" &&
        event.turnRef?.turnId === streamMessage.turnRef.turnId,
    )
  ) {
    throw new Error("streaming turn produced no message.delta over SSE");
  }
  const streamReplay = await sendMessage(
    origin,
    cookie,
    session.id,
    "gate-b-stream",
    streamBody,
  );
  if (JSON.stringify(streamReplay) !== JSON.stringify(streamMessage)) {
    throw new Error("message idempotency replay changed the first response");
  }
  const messageConflict = await api(
    origin,
    cookie,
    "POST",
    `/api/v1/sessions/${session.id}/messages`,
    {
      key: "gate-b-stream",
      body: { content: [{ type: "text", text: "different body" }] },
    },
  );
  assertStatus(messageConflict, 409, "message idempotency conflict");

  const reconnectAfter = streamCompleted.seq;
  stream.close();
  stream = null;
  const acceptFile = resolve(projectRoot, "APPROVAL_ACCEPT.txt");
  const acceptTurn = await sendMessage(
    origin,
    cookie,
    session.id,
    "gate-b-accept-turn",
    {
      content: [
        {
          type: "text",
          text: "必须实际执行 shell 命令：printf approved > APPROVAL_ACCEPT.txt。执行后只回复 done。",
        },
      ],
    },
  );
  await delay(500);
  stream = await SseClient.connect(
    origin,
    cookie,
    session.id,
    reconnectAfter,
  );
  const acceptApprovalEvent = await stream.waitFor(
    (event) =>
      event.type === "approval.requested" &&
      event.turnRef?.turnId === acceptTurn.turnRef.turnId,
    180_000,
  );
  if (acceptApprovalEvent.seq <= reconnectAfter) {
    throw new Error("SSE reconnect did not honor after=seq");
  }
  const acceptApprovalId = requirePayloadString(
    acceptApprovalEvent.payload,
    "approvalId",
  );
  const accepted = await decideApproval(
    origin,
    cookie,
    acceptApprovalId,
    "accept",
    "gate-b-accept",
  );
  if (accepted.status !== "resolved" || accepted.decision !== "accept") {
    throw new Error("accept approval did not resolve");
  }
  await stream.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === acceptTurn.turnRef.turnId,
    180_000,
  );
  if (!existsSync(acceptFile)) {
    throw new Error("accepted command did not create APPROVAL_ACCEPT.txt");
  }

  const declineFile = resolve(projectRoot, "APPROVAL_DECLINE.txt");
  const declineTurn = await sendMessage(
    origin,
    cookie,
    session.id,
    "gate-b-decline-turn",
    {
      content: [
        {
          type: "text",
          text: "必须实际执行 shell 命令：printf declined > APPROVAL_DECLINE.txt。执行后只回复 done。",
        },
      ],
    },
  );
  const declineApprovalEvent = await stream.waitFor(
    (event) =>
      event.type === "approval.requested" &&
      event.turnRef?.turnId === declineTurn.turnRef.turnId,
    180_000,
  );
  const declineApprovalId = requirePayloadString(
    declineApprovalEvent.payload,
    "approvalId",
  );
  const declined = await decideApproval(
    origin,
    cookie,
    declineApprovalId,
    "decline",
    "gate-b-decline",
  );
  if (declined.status !== "resolved" || declined.decision !== "decline") {
    throw new Error("decline approval did not resolve");
  }
  await stream.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === declineTurn.turnRef.turnId,
    180_000,
  );
  if (existsSync(declineFile)) {
    throw new Error("declined command created APPROVAL_DECLINE.txt");
  }

  const interruptTurn = await sendMessage(
    origin,
    cookie,
    session.id,
    "gate-b-interrupt-turn",
    {
      content: [
        {
          type: "text",
          text: "请从 1 数到 10000，每行一个数字，不要省略。",
        },
      ],
    },
  );
  await stream.waitFor(
    (event) =>
      event.type === "turn.started" &&
      event.turnRef?.turnId === interruptTurn.turnRef.turnId,
    60_000,
  );
  await delay(300);
  const interruptResponse = await api(
    origin,
    cookie,
    "POST",
    `/api/v1/sessions/${session.id}/interrupt`,
    {
      key: "gate-b-interrupt",
      body: {
        threadRef: interruptTurn.threadRef,
        turnId: interruptTurn.turnRef.turnId,
      },
    },
  );
  assertStatus(interruptResponse, 202, "interrupt");
  await stream.waitFor(
    (event) =>
      (event.type === "turn.interrupted" || event.type === "turn.completed") &&
      event.turnRef?.turnId === interruptTurn.turnRef.turnId,
    60_000,
  );

  const preRestartSeq = stream.lastSeq;
  stream.close();
  stream = null;
  await killServer(processHandle);
  processHandle = null;
  processHandle = await startServer(port);
  cookie = "";
  const resumedSessionResponse = await api(
    origin,
    cookie,
    "GET",
    `/api/v1/sessions/${session.id}`,
  );
  assertStatus(resumedSessionResponse, 200, "load session after restart");
  stream = await SseClient.connect(
    origin,
    cookie,
    session.id,
    preRestartSeq,
  );
  const resumedTurn = await sendMessage(
    origin,
    cookie,
    session.id,
    "gate-b-resume-turn",
    { content: [{ type: "text", text: "请只回复：gate resume ok。" }] },
  );
  await stream.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === resumedTurn.turnRef.turnId,
    180_000,
  );

  const finalLastSeq = stream.lastSeq;
  stream.close();
  stream = null;
  await stopServer(processHandle);
  processHandle = null;

  const database = openBetterSqlite3Database(databasePath);
  runMigrations(database);
  try {
    const persisted = new EventRepository(database).listAfter(session.id, 0, 20_000);
    if (persisted.length === 0) {
      throw new Error("Gate B persisted no events");
    }
    const seqs = persisted.map((event) => event.seq);
    if (new Set(seqs).size !== seqs.length) {
      throw new Error("Gate B persisted duplicate seq values");
    }
    for (let index = 1; index < seqs.length; index += 1) {
      if (seqs[index] !== (seqs[index - 1] as number) + 1) {
        throw new Error("Gate B event seq is not continuous");
      }
    }
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          codexVersion,
          codexHome: codexHome ?? null,
          projectId: project.id,
          sessionId: session.id,
          acceptApprovalId,
          declineApprovalId,
          reconnectAfter,
          finalLastSeq,
          persistedEventCount: persisted.length,
          firstSeq: seqs[0],
          lastSeq: seqs.at(-1),
          idempotency: {
            replay: "same response",
            conflictStatus: projectConflict.status,
          },
          resumeTurnId: resumedTurn.turnRef.turnId,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    database.close();
  }

  process.stdout.write(
    JSON.stringify({
      gate: "B",
      status: "passed",
      resultPath,
      codexHome: codexHome ?? "default",
    }) + "\n",
  );
} finally {
  stream?.close();
  if (processHandle) {
    await stopServer(processHandle).catch(() => undefined);
  }
}
}

async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: workspaceRoot,
    env: {
      ...runtimeEnvironment(),
      SUDUO_HOST: "127.0.0.1",
      SUDUO_PORT: String(port),
      SUDUO_DB_PATH: databasePath,
      SUDUO_CODEX_BIN: codexBin,
      SUDUO_LOG_LEVEL: "silent",
      SUDUO_SSE_HEARTBEAT_MS: "5000",
      ...(codexHome === undefined
        ? {}
        : { CODEX_HOME: codexHome, SUDUO_CODEX_HOME: codexHome }),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<never>((_resolve, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          "suduo server exited before ready; code=" +
            String(code) +
            " signal=" +
            String(signal) +
            " stderr=" +
            stderr.slice(-4000),
        ),
      );
    });
  });
  await Promise.race([
    waitForHttpReady("http://127.0.0.1:" + String(port), 30_000),
    exited,
  ]);
  return child;
}

async function waitForHttpReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl + "/api/v1/projects", {
        headers: { Host: new URL(baseUrl).host },
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // The listener is not ready yet.
    }
    await delay(100);
  }
  throw new Error("timeout waiting for suduo HTTP server");
}

async function api(
  baseUrl: string,
  cookie: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { key?: string; body?: unknown; ifMatch?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Cookie: cookie };
  if (method !== "GET") {
    headers["Origin"] = baseUrl;
    headers["Idempotency-Key"] = options.key ?? "gate-b-" + crypto.randomUUID();
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.ifMatch !== undefined) {
    headers["If-Match"] = `"${String(options.ifMatch)}"`;
  }
  return fetch(baseUrl + path, {
    method,
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function sendMessage(
  baseUrl: string,
  cookie: string,
  sessionId: string,
  key: string,
  body: unknown,
): Promise<SendMessageAccepted> {
  const response = await api(
    baseUrl,
    cookie,
    "POST",
    `/api/v1/sessions/${sessionId}/messages`,
    { key, body },
  );
  assertStatus(response, 202, "send message " + key);
  return response.json() as Promise<SendMessageAccepted>;
}

async function decideApproval(
  baseUrl: string,
  cookie: string,
  approvalId: string,
  decision: "accept" | "decline",
  key: string,
): Promise<ApprovalDto> {
  const response = await api(
    baseUrl,
    cookie,
    "POST",
    `/api/v1/approvals/${approvalId}/decision`,
    { key, body: { decision } },
  );
  assertStatus(response, 200, "decide approval " + decision);
  return response.json() as Promise<ApprovalDto>;
}

class SseClient {
  readonly events: EventEnvelope<string, JsonValue>[] = [];
  private readonly waiters = new Set<{
    predicate(event: EventEnvelope<string, JsonValue>): boolean;
    resolve(event: EventEnvelope<string, JsonValue>): void;
    reject(error: Error): void;
  }>();
  private readonly abort = new AbortController();
  private closed = false;

  private constructor(private readonly response: Response) {}

  static async connect(
    baseUrl: string,
    cookie: string,
    sessionId: string,
    after: number,
  ): Promise<SseClient> {
    const abort = new AbortController();
    const response = await fetch(
      `${baseUrl}/api/v1/sessions/${sessionId}/events?after=${String(after)}`,
      {
        headers: { Cookie: cookie, Accept: "text/event-stream" },
        signal: abort.signal,
      },
    );
    assertStatus(response, 200, "connect SSE");
    const client = new SseClient(response);
    client.abort.signal.addEventListener("abort", () => abort.abort(), {
      once: true,
    });
    void client.consume();
    return client;
  }

  get lastSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  waitFor(
    predicate: (event: EventEnvelope<string, JsonValue>) => boolean,
    timeoutMs: number,
  ): Promise<EventEnvelope<string, JsonValue>> {
    const existing = this.events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolveWait, reject) => {
      const waiter = {
        predicate,
        resolve: (event: EventEnvelope<string, JsonValue>) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolveWait(event);
        },
        reject,
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timeout waiting for SSE event"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.abort.abort();
  }

  private async consume(): Promise<void> {
    const reader = this.response.body?.getReader();
    if (!reader) {
      this.fail(new Error("SSE response has no readable body"));
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.abort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.acceptFrame(frame);
          boundary = buffer.indexOf("\n\n");
        }
      }
      if (!this.abort.signal.aborted) {
        this.fail(new Error("SSE connection ended unexpectedly"));
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private acceptFrame(frame: string): void {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      return;
    }
    const event = JSON.parse(data) as EventEnvelope<string, JsonValue>;
    if (this.events.some((existing) => existing.seq === event.seq)) {
      throw new Error("SSE delivered duplicate seq " + String(event.seq));
    }
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(event)) {
        waiter.resolve(event);
      }
    }
  }

  private fail(error: Error): void {
    for (const waiter of this.waiters) {
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await waitForExitOrTimeout(child, 10_000);
  if (!exited) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

async function killServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    process.kill(-child.pid, "SIGKILL");
  } else {
    child.kill("SIGKILL");
  }
  await waitForExit(child);
  await delay(500);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveWait) => child.once("exit", () => resolveWait()));
}

function waitForExitOrTimeout(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveWait) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveWait(false);
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

function requirePayloadString(payload: JsonValue, key: string): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("event payload is not an object");
  }
  const value = payload[key];
  if (typeof value !== "string") {
    throw new Error("event payload is missing " + key);
  }
  return value;
}

function assertStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(
      label +
        " expected HTTP " +
        String(expected) +
        ", received " +
        String(response.status),
    );
  }
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(codexHome === undefined
      ? {}
      : { CODEX_HOME: codexHome, SUDUO_CODEX_HOME: codexHome }),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate Gate B port");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

await main();
