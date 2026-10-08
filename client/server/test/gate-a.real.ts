import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import {
  CODEX_VERSION,
  type ApprovalDecision,
  type EventEnvelope,
  type JsonValue,
  type RuntimeToolCallRequest,
  type RuntimeToolOutputItem,
} from "@suduo/client-contracts";
import { EventLedger, type EventPublisher } from "../src/application/event-ledger.js";
import { RuntimeEventIngestor } from "../src/application/runtime-event-ingestor.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { IdempotencyRepository } from "../src/infrastructure/db/repositories/idempotency-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { CodexRuntime } from "../src/infrastructure/runtime/codex/codex-runtime.js";
import { StdioCodexTransport } from "../src/infrastructure/transport/stdio-codex-transport.js";

class EventCollector implements EventPublisher {
  readonly events: EventEnvelope<string, JsonValue>[] = [];
  private readonly waiters = new Set<{
    predicate(event: EventEnvelope<string, JsonValue>): boolean;
    resolve(event: EventEnvelope<string, JsonValue>): void;
  }>();

  publish(event: EventEnvelope<string, JsonValue>): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
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
          resolveWait(event);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timeout waiting for persisted event"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

/** Gate A 的两件测试工具：一件返回图片，一件挂起数秒再回包（模拟等用户确认）。 */
const GATE_TOOLS = [
  {
    name: "suduo_gate_color",
    description:
      "返回一张纯色方块图片。返回字符串：第一行是说明，随后一行是 data:image/png 地址。在 exec 里这样查看：" +
      'const r = String(await tools.suduo_gate_color({})); const [head, ...rest] = r.split("\\n"); text(head); for (const u of rest) if (u.startsWith("data:image/")) image(u); ' +
      "不要用 text() 输出 data:image 地址。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "suduo_gate_confirm",
    description:
      "提交一次确认，调用后会停住几秒等待结果。等待期间不要输出进度消息，在 exec 里把等待时间设到最大，拿到结果再回复。返回字符串，含确认码。",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    },
  },
];

const gateToolCalls: RuntimeToolCallRequest[] = [];
let toolHandler:
  | ((request: RuntimeToolCallRequest) => Promise<{ success: boolean; contentItems: RuntimeToolOutputItem[] }>)
  | null = null;

const serverRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(serverRoot, "..");
const artifactRoot = resolve(workspaceRoot, "artifacts", "gate-a");
const projectRoot = resolve(artifactRoot, "project");
const databasePath = resolve(artifactRoot, "gate-a.sqlite");
const resultPath = resolve(artifactRoot, "result.json");
const codexBin = resolve(
  workspaceRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "codex.cmd" : "codex",
);

rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(projectRoot, { recursive: true });
writeFileSync(
  resolve(projectRoot, "README.md"),
  "# Gate A fixture\n\nCodex runtime integration fixture.\n",
);

const codexVersion = spawnSync(codexBin, ["--version"], {
  encoding: "utf8",
}).stdout.trim();
if (codexVersion !== `codex-cli ${CODEX_VERSION}`) {
  throw new Error(`Gate A requires codex-cli ${CODEX_VERSION}, received ` + codexVersion);
}

const database = openBetterSqlite3Database(databasePath);
runMigrations(database);
const projects = new ProjectRepository(database);
const sessions = new SessionRepository(database);
const threads = new SessionThreadRepository(database);
const events = new EventRepository(database);
const approvals = new ApprovalRepository(database);
const idempotency = new IdempotencyRepository(database);
void idempotency;
const collector = new EventCollector();
const ledger = new EventLedger(database, events, approvals, collector);
const ingestor = new RuntimeEventIngestor(threads, ledger);

const project = projects.create({
  name: "Gate A",
  rootPath: projectRoot,
  rootPathKey: projectRoot,
});
const session = sessions.create({
  projectId: project.id,
  title: "Gate A",
});

let firstRuntime: CodexRuntime | null = null;
let secondRuntime: CodexRuntime | null = null;
let firstConsumerAbort: AbortController | null = null;
let secondConsumerAbort: AbortController | null = null;

try {
  firstRuntime = createRuntime();
  firstConsumerAbort = new AbortController();
  const firstConsumer = consumeRuntime(
    firstRuntime,
    ingestor,
    firstConsumerAbort.signal,
  );

  const started = await firstRuntime.startThread({
    mode: "create",
    sessionId: session.id,
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  const binding = threads.attach({
    sessionId: session.id,
    threadRef: started.primaryThread.threadRef,
    metadata: started.primaryThread.metadata,
  });
  if (!sessions.updateState(session.id, session.version, "active")) {
    throw new Error("failed to activate Gate A session");
  }

  const streamTurn = await firstRuntime.startTurn({
    sessionId: session.id,
    threadRef: binding.threadRef,
    clientTurnId: "gate-stream",
    input: [{ type: "text", text: "请只回复一句：gate stream ok。" }],
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  await collector.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === streamTurn.turnRef.turnId,
    180_000,
  );
  const deltaCount = collector.events.filter(
    (event) =>
      event.type === "message.delta" &&
      event.turnRef?.turnId === streamTurn.turnRef.turnId,
  ).length;
  if (deltaCount === 0) {
    throw new Error("stream turn produced no normalized message.delta");
  }

  const acceptFile = resolve(projectRoot, "APPROVAL_ACCEPT.txt");
  const acceptTurn = await firstRuntime.startTurn({
    sessionId: session.id,
    threadRef: binding.threadRef,
    clientTurnId: "gate-approval-accept",
    input: [
      {
        type: "text",
        text: "必须实际执行 shell 命令：printf approved > APPROVAL_ACCEPT.txt。执行后只回复 done。",
      },
    ],
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  const acceptedApproval = await decideNextApproval({
    runtime: firstRuntime,
    collector,
    approvals,
    ledger,
    threadRef: binding.threadRef,
    turnId: acceptTurn.turnRef.turnId,
    decision: "accept",
  });
  await collector.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === acceptTurn.turnRef.turnId,
    180_000,
  );
  if (!existsSync(acceptFile)) {
    throw new Error("accepted command did not create APPROVAL_ACCEPT.txt");
  }

  const declineFile = resolve(projectRoot, "APPROVAL_DECLINE.txt");
  const declineTurn = await firstRuntime.startTurn({
    sessionId: session.id,
    threadRef: binding.threadRef,
    clientTurnId: "gate-approval-decline",
    input: [
      {
        type: "text",
        text: "必须实际执行 shell 命令：printf declined > APPROVAL_DECLINE.txt。执行后只回复 done。",
      },
    ],
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  const declinedApproval = await decideNextApproval({
    runtime: firstRuntime,
    collector,
    approvals,
    ledger,
    threadRef: binding.threadRef,
    turnId: declineTurn.turnRef.turnId,
    decision: "decline",
  });
  await collector.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === declineTurn.turnRef.turnId,
    180_000,
  );
  if (existsSync(declineFile)) {
    throw new Error("declined command created APPROVAL_DECLINE.txt");
  }

  const interruptTurn = await firstRuntime.startTurn({
    sessionId: session.id,
    threadRef: binding.threadRef,
    clientTurnId: "gate-interrupt",
    input: [
      {
        type: "text",
        text: "请从 1 数到 10000，每行一个数字，不要省略。",
      },
    ],
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  await collector.waitFor(
    (event) =>
      event.type === "turn.started" &&
      event.turnRef?.turnId === interruptTurn.turnRef.turnId,
    60_000,
  );
  await delay(300);
  await firstRuntime.interrupt({
    sessionId: session.id,
    threadRef: binding.threadRef,
    turnId: interruptTurn.turnRef.turnId,
  });
  const interruptedEvent = await collector.waitFor(
    (event) =>
      (event.type === "turn.interrupted" ||
        event.type === "turn.completed") &&
      event.turnRef?.turnId === interruptTurn.turnRef.turnId,
    60_000,
  );

  const killedPid = firstRuntime.processId;
  if (!killedPid) {
    throw new Error("stdio Codex process pid is unavailable");
  }
  firstRuntime.killProcessForTest();
  await withTimeout(firstConsumer, 20_000, "first runtime consumer exit");
  await firstRuntime.close();
  firstRuntime = null;
  firstConsumerAbort.abort();

  secondRuntime = createRuntime();
  secondRuntime.restoreThreadBinding(binding.threadRef, session.id);
  secondConsumerAbort = new AbortController();
  const secondConsumer = consumeRuntime(
    secondRuntime,
    ingestor,
    secondConsumerAbort.signal,
  );
  const resumed = await secondRuntime.startThread({
    mode: "resume",
    sessionId: session.id,
    threadRef: binding.threadRef,
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  if (
    resumed.primaryThread.threadRef.threadId !== binding.threadRef.threadId
  ) {
    throw new Error("resumed thread id changed");
  }
  const resumedPid = secondRuntime.processId;
  if (!resumedPid || resumedPid === killedPid) {
    throw new Error("resume did not create a new app-server process");
  }

  const resumeTurn = await secondRuntime.startTurn({
    sessionId: session.id,
    threadRef: binding.threadRef,
    clientTurnId: "gate-resume",
    input: [{ type: "text", text: "请只回复一句：resume gate ok。" }],
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  await collector.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === resumeTurn.turnRef.turnId,
    180_000,
  );

  // 客户端自定义工具（ADR-0008）：挂工具、模型调用、图片交给模型看、挂起数秒后再回包。
  // 升级 Codex 时这一步验证实验性 dynamicTools 仍然可用。
  const toolSession = sessions.create({ projectId: project.id, title: "Gate A tools" });
  const toolThread = await secondRuntime.startThread({
    mode: "create",
    sessionId: toolSession.id,
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
    dynamicTools: GATE_TOOLS,
  });
  threads.attach({
    sessionId: toolSession.id,
    threadRef: toolThread.primaryThread.threadRef,
    metadata: toolThread.primaryThread.metadata,
  });
  if (!sessions.updateState(toolSession.id, toolSession.version, "active")) {
    throw new Error("failed to activate Gate A tool session");
  }
  toolHandler = async (request) => {
    if (request.tool === "suduo_gate_color") {
      return {
        success: true,
        contentItems: [
          { type: "inputText", text: "一张纯色方块图片" },
          { type: "inputImage", imageUrl: "data:image/png;base64," + solidPng(220, 20, 20) },
        ],
      };
    }
    if (request.tool === "suduo_gate_confirm") {
      await delay(8_000);
      return { success: true, contentItems: [{ type: "inputText", text: "已确认，确认码 gate-confirm-ok" }] };
    }
    return { success: false, contentItems: [{ type: "inputText", text: "未知工具" }] };
  };
  const toolTurn = await secondRuntime.startTurn({
    sessionId: toolSession.id,
    threadRef: toolThread.primaryThread.threadRef,
    clientTurnId: "gate-tools",
    input: [
      {
        type: "text",
        text:
          "先调用 suduo_gate_color 看那张图片，再调用 suduo_gate_confirm，参数 body 为 ping。" +
          "最后只回复两行：第一行是图片的颜色（一个汉字），第二行是 suduo_gate_confirm 返回的确认码。",
      },
    ],
    projectRoot,
    workspaceRoots: [projectRoot],
    approvalMode: "ask",
  });
  await collector.waitFor(
    (event) =>
      event.type === "turn.completed" &&
      event.turnRef?.turnId === toolTurn.turnRef.turnId,
    300_000,
  );
  const toolThreadId = toolThread.primaryThread.threadRef.threadId;
  const colorCalls = gateToolCalls.filter((call) => call.tool === "suduo_gate_color").length;
  const confirmCalls = gateToolCalls.filter((call) => call.tool === "suduo_gate_confirm").length;
  if (colorCalls < 1 || confirmCalls !== 1) {
    throw new Error(`dynamic tool calls unexpected: color=${colorCalls} confirm=${confirmCalls}`);
  }
  const toolAnswer = collector.events
    .filter(
      (event) =>
        event.type === "item.completed" &&
        event.turnRef?.turnId === toolTurn.turnRef.turnId,
    )
    .map((event) => codexItem(event))
    .filter((item) => item["type"] === "agentMessage")
    .map((item) => String(item["text"] ?? ""))
    .join("\n");
  if (!toolAnswer.includes("红") || !toolAnswer.includes("gate-confirm-ok")) {
    throw new Error("dynamic tool answer missing image color or confirm code: " + toolAnswer);
  }
  const storedToolItems = events
    .listAfter(toolSession.id, 0, 10_000)
    .map((event) => codexItem(event))
    .filter((item) => item["type"] === "dynamicToolCall" && item["tool"] === "suduo_gate_color");
  if (JSON.stringify(storedToolItems).includes("data:image/png")) {
    throw new Error("dynamic tool image data URL leaked into the event ledger");
  }

  secondConsumerAbort.abort();
  await secondRuntime.close();
  secondRuntime = null;
  await withTimeout(secondConsumer, 20_000, "second runtime consumer exit");

  const stored = events.listAfter(session.id, 0, 10_000);
  if (stored.length === 0) {
    throw new Error("no normalized events were persisted");
  }
  const seqs = stored.map((event) => event.seq);
  if (new Set(seqs).size !== seqs.length) {
    throw new Error("duplicate event seq detected");
  }
  for (let index = 1; index < seqs.length; index += 1) {
    const previous = seqs[index - 1];
    const current = seqs[index];
    if (previous === undefined || current === undefined) {
      throw new Error("missing event seq");
    }
    if (current !== previous + 1) {
      throw new Error(
        "non-contiguous event seq: " +
          String(previous) +
          " -> " +
          String(current),
      );
    }
  }
  if (stored.some((event) => event.type.includes("/"))) {
    throw new Error("native Codex method leaked into event type");
  }
  const middle = stored[Math.floor(stored.length / 2)];
  if (!middle) {
    throw new Error("missing middle event");
  }
  const replayed = events.listAfter(session.id, middle.seq, 10_000);
  const expectedReplay = stored.filter((event) => event.seq > middle.seq);
  if (
    replayed.map((event) => event.seq).join(",") !==
    expectedReplay.map((event) => event.seq).join(",")
  ) {
    throw new Error("after=seq replay mismatch");
  }

  const result = {
    status: "PASS",
    codexVersion,
    databasePath,
    projectRoot,
    sessionId: session.id,
    threadId: binding.threadRef.threadId,
    turns: {
      stream: streamTurn.turnRef.turnId,
      accept: acceptTurn.turnRef.turnId,
      decline: declineTurn.turnRef.turnId,
      interrupt: interruptTurn.turnRef.turnId,
      resume: resumeTurn.turnRef.turnId,
    },
    approvals: {
      accepted: acceptedApproval.id,
      declined: declinedApproval.id,
    },
    interruptEventType: interruptedEvent.type,
    dynamicTools: {
      threadId: toolThreadId,
      colorCalls,
      confirmCalls,
      answer: toolAnswer,
    },
    processes: {
      killedPid,
      resumedPid,
    },
    events: {
      count: stored.length,
      firstSeq: seqs[0],
      lastSeq: seqs.at(-1),
      replayAfter: middle.seq,
      replayCount: replayed.length,
      types: [...new Set(stored.map((event) => event.type))].sort(),
    },
    files: {
      acceptExists: existsSync(acceptFile),
      declineExists: existsSync(declineFile),
    },
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  firstConsumerAbort?.abort();
  secondConsumerAbort?.abort();
  if (firstRuntime) {
    await firstRuntime.close().catch(() => undefined);
  }
  if (secondRuntime) {
    await secondRuntime.close().catch(() => undefined);
  }
  database.close();
}

function createRuntime(): CodexRuntime {
  return new CodexRuntime({
    transport: new StdioCodexTransport({
      onStderr: (text) => {
        if (/panic|fatal/iu.test(text)) {
          process.stderr.write(text);
        }
      },
    }),
    codexBin,
  });
}

async function consumeRuntime(
  runtime: CodexRuntime,
  eventIngestor: RuntimeEventIngestor,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of runtime.subscribe({ signal })) {
    if (event.type === "tool.call-requested") {
      const request = event.payload as unknown as RuntimeToolCallRequest;
      gateToolCalls.push(request);
      // 不在订阅循环里等工具（与产品实现一致），回包异步进行。
      void (async () => {
        const result = toolHandler
          ? await toolHandler(request)
          : { success: false, contentItems: [{ type: "inputText" as const, text: "没有工具处理器" }] };
        await runtime.respondToolCall({ callRef: request.callRef, ...result });
      })();
      continue;
    }
    if (event.type === "tool.call-cancelled") {
      continue;
    }
    eventIngestor.ingest(event);
  }
}

function codexItem(event: EventEnvelope<string, JsonValue>): Record<string, JsonValue> {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  const item = payload["item"];
  return item !== null && typeof item === "object" && !Array.isArray(item) ? item : {};
}

/** 生成一张 size×size 的纯色 PNG（base64），不依赖图片库。 */
function solidPng(red: number, green: number, blue: number, size = 32): string {
  const row = Buffer.alloc(size * 3 + 1);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 位深
  header[9] = 2; // 真彩色
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

async function decideNextApproval(input: {
  runtime: CodexRuntime;
  collector: EventCollector;
  approvals: ApprovalRepository;
  ledger: EventLedger;
  threadRef: {
    runtimeId: string;
    runtimeKind: string;
    threadId: string;
  };
  turnId: string;
  decision: ApprovalDecision;
}) {
  const requested = await input.collector.waitFor(
    (event) =>
      event.type === "approval.requested" &&
      event.turnRef?.turnId === input.turnId,
    180_000,
  );
  const payload = requireObject(requested.payload, "approval event payload");
  const approvalId = requireString(payload["approvalId"], "approvalId");
  const pending = requireValue(input.approvals.getById(approvalId));
  if (
    !input.approvals.markDeciding(
      pending.id,
      pending.version,
      input.decision,
    )
  ) {
    throw new Error("approval compare-and-set failed: " + pending.id);
  }
  const deciding = requireValue(input.approvals.getById(pending.id));
  await input.runtime.approve({
    sessionId: deciding.sessionId,
    threadRef: input.threadRef,
    approvalRef: deciding.runtimeApprovalRef,
    decision: input.decision,
  });
  input.ledger.resolveApproval({
    approval: deciding,
    decision: input.decision,
    decisionPayload: { decision: input.decision },
    decidedBy: "gate-a",
    event: {
      source: "suduo",
      type: "approval.resolved",
      payload: { decision: input.decision },
      threadRef: input.threadRef,
      turnRef: {
        threadId: input.threadRef.threadId,
        turnId: input.turnId,
      },
      ts: Date.now(),
      dedupeKey:
        "approval:" + deciding.id + ":" + String(input.decision),
    },
  });
  return requireValue(input.approvals.getById(deciding.id));
}

function requireObject(
  value: JsonValue,
  label: string,
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid " + label);
  }
  return value;
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new Error("invalid " + label);
  }
  return value;
}

function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected persisted value");
  }
  return value;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timeout waiting for " + label)), timeoutMs);
    }),
  ]);
}
