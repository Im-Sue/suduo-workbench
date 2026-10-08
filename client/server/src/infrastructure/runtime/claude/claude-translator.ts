import path from "node:path";
import { SUDUO_MCP_SERVER_NAME, type JsonValue } from "@suduo/client-contracts";
import { slimToolContentItems, suDuoInternalToolName } from "../suduo-tool-item.js";
import { snippetDiff } from "../snippet-diff.js";

/** 翻译出的一条事件：类型与载荷；线程、回合与会话由运行时补上。 */
export interface TranslatedEvent {
  type: string;
  payload: JsonValue;
}

/** 回合结局（与 Codex `turn.status` 同名）。 */
export type ClaudeTurnStatus = "completed" | "failed" | "interrupted";

/** 账本里命令输出的上限；完整输出模型已经拿到，账本只留可读部分。 */
const OUTPUT_LIMIT = 64_000;
const OUTPUT_CLIPPED = "\n…";

/** Claude 自己的机制性步骤，不在时间线上单独显示（ToolSearch：按需加载 MCP 工具的说明）。 */
const HIDDEN_TOOLS = new Set(["ToolSearch"]);

/** 不认识的 Claude 内置工具在时间线上显示成「调用 Claude Code · 工具名」。 */
const CLAUDE_TOOL_SERVER = "Claude Code";

interface OpenBlock {
  itemId: string;
  kind: "text" | "thinking";
  text: string;
}

interface OpenTool {
  id: string;
  name: string;
  input: Record<string, JsonValue>;
  startedAt: number;
}

interface ToolOutcome {
  text: string;
  /** SuDuo 工具与其他 MCP 工具的原始内容块（文字与图片）。 */
  content: JsonValue[];
  isError: boolean;
}

/**
 * Claude Agent SDK 的消息 → SuDuo 的事件与条目（技术设计 2.2、4.2）。条目字段与 Codex `ThreadItem` 同名同形，
 * 界面不分 Agent；SuDuo 工具调用落成 `dynamicToolCall`。一个会话一个翻译器（跨回合累计用量）。
 * 子 Agent（Task）内部的消息不展开，只显示那一步。
 */
export class ClaudeTurnTranslator {
  private turnId: string | null = null;
  private interruptRequested = false;
  private messageId: string | null = null;
  private readonly blocks = new Map<number, OpenBlock>();
  private readonly streamedMessages = new Set<string>();
  private readonly tools = new Map<string, OpenTool>();
  private readonly declinedTools = new Set<string>();
  private lastCallTokens = { input: 0, cached: 0, output: 0 };
  private readonly totals = { input: 0, cached: 0, output: 0 };
  private contextWindow: number | null = null;
  /** 最近一次回合里 Claude 报了登录失效（运行时据此把这家 Agent 标成需要登录）。 */
  authFailed = false;
  /** init 消息里的模型。 */
  model: string | null = null;

  constructor(
    private readonly context: { threadId: string; cwd: string; now?: () => number },
  ) {}

  get activeTurnId(): string | null {
    return this.turnId;
  }

  beginTurn(turnId: string): TranslatedEvent[] {
    this.turnId = turnId;
    this.interruptRequested = false;
    this.authFailed = false;
    return [{ type: "turn.started", payload: { threadId: this.context.threadId, turn: { id: turnId, status: "inProgress" } } }];
  }

  markInterruptRequested(): void {
    this.interruptRequested = true;
  }

  /** 用户在审批卡上拒绝了这次工具调用：结果回来时记为 declined（而不是失败）。 */
  markDeclined(toolUseId: string): void {
    this.declinedTools.add(toolUseId);
  }

  translate(message: unknown): TranslatedEvent[] {
    const m = asObject(message as JsonValue);
    switch (m["type"]) {
      case "stream_event":
        return isSubagent(m) ? [] : this.streamEvent(asObject(m["event"]));
      case "assistant":
        return isSubagent(m) ? [] : this.assistant(m);
      case "user":
        return isSubagent(m) ? [] : this.user(m);
      case "result":
        return this.result(m);
      case "system":
        return this.system(m);
      default:
        return [];
    }
  }

  /**
   * 进程断开或查询出错、没有 result 时收口：未完成的文字补完，回合记为中断（发过中断时）或失败。
   */
  abortTurn(message: string): TranslatedEvent[] {
    if (this.turnId === null) return [];
    const events = this.closeBlocks();
    this.tools.clear();
    events.push(this.turnCompleted(this.interruptRequested ? "interrupted" : "failed", this.interruptRequested ? null : message));
    return events;
  }

  private streamEvent(event: Record<string, JsonValue>): TranslatedEvent[] {
    switch (event["type"]) {
      case "message_start": {
        const message = asObject(event["message"]);
        this.messageId = typeof message["id"] === "string" ? message["id"] : null;
        this.blocks.clear();
        return [];
      }
      case "content_block_start": {
        const index = numberOr(event["index"], -1);
        const block = asObject(event["content_block"]);
        if (this.messageId === null || index < 0) return [];
        const itemId = `${this.messageId}:${String(index)}`;
        if (block["type"] === "text") {
          this.streamedMessages.add(this.messageId);
          this.blocks.set(index, { itemId, kind: "text", text: "" });
          return [this.item("item.started", { type: "agentMessage", id: itemId, text: "" })];
        }
        if (block["type"] === "thinking") {
          this.streamedMessages.add(this.messageId);
          this.blocks.set(index, { itemId, kind: "thinking", text: "" });
          return [this.item("item.started", { type: "reasoning", id: itemId, summary: [], content: [] })];
        }
        return [];
      }
      case "content_block_delta": {
        const open = this.blocks.get(numberOr(event["index"], -1));
        const delta = asObject(event["delta"]);
        if (open === undefined) return [];
        if (open.kind === "text" && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          open.text += delta["text"];
          return [{ type: "message.delta", payload: { text: delta["text"], itemId: open.itemId } }];
        }
        if (open.kind === "thinking" && delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
          open.text += delta["thinking"];
          return [{ type: "reasoning.summary-delta", payload: { itemId: open.itemId, delta: delta["thinking"], summaryIndex: 0 } }];
        }
        return [];
      }
      case "content_block_stop": {
        const index = numberOr(event["index"], -1);
        const open = this.blocks.get(index);
        if (open === undefined) return [];
        this.blocks.delete(index);
        return [this.completeBlock(open)];
      }
      default:
        return [];
    }
  }

  private assistant(m: Record<string, JsonValue>): TranslatedEvent[] {
    const message = asObject(m["message"]);
    const messageId = typeof message["id"] === "string" ? message["id"] : null;
    const usage = asObject(message["usage"]);
    if (Object.keys(usage).length > 0) {
      this.lastCallTokens = {
        input: numberOr(usage["input_tokens"], 0),
        cached: numberOr(usage["cache_read_input_tokens"], 0) + numberOr(usage["cache_creation_input_tokens"], 0),
        output: numberOr(usage["output_tokens"], 0),
      };
    }
    const events: TranslatedEvent[] = [];
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    if (typeof m["error"] === "string") {
      // 登录失效、额度、限流等：Claude 把说明写在这条消息的文字里。
      if (m["error"] === "authentication_failed") this.authFailed = true;
      const text = content.map((block) => stringOr(asObject(block)["text"], "")).join("\n").trim();
      events.push({ type: "runtime.error", payload: { message: text === "" ? m["error"] : text, code: m["error"] } });
      return events;
    }
    const streamed = messageId !== null && this.streamedMessages.has(messageId);
    content.forEach((raw, index) => {
      const block = asObject(raw);
      // 没收到流式增量的文字与思考（个别消息、或流式没开）：整段补出来。
      if (!streamed && block["type"] === "text" && typeof block["text"] === "string" && block["text"] !== "") {
        const id = `${messageId ?? "message"}:${String(index)}`;
        events.push(this.item("item.started", { type: "agentMessage", id, text: "" }));
        events.push(this.item("item.completed", { type: "agentMessage", id, text: block["text"] }));
      }
      if (!streamed && block["type"] === "thinking" && typeof block["thinking"] === "string") {
        const id = `${messageId ?? "message"}:${String(index)}`;
        events.push(this.item("item.completed", { type: "reasoning", id, summary: block["thinking"] === "" ? [] : [block["thinking"]], content: [] }));
      }
      if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string" && !this.tools.has(block["id"])) {
        const tool: OpenTool = { id: block["id"], name: block["name"], input: asObject(block["input"]), startedAt: this.now() };
        this.tools.set(tool.id, tool);
        events.push(...this.toolStarted(tool));
      }
    });
    return events;
  }

  private user(m: Record<string, JsonValue>): TranslatedEvent[] {
    const content = asObject(m["message"])["content"];
    if (!Array.isArray(content)) return [];
    const events: TranslatedEvent[] = [];
    for (const raw of content) {
      const block = asObject(raw);
      if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
      const tool = this.tools.get(block["tool_use_id"]);
      if (tool === undefined) continue;
      this.tools.delete(tool.id);
      const outcome = toolOutcome(block);
      const item = this.toolItem(tool, outcome);
      if (item !== null) events.push(this.item("item.completed", item));
    }
    return events;
  }

  private result(m: Record<string, JsonValue>): TranslatedEvent[] {
    if (this.turnId === null) return [];
    const events = this.closeBlocks();
    this.tools.clear();
    const usage = asObject(m["usage"]);
    const input = numberOr(usage["input_tokens"], 0);
    const cached = numberOr(usage["cache_read_input_tokens"], 0) + numberOr(usage["cache_creation_input_tokens"], 0);
    const output = numberOr(usage["output_tokens"], 0);
    this.totals.input += input;
    this.totals.cached += cached;
    this.totals.output += output;
    for (const raw of Object.values(asObject(m["modelUsage"]))) {
      const window = asObject(raw)["contextWindow"];
      if (typeof window === "number" && window > 0) this.contextWindow = window;
    }
    events.push({
      type: "usage.updated",
      payload: {
        threadId: this.context.threadId,
        turnId: this.turnId,
        tokenUsage: {
          total: tokenBreakdown(this.totals),
          last: tokenBreakdown(this.lastCallTokens),
          modelContextWindow: this.contextWindow,
        },
      },
    });
    const subtype = m["subtype"];
    if (subtype === "success" && m["is_error"] !== true) {
      events.push(this.turnCompleted("completed", null));
    } else if (subtype === "error_during_execution" && this.interruptRequested) {
      // S0：发过中断后本回合以 error_during_execution 结束。
      events.push(this.turnCompleted("interrupted", null));
    } else {
      const errors = Array.isArray(m["errors"]) ? m["errors"].filter((error): error is string => typeof error === "string") : [];
      const message = typeof m["result"] === "string" && m["result"] !== "" ? m["result"] : errors.join("\n") || String(subtype ?? "error");
      events.push(this.turnCompleted("failed", message));
    }
    return events;
  }

  private system(m: Record<string, JsonValue>): TranslatedEvent[] {
    if (m["subtype"] === "init") {
      this.model = typeof m["model"] === "string" ? m["model"] : this.model;
      const servers = Array.isArray(m["mcp_servers"]) ? m["mcp_servers"].map(asObject) : [];
      const suDuo = servers.find((server) => server["name"] === SUDUO_MCP_SERVER_NAME);
      if (suDuo !== undefined && suDuo["status"] !== "connected") {
        // SuDuo 工具服务没连上：模型用不了需求工具，说一声（原因写英文，只给诊断）。
        return [{ type: "runtime.warning", payload: { message: `SuDuo tools unavailable (MCP status: ${String(suDuo["status"])})`, code: "suduo-tools-unavailable" } }];
      }
      return [];
    }
    if (m["subtype"] === "compact_boundary" && this.turnId !== null) {
      const id = typeof m["uuid"] === "string" ? m["uuid"] : `compact:${String(this.now())}`;
      return [this.item("item.completed", { type: "contextCompaction", id })];
    }
    return [];
  }

  private toolStarted(tool: OpenTool): TranslatedEvent[] {
    if (HIDDEN_TOOLS.has(tool.name)) {
      return [];
    }
    if (tool.name === "TodoWrite") {
      // 待办清单就是计划：更新计划面板，不单独成一步。
      return [{ type: "plan.updated", payload: { threadId: this.context.threadId, turnId: this.turnId, explanation: null, plan: todoPlan(tool.input) } }];
    }
    const item = this.toolItem(tool, null);
    return item === null ? [] : [this.item("item.started", item)];
  }

  /** 工具调用 → 条目；outcome 为 null 表示还在进行。TodoWrite 不成条目。 */
  private toolItem(tool: OpenTool, outcome: ToolOutcome | null): Record<string, JsonValue> | null {
    const input = tool.input;
    const declined = this.declinedTools.has(tool.id);
    const status = outcome === null ? "inProgress" : declined ? "declined" : outcome.isError ? "failed" : "completed";
    const durationMs = outcome === null ? null : Math.max(0, this.now() - tool.startedAt);
    if (tool.name.startsWith("mcp__")) {
      const [, server = "", ...rest] = tool.name.split("__");
      const name = rest.join("__");
      if (server === SUDUO_MCP_SERVER_NAME) {
        return {
          type: "dynamicToolCall",
          id: tool.id,
          namespace: null,
          tool: suDuoInternalToolName(name),
          arguments: input,
          status: outcome === null ? "inProgress" : outcome.isError ? "failed" : "completed",
          contentItems: outcome === null ? null : slimToolContentItems(outcome.content),
          success: outcome === null ? null : !outcome.isError,
          durationMs,
        };
      }
      return mcpItem(tool, server, name, status, outcome, durationMs);
    }
    const filePath = stringOr(input["file_path"], stringOr(input["notebook_path"], stringOr(input["path"], "")));
    switch (tool.name) {
      case "Bash":
        return {
          type: "commandExecution",
          id: tool.id,
          command: stringOr(input["command"], ""),
          cwd: this.context.cwd,
          status,
          aggregatedOutput: outcome === null ? null : clip(outcome.text),
          exitCode: outcome === null ? null : outcome.isError ? 1 : 0,
          durationMs,
          commandActions: [],
        };
      case "Read":
        return this.lookup(tool, status, durationMs, outcome, { type: "read", command: filePath, name: path.basename(filePath), path: filePath }, false);
      case "Grep":
      case "Glob": {
        const pattern = stringOr(input["pattern"], "");
        const where = stringOr(input["path"], "");
        return this.lookup(tool, status, durationMs, outcome, { type: "search", command: `${tool.name} ${pattern}`, query: pattern, path: where === "" ? null : where }, true);
      }
      case "LS":
        return this.lookup(tool, status, durationMs, outcome, { type: "listFiles", command: `ls ${filePath}`, path: filePath }, true);
      case "Edit":
        return this.fileChange(tool, status, [
          { path: filePath, kind: "update", diff: snippetDiff(this.relative(filePath), stringOr(input["old_string"], ""), stringOr(input["new_string"], "")) },
        ]);
      case "MultiEdit": {
        const edits = Array.isArray(input["edits"]) ? input["edits"].map(asObject) : [];
        const diff = edits.map((edit) => snippetDiff(this.relative(filePath), stringOr(edit["old_string"], ""), stringOr(edit["new_string"], ""))).join("");
        return this.fileChange(tool, status, [{ path: filePath, kind: "update", diff }]);
      }
      case "Write":
        return this.fileChange(tool, status, [{ path: filePath, kind: "add", diff: stringOr(input["content"], "") }]);
      case "NotebookEdit":
        return this.fileChange(tool, status, [{ path: filePath, kind: "update", diff: "" }]);
      case "WebSearch":
        return { type: "webSearch", id: tool.id, query: stringOr(input["query"], "") };
      case "WebFetch":
        return { type: "webSearch", id: tool.id, query: stringOr(input["url"], "") };
      case "Task":
      case "Agent":
        return { type: "collabAgentToolCall", id: tool.id, tool: "spawnAgent", status, prompt: stringOr(input["description"], stringOr(input["prompt"], "")) };
      case "ExitPlanMode":
        return { type: "plan", id: tool.id, text: stringOr(input["plan"], "") };
      case "TodoWrite":
        return null;
      case "ToolSearch":
        return null;
      default:
        return mcpItem(tool, CLAUDE_TOOL_SERVER, tool.name, status, outcome, durationMs);
    }
  }

  /** 查看 / 搜索 / 列目录：按 Codex 的命令解析形状给出，时间线据此起标题。 */
  private lookup(
    tool: OpenTool,
    status: string,
    durationMs: number | null,
    outcome: ToolOutcome | null,
    action: Record<string, JsonValue>,
    keepOutput: boolean,
  ): Record<string, JsonValue> {
    return {
      type: "commandExecution",
      id: tool.id,
      command: stringOr(action["command"], tool.name),
      cwd: this.context.cwd,
      status,
      // 读文件的全文不进账本（模型已拿到）；搜索与列目录的结果留可读部分。
      aggregatedOutput: outcome === null || !keepOutput ? null : clip(outcome.text),
      exitCode: outcome === null ? null : outcome.isError ? 1 : 0,
      durationMs,
      commandActions: [action],
    };
  }

  private fileChange(tool: OpenTool, status: string, changes: Array<{ path: string; kind: "add" | "update"; diff: string }>): Record<string, JsonValue> {
    return {
      type: "fileChange",
      id: tool.id,
      status,
      changes: changes.map((change) => ({ path: change.path, kind: { type: change.kind, move_path: null }, diff: change.diff })),
    };
  }

  private relative(filePath: string): string {
    const relative = path.relative(this.context.cwd, filePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
  }

  private closeBlocks(): TranslatedEvent[] {
    const events = [...this.blocks.values()].map((block) => this.completeBlock(block));
    this.blocks.clear();
    return events;
  }

  private completeBlock(block: OpenBlock): TranslatedEvent {
    return block.kind === "text"
      ? this.item("item.completed", { type: "agentMessage", id: block.itemId, text: block.text })
      : this.item("item.completed", { type: "reasoning", id: block.itemId, summary: block.text === "" ? [] : [block.text], content: [] });
  }

  private turnCompleted(status: ClaudeTurnStatus, message: string | null): TranslatedEvent {
    const turnId = this.turnId;
    this.turnId = null;
    this.declinedTools.clear();
    return {
      // 与 Codex 的归一化一致：中断的回合是 turn.interrupted（队列据此暂停、时间线标「已停止」）。
      type: status === "interrupted" ? "turn.interrupted" : "turn.completed",
      payload: { threadId: this.context.threadId, turn: { id: turnId, status, error: message === null ? null : { message } } },
    };
  }

  private item(type: "item.started" | "item.completed", item: Record<string, JsonValue>): TranslatedEvent {
    return { type, payload: { threadId: this.context.threadId, turnId: this.turnId, item } };
  }

  private now(): number {
    return this.context.now?.() ?? Date.now();
  }
}

function mcpItem(tool: OpenTool, server: string, name: string, status: string, outcome: ToolOutcome | null, durationMs: number | null): Record<string, JsonValue> {
  return {
    type: "mcpToolCall",
    id: tool.id,
    server,
    tool: name,
    status: status === "declined" ? "failed" : status,
    arguments: tool.input,
    result: outcome === null || outcome.isError ? null : { content: outcome.content.length > 0 ? slimToolContentItems(outcome.content) : [{ type: "inputText", text: clip(outcome.text) }] },
    error: outcome !== null && outcome.isError ? { message: clip(outcome.text) } : null,
    durationMs,
  };
}

/** tool_result 的内容：文字拼起来；图片转成 inputImage（SuDuo 工具与 MCP 工具用）。 */
function toolOutcome(block: Record<string, JsonValue>): ToolOutcome {
  const raw = block["content"];
  const content: JsonValue[] = [];
  const texts: string[] = [];
  if (typeof raw === "string") {
    texts.push(raw);
    content.push({ type: "inputText", text: raw });
  } else if (Array.isArray(raw)) {
    for (const entry of raw.map(asObject)) {
      if (entry["type"] === "text" && typeof entry["text"] === "string") {
        texts.push(entry["text"]);
        content.push({ type: "inputText", text: entry["text"] });
      } else if (entry["type"] === "image") {
        const source = asObject(entry["source"]);
        if (typeof source["data"] === "string" && typeof source["media_type"] === "string") {
          content.push({ type: "inputImage", imageUrl: `data:${source["media_type"]};base64,${source["data"]}` });
        }
      }
    }
  }
  return { text: texts.join("\n"), content, isError: block["is_error"] === true };
}

/** TodoWrite 的待办 → 计划步骤（Codex 的 pending / inProgress / completed）。 */
function todoPlan(input: Record<string, JsonValue>): JsonValue[] {
  const todos = Array.isArray(input["todos"]) ? input["todos"].map(asObject) : [];
  return todos
    .filter((todo) => typeof todo["content"] === "string")
    .map((todo) => ({
      step: todo["content"] as string,
      status: todo["status"] === "completed" ? "completed" : todo["status"] === "in_progress" ? "inProgress" : "pending",
    }));
}

function tokenBreakdown(tokens: { input: number; cached: number; output: number }): JsonValue {
  return {
    totalTokens: tokens.input + tokens.cached + tokens.output,
    inputTokens: tokens.input + tokens.cached,
    cachedInputTokens: tokens.cached,
    outputTokens: tokens.output,
    reasoningOutputTokens: 0,
  };
}

function isSubagent(m: Record<string, JsonValue>): boolean {
  return typeof m["parent_tool_use_id"] === "string";
}

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) + OUTPUT_CLIPPED : text;
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOr(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
