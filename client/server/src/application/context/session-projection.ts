import type { JsonValue } from "@suduo/client-contracts";
import { redactSecrets } from "../session-activity.js";

/**
 * 会话账本 → 按「回合」整理的内容（多 Agent 协作 S7，技术设计 2.8「分层读取」）。
 * 账本里的条目已是统一条目模型（Codex 形状，Claude / ACP 由各自的翻译器转好），所以这里与 Agent 无关。
 *
 * 回合按运行时的回合（turn.started 与事件的 turnRef）切，不按用户消息切：回合进行中又发的消息，
 * Codex 会并入这一轮（userMessage 条目带 clientId = 发送时的 clientTurnId，报在真正收下它的回合里），
 * Claude / ACP 会排到下一轮——没有归属证据的消息归给它之后开始的那一轮。
 * 回合里收：最终回答（最后一条 agentMessage）、命令、工具调用、文件改动、结束状态。流式增量不看（只用 item.completed）。
 */

export type RoundStatus = "running" | "completed" | "failed" | "interrupted";

export interface RoundCommand {
  command: string;
  exitCode: number | null;
  output: string;
}

export interface RoundToolCall {
  /** 「suduo · requirement_get」「github · create_issue」或 SuDuo 工具名。 */
  name: string;
  arguments: string;
  success: boolean | null;
  output: string;
}

export interface RoundFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff: string;
}

export interface ProjectedRound {
  /** 回合序号，从 1 开始。 */
  index: number;
  /** 这一轮第一条用户消息在账本里的序号（没有用户消息时为回合开始的序号）。 */
  seq: number;
  startedAt: number;
  userText: string;
  /** 用户消息里的图片、文件等非文字部分的个数。 */
  attachmentCount: number;
  status: RoundStatus;
  error: string | null;
  answer: string | null;
  commands: RoundCommand[];
  tools: RoundToolCall[];
  files: RoundFileChange[];
  webSearches: string[];
}

export interface ProjectableEvent {
  seq: number;
  type: string;
  ts: number;
  payload: JsonValue;
  turnRef?: { turnId: string } | null;
}

interface PendingMessage {
  seq: number;
  ts: number;
  text: string;
  attachments: number;
  clientTurnId: string | null;
}

/** 按账本顺序把事件整理成回合。 */
export function projectRounds(events: Iterable<ProjectableEvent>): ProjectedRound[] {
  const rounds: ProjectedRound[] = [];
  const byTurn = new Map<string, ProjectedRound>();
  /** 已提交、还没被哪一轮收下的用户消息。 */
  let pending: PendingMessage[] = [];
  let latest: ProjectedRound | null = null;

  const open = (event: ProjectableEvent, turnId: string | null, messages: PendingMessage[]): ProjectedRound => {
    const round: ProjectedRound = {
      index: rounds.length + 1,
      seq: messages[0]?.seq ?? event.seq,
      startedAt: messages[0]?.ts ?? event.ts,
      userText: messages.map((message) => message.text).filter((text) => text !== "").join("\n\n"),
      attachmentCount: messages.reduce((sum, message) => sum + message.attachments, 0),
      status: "running",
      error: null,
      answer: null,
      commands: [],
      tools: [],
      files: [],
      webSearches: [],
    };
    rounds.push(round);
    if (turnId !== null) byTurn.set(turnId, round);
    latest = round;
    return round;
  };
  const roundOf = (event: ProjectableEvent): ProjectedRound | null => {
    const turnId = event.turnRef?.turnId ?? null;
    return turnId === null ? latest : (byTurn.get(turnId) ?? null);
  };

  for (const event of events) {
    const payload = objectOf(event.payload);
    switch (event.type) {
      case "message.submitted": {
        const content = Array.isArray(payload["content"]) ? payload["content"].map(objectOf) : [];
        pending.push({
          seq: event.seq,
          ts: event.ts,
          text: content
            .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
            .map((part) => String(part["text"]))
            .join("\n")
            .trim(),
          attachments: content.filter((part) => part["type"] !== "text").length,
          clientTurnId: typeof payload["clientTurnId"] === "string" ? payload["clientTurnId"] : null,
        });
        break;
      }
      case "turn.started": {
        const turn = objectOf(payload["turn"]);
        const turnId = typeof turn["id"] === "string" ? turn["id"] : (event.turnRef?.turnId ?? null);
        if (turnId !== null && byTurn.has(turnId)) break;
        open(event, turnId, pending);
        pending = [];
        break;
      }
      case "item.started":
      case "item.completed": {
        const item = objectOf(payload["item"]);
        const round = roundOf(event);
        if (typeof item["type"] === "string" && /^usermessage$/iu.test(item["type"])) {
          // 归属证据：这条消息被哪一轮收下（并入进行中的一轮时，它不会开新回合）。
          const clientId = item["clientId"];
          const index = pending.findIndex((message) => message.clientTurnId !== null && message.clientTurnId === clientId);
          if (round !== null && index >= 0) {
            const [message] = pending.splice(index, 1);
            if (message !== undefined) {
              round.userText = [round.userText, message.text].filter((text) => text !== "").join("\n\n");
              round.attachmentCount += message.attachments;
            }
          }
          break;
        }
        if (event.type === "item.completed" && round !== null) collectItem(round, item);
        break;
      }
      case "turn.completed": {
        const round = roundOf(event);
        if (round === null) break;
        const turn = objectOf(payload["turn"]);
        const status = turn["status"];
        round.status = status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
        const error = objectOf(turn["error"]);
        if (typeof error["message"] === "string" && error["message"].trim() !== "") round.error = error["message"].trim();
        break;
      }
      case "turn.interrupted": {
        const round = roundOf(event);
        if (round !== null) round.status = "interrupted";
        break;
      }
      case "turn.start-failed": {
        // 回合没开起来：还没被收下的消息算作一轮失败的。
        if (pending.length > 0) {
          open(event, null, pending).status = "failed";
          pending = [];
        }
        break;
      }
      default:
        break;
    }
  }
  // 已提交、回合还没开始的消息：算作进行中的一轮。
  if (pending.length > 0) {
    const last = pending[pending.length - 1]!;
    open({ seq: last.seq, type: "message.submitted", ts: last.ts, payload: null }, null, pending);
  }
  return rounds;
}

function collectItem(round: ProjectedRound, item: Record<string, JsonValue>): void {
  switch (item["type"]) {
    case "agentMessage":
      if (typeof item["text"] === "string" && item["text"].trim() !== "") round.answer = item["text"].trim();
      return;
    case "commandExecution": {
      const raw = item["command"];
      const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(String).join(" ") : "";
      round.commands.push({
        command: redactSecrets(command),
        exitCode: typeof item["exitCode"] === "number" ? item["exitCode"] : null,
        output: typeof item["aggregatedOutput"] === "string" ? redactSecrets(item["aggregatedOutput"]) : "",
      });
      return;
    }
    case "fileChange": {
      const changes = Array.isArray(item["changes"]) ? item["changes"].map(objectOf) : [];
      for (const change of changes) {
        const kind = objectOf(change["kind"])["type"];
        const path = String(change["path"] ?? "");
        const diff = typeof change["diff"] === "string" ? change["diff"] : "";
        round.files.push({
          path,
          kind: kind === "add" || kind === "delete" ? kind : "update",
          diff: isSecretFile(path) ? redactSecrets(diff) : diff,
        });
      }
      return;
    }
    case "mcpToolCall": {
      const error = objectOf(item["error"]);
      round.tools.push({
        name: `${String(item["server"] ?? "")} · ${String(item["tool"] ?? "")}`,
        arguments: redactSecrets(compact(item["arguments"])),
        success: item["status"] === "failed" || typeof error["message"] === "string" ? false : item["status"] === "completed" ? true : null,
        output: redactSecrets(typeof error["message"] === "string" ? error["message"] : compact(item["result"])),
      });
      return;
    }
    case "dynamicToolCall": {
      const contentItems = Array.isArray(item["contentItems"]) ? item["contentItems"].map(objectOf) : [];
      round.tools.push({
        name: String(item["tool"] ?? ""),
        arguments: redactSecrets(compact(item["arguments"])),
        success: typeof item["success"] === "boolean" ? item["success"] : null,
        output: redactSecrets(
          contentItems
            .map((part) => (part["type"] === "inputText" && typeof part["text"] === "string" ? part["text"] : ""))
            .filter((text) => text !== "")
            .join("\n"),
        ),
      });
      return;
    }
    case "webSearch":
      if (typeof item["query"] === "string" && item["query"] !== "") round.webSearches.push(item["query"]);
      return;
    default:
      return;
  }
}

/** 一个回合改了哪些文件（同一文件多次改动只算一次，记最后的种类）。 */
export function changedPaths(rounds: readonly ProjectedRound[]): Map<string, RoundFileChange["kind"]> {
  const paths = new Map<string, RoundFileChange["kind"]>();
  for (const round of rounds) {
    for (const file of round.files) {
      if (file.path === "") continue;
      const previous = paths.get(file.path);
      // 先加后改仍是新增；先改后删是删除。
      paths.set(file.path, previous === "add" && file.kind === "update" ? "add" : file.kind);
    }
  }
  return paths;
}

/**
 * 放密钥的文件（.env、.npmrc 等）：改动里的值也打码（被读的内容会交给另一家 Agent）。
 * 普通代码文件不打码，免得 `monkey=1` 这类写法被误伤、diff 不准。
 */
export function isSecretFile(path: string): boolean {
  const name = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return /^\.env(\..*)?$/u.test(name) || [".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json"].includes(name);
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function compact(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
