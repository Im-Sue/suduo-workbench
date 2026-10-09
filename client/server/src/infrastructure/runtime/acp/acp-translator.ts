import path from "node:path";
import { SUDUO_MCP_SERVER_NAME, type JsonValue } from "@suduo/client-contracts";
import { snippetDiff } from "../snippet-diff.js";
import { mcpContentItem, slimToolContentItems, suDuoInternalToolName } from "../suduo-tool-item.js";

/** 翻译出的一条事件：类型与载荷；线程、回合与会话由运行时补上。 */
export interface TranslatedEvent {
  type: string;
  payload: JsonValue;
}

/** ACP `session/prompt` 的结束原因。 */
export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

const OUTPUT_LIMIT = 64_000;
const OUTPUT_CLIPPED = "\n…";

interface OpenText {
  itemId: string;
  kind: "text" | "thought";
  messageId: string | null;
  text: string;
}

interface OpenTool {
  id: string;
  kind: string;
  title: string;
  name: string | null;
  status: string;
  rawInput: JsonValue;
  rawOutput: JsonValue;
  content: JsonValue[];
  locations: string[];
  startedAt: number;
  /** 这一步已经发过 item.started（think、切换模式不显示）。 */
  shown: boolean;
}

/**
 * ACP `session/update` → SuDuo 的事件与条目（技术设计 2.2、4.2）。字段与 Codex `ThreadItem` 同名同形；
 * SuDuo 工具调用落成 `dynamicToolCall`。ACP 的文字块没有起止，按「换了种更新就算结束」切分条目。
 * 一个会话一个翻译器。
 */
export class AcpTurnTranslator {
  private turnId: string | null = null;
  private interruptRequested = false;
  private open: OpenText | null = null;
  private sequence = 0;
  private readonly tools = new Map<string, OpenTool>();
  private readonly declinedTools = new Set<string>();
  private usage: { used: number; size: number } | null = null;

  constructor(
    private readonly context: {
      threadId: string;
      cwd: string;
      /** 这家 Agent 的名字：不认识的工具显示成「调用 <名字> · 工具」。 */
      agentName: string;
      now?: () => number;
    },
  ) {}

  get activeTurnId(): string | null {
    return this.turnId;
  }

  beginTurn(turnId: string): TranslatedEvent[] {
    this.turnId = turnId;
    this.interruptRequested = false;
    return [{ type: "turn.started", payload: { threadId: this.context.threadId, turn: { id: turnId, status: "inProgress" } } }];
  }

  markInterruptRequested(): void {
    this.interruptRequested = true;
  }

  markDeclined(toolCallId: string): void {
    this.declinedTools.add(toolCallId);
  }

  /** 一条 `session/update` 的 update 字段。回合外（如续接时回放历史）的更新不翻译。 */
  translate(update: JsonValue): TranslatedEvent[] {
    if (this.turnId === null) return [];
    const u = asObject(update);
    switch (u["sessionUpdate"]) {
      case "agent_message_chunk":
        return this.chunk("text", u);
      case "agent_thought_chunk":
        return this.chunk("thought", u);
      case "tool_call":
        return [...this.closeText(), ...this.toolCall(u)];
      case "tool_call_update":
        return [...this.closeText(), ...this.toolCallUpdate(u)];
      case "plan":
        return [...this.closeText(), this.plan(u)];
      case "usage_update":
        this.usage = { used: numberOr(u["used"], 0), size: numberOr(u["size"], 0) };
        return [this.usageEvent()];
      case "notice": {
        const text = [stringOr(u["title"], ""), stringOr(u["description"], "")].filter((part) => part !== "").join("\n");
        return text === "" ? [] : [{ type: u["severity"] === "error" ? "runtime.error" : "runtime.warning", payload: { message: text } }];
      }
      default:
        return [];
    }
  }

  /** `session/prompt` 返回：未完成的文字补完，没收尾的工具记为失败，回合按结束原因收口。 */
  finishTurn(stopReason: string, usage: JsonValue = null): TranslatedEvent[] {
    if (this.turnId === null) return [];
    const events = this.closeText();
    for (const tool of this.tools.values()) {
      if (tool.shown) events.push(this.item("item.completed", this.toolItem(tool, "failed")));
    }
    this.tools.clear();
    const totals = asObject(usage);
    if (Object.keys(totals).length > 0 || this.usage !== null) {
      events.push(this.usageEvent(totals));
    }
    if (stopReason === "end_turn") {
      events.push(this.turnCompleted("completed", null));
    } else if (stopReason === "cancelled") {
      events.push(this.turnCompleted(this.interruptRequested ? "interrupted" : "failed", this.interruptRequested ? null : "cancelled by the agent"));
    } else {
      events.push(this.turnCompleted("failed", stopReason));
    }
    return events;
  }

  /** 进程断开或请求出错、没有结束原因时收口。 */
  abortTurn(message: string): TranslatedEvent[] {
    if (this.turnId === null) return [];
    const events = this.closeText();
    this.tools.clear();
    events.push(this.turnCompleted(this.interruptRequested ? "interrupted" : "failed", this.interruptRequested ? null : message));
    return events;
  }

  private chunk(kind: "text" | "thought", u: Record<string, JsonValue>): TranslatedEvent[] {
    const content = asObject(u["content"]);
    if (content["type"] !== "text" || typeof content["text"] !== "string") return [];
    const messageId = typeof u["messageId"] === "string" ? u["messageId"] : null;
    const events: TranslatedEvent[] = [];
    if (this.open !== null && (this.open.kind !== kind || (messageId !== null && this.open.messageId !== null && messageId !== this.open.messageId))) {
      events.push(...this.closeText());
    }
    if (this.open === null) {
      this.sequence += 1;
      const itemId = `${this.turnId ?? "turn"}:${kind}:${String(this.sequence)}`;
      this.open = { itemId, kind, messageId, text: "" };
      events.push(this.item("item.started", kind === "text" ? { type: "agentMessage", id: itemId, text: "" } : { type: "reasoning", id: itemId, summary: [], content: [] }));
    }
    const open = this.open;
    open.text += content["text"];
    events.push(
      kind === "text"
        ? { type: "message.delta", payload: { text: content["text"], itemId: open.itemId } }
        : { type: "reasoning.summary-delta", payload: { itemId: open.itemId, delta: content["text"], summaryIndex: 0 } },
    );
    return events;
  }

  private closeText(): TranslatedEvent[] {
    const open = this.open;
    if (open === null) return [];
    this.open = null;
    return [
      this.item(
        "item.completed",
        open.kind === "text"
          ? { type: "agentMessage", id: open.itemId, text: open.text }
          : { type: "reasoning", id: open.itemId, summary: open.text === "" ? [] : [open.text], content: [] },
      ),
    ];
  }

  private toolCall(u: Record<string, JsonValue>): TranslatedEvent[] {
    const id = stringOr(u["toolCallId"], "");
    if (id === "") return [];
    const tool: OpenTool = {
      id,
      kind: stringOr(u["kind"], "other"),
      title: stringOr(u["title"], ""),
      name: typeof u["name"] === "string" ? u["name"] : null,
      status: stringOr(u["status"], "pending"),
      rawInput: u["rawInput"] ?? null,
      rawOutput: u["rawOutput"] ?? null,
      content: Array.isArray(u["content"]) ? u["content"] : [],
      locations: locationsOf(u["locations"]),
      startedAt: this.now(),
      shown: false,
    };
    this.tools.set(id, tool);
    return this.progress(tool);
  }

  private toolCallUpdate(u: Record<string, JsonValue>): TranslatedEvent[] {
    const id = stringOr(u["toolCallId"], "");
    const tool = this.tools.get(id);
    if (tool === undefined) {
      // 没见过 tool_call 就来了更新（个别 Agent 只发更新）：当作新调用。
      return this.toolCall(u);
    }
    if (typeof u["kind"] === "string") tool.kind = u["kind"];
    if (typeof u["title"] === "string") tool.title = u["title"];
    if (typeof u["name"] === "string") tool.name = u["name"];
    if (typeof u["status"] === "string") tool.status = u["status"];
    if (u["rawInput"] !== undefined && u["rawInput"] !== null) tool.rawInput = u["rawInput"];
    if (u["rawOutput"] !== undefined && u["rawOutput"] !== null) tool.rawOutput = u["rawOutput"];
    if (Array.isArray(u["content"])) tool.content = u["content"];
    if (Array.isArray(u["locations"])) tool.locations = locationsOf(u["locations"]);
    return this.progress(tool);
  }

  /** 第一次能显示时发 item.started；完成或失败时发 item.completed 并收起。 */
  private progress(tool: OpenTool): TranslatedEvent[] {
    if (tool.kind === "think" || tool.kind === "switch_mode") {
      if (tool.status === "completed" || tool.status === "failed") this.tools.delete(tool.id);
      return [];
    }
    const events: TranslatedEvent[] = [];
    if (!tool.shown) {
      tool.shown = true;
      events.push(this.item("item.started", this.toolItem(tool, null)));
    }
    if (tool.status === "completed" || tool.status === "failed") {
      this.tools.delete(tool.id);
      events.push(this.item("item.completed", this.toolItem(tool, tool.status)));
    }
    return events;
  }

  private toolItem(tool: OpenTool, finished: "completed" | "failed" | null): Record<string, JsonValue> {
    const declined = this.declinedTools.has(tool.id);
    const status = finished === null ? "inProgress" : declined ? "declined" : finished;
    const durationMs = finished === null ? null : Math.max(0, this.now() - tool.startedAt);
    const input = asObject(tool.rawInput);
    const output = outputText(tool);
    const failed = finished === "failed";
    const suDuoTool = suDuoToolName(tool);
    if (suDuoTool !== null) {
      return {
        type: "dynamicToolCall",
        id: tool.id,
        namespace: null,
        tool: suDuoInternalToolName(suDuoTool),
        arguments: tool.rawInput,
        status: finished === null ? "inProgress" : failed ? "failed" : "completed",
        contentItems: finished === null ? null : slimToolContentItems(contentItems(tool)),
        success: finished === null ? null : !failed,
        durationMs,
      };
    }
    const where = tool.locations[0] ?? stringOr(input["path"], stringOr(input["file_path"], stringOr(input["filePath"], "")));
    switch (tool.kind) {
      case "execute":
        return {
          type: "commandExecution",
          id: tool.id,
          command: commandOf(tool),
          cwd: this.context.cwd,
          status,
          aggregatedOutput: finished === null ? null : clip(output),
          exitCode: finished === null ? null : failed ? 1 : 0,
          durationMs,
          commandActions: [],
        };
      case "read":
        return this.lookup(tool, status, durationMs, failed, finished, { type: "read", command: tool.title || where, name: path.basename(where || tool.title), path: where }, null);
      case "search":
        return this.lookup(tool, status, durationMs, failed, finished, { type: "search", command: tool.title, query: stringOr(input["pattern"], stringOr(input["query"], tool.title)), path: where === "" ? null : where }, output);
      case "edit":
      case "delete":
      case "move":
        return { type: "fileChange", id: tool.id, status, changes: fileChanges(tool, this.context.cwd) };
      case "fetch":
        return { type: "webSearch", id: tool.id, query: stringOr(input["url"], stringOr(input["query"], tool.title)) };
      default:
        return {
          type: "mcpToolCall",
          id: tool.id,
          server: this.context.agentName,
          tool: tool.name ?? tool.title,
          status: status === "declined" ? "failed" : status,
          arguments: tool.rawInput,
          result: finished === null || failed ? null : { content: [{ type: "inputText", text: clip(output) }] },
          error: failed ? { message: clip(output) } : null,
          durationMs,
        };
    }
  }

  private lookup(
    tool: OpenTool,
    status: string,
    durationMs: number | null,
    failed: boolean,
    finished: string | null,
    action: Record<string, JsonValue>,
    output: string | null,
  ): Record<string, JsonValue> {
    return {
      type: "commandExecution",
      id: tool.id,
      command: stringOr(action["command"], tool.title),
      cwd: this.context.cwd,
      status,
      aggregatedOutput: finished === null || output === null ? null : clip(output),
      exitCode: finished === null ? null : failed ? 1 : 0,
      durationMs,
      commandActions: [action],
    };
  }

  private plan(u: Record<string, JsonValue>): TranslatedEvent {
    const entries = Array.isArray(u["entries"]) ? u["entries"].map(asObject) : [];
    return {
      type: "plan.updated",
      payload: {
        threadId: this.context.threadId,
        turnId: this.turnId,
        explanation: null,
        plan: entries
          .filter((entry) => typeof entry["content"] === "string")
          .map((entry) => ({
            step: entry["content"] as string,
            status: entry["status"] === "completed" ? "completed" : entry["status"] === "in_progress" ? "inProgress" : "pending",
          })),
      },
    };
  }

  private usageEvent(totals: Record<string, JsonValue> = {}): TranslatedEvent {
    const used = this.usage?.used ?? 0;
    const total = numberOr(totals["totalTokens"], numberOr(totals["total_tokens"], used));
    return {
      type: "usage.updated",
      payload: {
        threadId: this.context.threadId,
        turnId: this.turnId,
        tokenUsage: {
          total: { totalTokens: total, inputTokens: numberOr(totals["inputTokens"], 0), cachedInputTokens: 0, outputTokens: numberOr(totals["outputTokens"], 0), reasoningOutputTokens: 0 },
          last: { totalTokens: used, inputTokens: used, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          modelContextWindow: this.usage !== null && this.usage.size > 0 ? this.usage.size : null,
        },
      },
    };
  }

  private turnCompleted(status: "completed" | "failed" | "interrupted", message: string | null): TranslatedEvent {
    const turnId = this.turnId;
    this.turnId = null;
    this.declinedTools.clear();
    // 与 Codex 的归一化一致：中断的回合是 turn.interrupted（队列据此暂停、时间线标「已停止」）。
    return {
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

/**
 * 认出 SuDuo 工具服务的调用，返回 MCP 工具名（不带前缀）。各家的写法不同（S0：OpenCode 记为 `suduo_<工具>`，
 * Claude 式为 `mcp__suduo__<工具>`，也有写成 `suduo/<工具>`、`suduo.<工具>`、`<工具> (suduo MCP Server)` 的）。
 */
export function suDuoToolName(tool: { title: string; name: string | null }): string | null {
  for (const candidate of [tool.name, tool.title]) {
    if (candidate === null || candidate === "") continue;
    const text = candidate.trim();
    const prefixed = new RegExp(`^(?:mcp__)?${SUDUO_MCP_SERVER_NAME}(?:__|[_./:])([a-z][a-z_]*)\\b`, "i").exec(text);
    if (prefixed) return prefixed[1]!.toLowerCase();
    const suffixed = new RegExp(`^([a-z][a-z_]*)\\s*\\(${SUDUO_MCP_SERVER_NAME}(?: MCP Server)?\\)`, "i").exec(text);
    if (suffixed) return suffixed[1]!.toLowerCase();
  }
  return null;
}

function commandOf(tool: OpenTool): string {
  const input = asObject(tool.rawInput);
  const command = input["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  return tool.title;
}

/** 工具结果的文字：内容块里的文字，没有时用 rawOutput。 */
function outputText(tool: OpenTool): string {
  const texts: string[] = [];
  for (const entry of tool.content.map(asObject)) {
    if (entry["type"] === "content") {
      const block = asObject(entry["content"]);
      if (block["type"] === "text" && typeof block["text"] === "string") texts.push(block["text"]);
    }
  }
  if (texts.length > 0) return texts.join("\n");
  const raw = tool.rawOutput;
  if (typeof raw === "string") return raw;
  const object = asObject(raw);
  for (const key of ["output", "stdout", "result", "text", "content"]) {
    if (typeof object[key] === "string") return object[key] as string;
  }
  return raw === null ? "" : JSON.stringify(raw);
}

/** SuDuo 工具的结果内容：文字与图片块（ACP 的 image 块与 MCP 同形）。 */
function contentItems(tool: OpenTool): JsonValue[] {
  const items: JsonValue[] = [];
  for (const entry of tool.content.map(asObject)) {
    if (entry["type"] === "content") items.push(mcpContentItem(entry["content"] ?? null));
  }
  if (items.length === 0) {
    const text = outputText(tool);
    if (text !== "") items.push({ type: "inputText", text });
  }
  return items;
}

function fileChanges(tool: OpenTool, cwd: string): JsonValue[] {
  const diffs = tool.content.map(asObject).filter((entry) => entry["type"] === "diff" && typeof entry["path"] === "string");
  if (diffs.length > 0) {
    return diffs.map((entry) => {
      const filePath = entry["path"] as string;
      const before = typeof entry["oldText"] === "string" ? entry["oldText"] : null;
      const after = stringOr(entry["newText"], "");
      return before === null
        ? { path: filePath, kind: { type: "add", move_path: null }, diff: after }
        : { path: filePath, kind: { type: "update", move_path: null }, diff: snippetDiff(relative(cwd, filePath), before, after) };
    });
  }
  const reported = patchFiles(tool, cwd);
  if (reported.length > 0) return reported;
  const kind = tool.kind === "delete" ? "delete" : "update";
  return tool.locations.map((location) => ({ path: location, kind: { type: kind, move_path: null }, diff: "" }));
}

/**
 * OpenCode 的 apply_patch 既不给 diff 内容也不给位置，改动只在完成时的 rawOutput.metadata.files
 * （filePath / type: add | update | delete | move / patch 统一 diff / movePath）。按 Codex 的形状转：
 * 新增给全文、删除给原文、修改与改名给 diff 片段。
 */
function patchFiles(tool: OpenTool, cwd: string): JsonValue[] {
  const files = asObject(asObject(tool.rawOutput)["metadata"])["files"];
  if (!Array.isArray(files)) return [];
  return files.map(asObject).flatMap((file): JsonValue[] => {
    const filePath = file["filePath"];
    if (typeof filePath !== "string") return [];
    const lines = stringOr(file["patch"], "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const start = lines.findIndex((line) => line.startsWith("@@"));
    const hunks = start === -1 ? [] : lines.slice(start);
    const movePath = typeof file["movePath"] === "string" ? file["movePath"] : null;
    if (file["type"] === "add") return [{ path: filePath, kind: { type: "add", move_path: null }, diff: bodyOf(hunks, "+") }];
    if (file["type"] === "delete") return [{ path: filePath, kind: { type: "delete", move_path: null }, diff: bodyOf(hunks, "-") }];
    const diff = hunks.length === 0 ? "" : [`--- a/${relative(cwd, filePath)}`, `+++ b/${relative(cwd, movePath ?? filePath)}`, ...hunks].join("\n") + "\n";
    return [{ path: filePath, kind: { type: "update", move_path: movePath }, diff }];
  });
}

function bodyOf(hunks: string[], sign: "+" | "-"): string {
  const lines = hunks.filter((line) => line.startsWith(sign)).map((line) => line.slice(1));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

/**
 * 编辑类工具会动到的文件（权限判断与确认卡用）：位置、diff 内容、输入里的路径，以及 apply_patch 的补丁头
 * （OpenCode 用 apply_patch 时不给位置）。相对路径按工作目录解析。
 */
export function editPaths(
  tool: { locations?: Array<{ path: string }> | null; content?: Array<{ type: string; path?: string }> | null; rawInput?: unknown },
  cwd: string,
): string[] {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") paths.add(path.resolve(cwd, value.trim()));
  };
  for (const location of tool.locations ?? []) add(location.path);
  for (const content of tool.content ?? []) if (content.type === "diff") add(content.path);
  const input = tool.rawInput !== null && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput) ? (tool.rawInput as Record<string, unknown>) : {};
  for (const key of ["filePath", "file_path", "path"]) add(input[key]);
  for (const key of ["patchText", "patch", "input"]) {
    const patch = input[key];
    if (typeof patch !== "string") continue;
    for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu)) add(match[1]);
  }
  return [...paths];
}

function locationsOf(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.map(asObject).map((location) => location["path"]).filter((location): location is string => typeof location === "string")
    : [];
}

function relative(cwd: string, filePath: string): string {
  const rel = path.relative(cwd, filePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : filePath;
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
