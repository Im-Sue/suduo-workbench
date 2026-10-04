import type { EventEnvelope, JsonValue, RuntimeNoticeCode } from "@suduo/client-contracts";
import type { StreamNotice } from "./reducer.js";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor, type Messages } from "../i18n/messages/index.js";

/**
 * 事件投影（reducer.ts）与会话时间线（timeline.ts）共用的解析与本地化。
 * 文字按调用时的语言取（`t` 默认是当前语言的字典），投影不缓存，切换语言后重新投影即换成新语言。
 */

/**
 * 会话级提示：runtime.warning 与线程重建。不是提示类事件返回 undefined；是但文本为空返回 null。
 * SuDuo 写的提示带 code，按 code 用当前语言渲染（线程重建是系统状态提示，只按 code 取字典，不改写）；
 * 没有 code 的旧事件、认不出的 code 显示存下的原文（Codex 自带的英文提示照常本地化）。
 */
export function noticeOf(
  event: EventEnvelope<string, JsonValue>,
  t: Messages = messagesFor(currentLocale()),
): StreamNotice | null | undefined {
  const payload = objectValue(event.payload);
  if (event.type === "runtime.warning") {
    const rebuilt = payload["code"] === "thread-rebuilt";
    const text = runtimeNoticeText(payload, t) ?? localizeNotice(String(payload["message"] ?? ""), t);
    if (text === "") return null;
    return {
      id: event.eventId,
      ts: event.ts,
      text,
      level: rebuilt ? "info" : event.source.startsWith("suduo") ? "important" : "info",
    };
  }
  if (event.type === "thread.attached" && payload["reason"] === "resume-failed-rebuilt") {
    const text = String(payload["message"] ?? "");
    return text === "" ? null : { id: event.eventId, ts: event.ts, text, level: "info" };
  }
  return undefined;
}

type NoticeTexts = Messages["timeline"]["notice"];

/** 每种 code 的说法；参数不全（如旧版写的事件）返回 null，退回原文。契约新增 code 而这里漏写是类型错误。 */
const RUNTIME_NOTICE_TEXT: {
  [K in RuntimeNoticeCode]: (notice: NoticeTexts, params: Record<string, JsonValue>) => string | null;
} = {
  "thread-rebuilt": (notice) => notice.threadRebuilt,
  "connection-rebuilt": (notice) => notice.connectionRebuilt,
  // 与本机服务回「不支持」时的分支一致（codex-runtime.ts unsupportedRequestNotice）。
  "unsupported-request": (notice, { method }) =>
    typeof method !== "string"
      ? null
      : method === "item/tool/requestUserInput"
        ? notice.unsupportedQuestion
        : method === "mcpServer/elicitation/request"
          ? notice.unsupportedElicitation
          : notice.unsupportedRequest,
  "room-run-events-truncated": (notice, { omitted }) =>
    typeof omitted === "number" ? notice.runEventsTruncated(omitted) : null,
};

/**
 * SuDuo 写进账本的提示（runtime.warning / runtime.recovery-required 的 payload.code + params）按当前语言渲染。
 * 没有 code、认不出的 code 或参数不全时返回 null，由调用方显示存下的原文。
 */
export function runtimeNoticeText(
  payload: Record<string, JsonValue>,
  t: Messages = messagesFor(currentLocale()),
): string | null {
  const code = payload["code"];
  if (typeof code !== "string" || !Object.hasOwn(RUNTIME_NOTICE_TEXT, code)) return null;
  return RUNTIME_NOTICE_TEXT[code as RuntimeNoticeCode](t.timeline.notice, objectValue(payload["params"]));
}

/** runtime 自带提示是英文的；已知条目本地化，未知条目原样透出。 */
export function localizeNotice(text: string, t: Messages = messagesFor(currentLocale())): string {
  const notice = t.timeline.notice;
  if (/skills context budget/i.test(text)) {
    return notice.skillsBudget;
  }
  if (/model metadata for .* not found/i.test(text)) {
    // Codex 对不认识的模型用兜底参数：上下文按 27.2 万估算、不发推理强度、不开并行工具与改文件工具。
    // 只填「上下文上限」消不掉这条提示（也调不高上限）；要在 Codex 配置里用模型目录补上这个模型的信息。
    return notice.unknownModel;
  }
  if (/service tier .* is not advertised/i.test(text)) {
    return notice.serviceTier;
  }
  if (/falling back from websockets to https/i.test(text)) {
    return notice.websocketFallback;
  }
  const ignored = /Codex is ignoring (\d+) unrecognized configuration settings?/i.exec(text);
  if (ignored !== null) {
    // 后续每行一个键：user (<config.toml 路径>): `key` is ignored.；条数多时末尾是 ... and M more ignored settings.
    const keys = [...text.matchAll(/`([^`]+)` is ignored/g)].map((match) => match[1] ?? "");
    const more = /and (\d+) more ignored settings?/i.test(text);
    return notice.ignoredConfig(Number(ignored[1]), keys, more);
  }
  if (/could not find bubblewrap on PATH/i.test(text)) {
    return notice.bubblewrapMissing;
  }
  if (/sandbox uses bubblewrap and needs access to create user namespaces/i.test(text)) {
    return notice.userNamespaces;
  }
  return text;
}

/**
 * Codex 的错误对象（{ message, codexErrorInfo, additionalDetails }）说成人话：
 * 先看 HTTP 状态与附加说明判断原因，再补上「正在重连（第 N/M 次）」这类进度。
 */
export function describeCodexError(
  error: Record<string, JsonValue>,
  t: Messages = messagesFor(currentLocale()),
): string {
  return codexErrorDescription(error, t).text;
}

/**
 * 同 describeCodexError，另外告诉调用方说法里是否已经带了「第 N/M 次重连」的进度
 * （时间线据此决定要不要再换成「正在自动重试」的说法，不去匹配文字）。
 */
export function codexErrorDescription(
  error: Record<string, JsonValue>,
  t: Messages = messagesFor(currentLocale()),
): { text: string; reconnectAttempt: boolean } {
  const text = t.timeline.error;
  const message = typeof error["message"] === "string" ? error["message"] : "";
  const details = typeof error["additionalDetails"] === "string" ? error["additionalDetails"] : "";
  const info = error["codexErrorInfo"];
  // 不带 HTTP 状态的错误种类（codexErrorInfo 是字符串）：直接说原因。
  if (typeof info === "string" && Object.hasOwn(text.codex, info)) {
    return { text: text.codex[info as keyof typeof text.codex], reconnectAttempt: false };
  }
  let status: number | null = null;
  if (info !== null && typeof info === "object" && !Array.isArray(info)) {
    for (const value of Object.values(info)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value["httpStatusCode"] === "number") {
        status = value["httpStatusCode"];
      }
    }
  }
  if (/reconnecting.*waiting for network/i.test(message)) {
    return { text: text.waitingForNetwork, reconnectAttempt: false };
  }
  const reconnect = /reconnecting\.*\s*(\d+)\s*\/\s*(\d+)/i.exec(message);
  const input = `${status === null ? "" : String(status)} ${details} ${reconnect === null ? message : ""}`.trim();
  if (reconnect === null) return { text: localizeTurnError(input, t), reconnectAttempt: false };
  // 认出了原因只说原因那一句（后面的「请…」建议在重连中不需要）；认不出就只说连接断了。
  const kind = turnErrorKind(input);
  const head = kind === null ? text.connectionLost : text.turn[kind].brief;
  return { text: text.reconnecting(head, Number(reconnect[1]), Number(reconnect[2])), reconnectAttempt: true };
}

/** turn 失败原因人话化：已知错误翻译并给出下一步，未知错误原样透出。 */
export function localizeTurnError(text: string, t: Messages = messagesFor(currentLocale())): string {
  const kind = turnErrorKind(text);
  if (kind !== null) return t.timeline.error.turn[kind].text;
  return text === "" ? t.timeline.error.unknown : text;
}

/** 按 HTTP 状态与错误文字（Codex 给的英文）认出失败原因；认不出返回 null。 */
function turnErrorKind(text: string): keyof Messages["timeline"]["error"]["turn"] | null {
  if (/429|too many requests/i.test(text)) return "rateLimited";
  if (/401|unauthorized|authentication/i.test(text)) return "unauthorized";
  if (/403|forbidden/i.test(text)) return "forbidden";
  if (/5\d\d|internal server error|bad gateway|service unavailable/i.test(text)) return "serverError";
  if (/timeout|timed out/i.test(text)) return "timeout";
  return null;
}

export function objectValue(value: unknown): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

export function completedAgentMessageText(
  item: Record<string, JsonValue>,
  payload: Record<string, JsonValue>,
): string {
  if (typeof item["text"] === "string") {
    return item["text"];
  }
  // 历史事件保留 Codex 原生参数副本，兼容旧版本仅在 extensions 中含 item 的形状。
  const extensions = objectValue(payload["extensions"]);
  const codex = objectValue(extensions["codex"]);
  const params = objectValue(codex["params"]);
  const nativeItem = objectValue(params["item"]);
  return typeof nativeItem["text"] === "string" ? nativeItem["text"] : "";
}

/**
 * 权限审批请求的范围说成人话（每项一行）：「写入 /work/out」「读取 …」「联网」。
 * 形状按 Codex 的 RequestPermissionProfile：fileSystem.entries（新）/ read、write（旧）与 network.enabled。
 */
export function describePermissions(value: JsonValue | undefined, t: Messages = messagesFor(currentLocale())): string {
  const labels = t.timeline.permission;
  const accessLabel = (access: string): string =>
    access === "read" ? labels.read : access === "write" ? labels.write : access === "deny" ? labels.deny : access;
  const profile = objectValue(value);
  const fileSystem = objectValue(profile["fileSystem"]);
  const lines: string[] = [];
  const entries = Array.isArray(fileSystem["entries"]) ? fileSystem["entries"] : [];
  for (const entry of entries) {
    const record = objectValue(entry);
    const path = objectValue(record["path"]);
    const target =
      typeof path["path"] === "string"
        ? path["path"]
        : typeof path["pattern"] === "string"
          ? path["pattern"]
          : typeof path["value"] === "string"
            ? path["value"]
            : JSON.stringify(path["value"] ?? "");
    const access = String(record["access"] ?? "");
    lines.push(`${accessLabel(access)} ${target}`);
  }
  for (const key of ["read", "write"] as const) {
    const paths = fileSystem[key];
    if (Array.isArray(paths)) for (const path of paths) if (typeof path === "string") lines.push(`${accessLabel(key)} ${path}`);
  }
  if (objectValue(profile["network"])["enabled"] === true) lines.push(labels.network);
  return lines.join("\n");
}
