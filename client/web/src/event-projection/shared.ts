import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { StreamNotice } from "./reducer.js";

/** 事件投影（reducer.ts）与会话时间线（timeline.ts）共用的解析与本地化。 */

/**
 * 会话级提示：runtime.warning 与线程重建。不是提示类事件返回 undefined；是但文本为空返回 null。
 * 线程重建是系统状态提示，文案必须直接取事件值，不猜测、不改写。
 */
export function noticeOf(event: EventEnvelope<string, JsonValue>): StreamNotice | null | undefined {
  const payload = objectValue(event.payload);
  if (event.type === "runtime.warning") {
    const rebuilt = payload["code"] === "thread-rebuilt";
    const text = rebuilt ? String(payload["message"] ?? "") : localizeNotice(String(payload["message"] ?? ""));
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

/** runtime 自带提示是英文的；已知条目本地化，未知条目原样透出。 */
export function localizeNotice(text: string): string {
  if (/skills context budget/i.test(text)) {
    return "可用 skill 较多，描述已按 Codex 的上下文预算自动缩短——每个 skill 仍可正常选用；在设置里停用不常用的 skill 可让描述更完整。";
  }
  if (/model metadata for .* not found/i.test(text)) {
    // Codex 对不认识的模型用兜底参数：上下文按 27.2 万估算、不发推理强度、不开并行工具与改文件工具。
    // 只填「上下文上限」消不掉这条提示（也调不高上限）；要在 Codex 配置里用模型目录补上这个模型的信息。
    return "当前模型不在 Codex 的内置模型清单里，Codex 按默认参数运行：上下文约 27 万（设置里调小过则按设置），所选推理强度不会发给模型服务，部分工具不可用。在 Codex 配置里给这个模型补上模型清单信息后，这条提示会消失。";
  }
  if (/service tier .* is not advertised/i.test(text)) {
    return "模型服务未声明支持所配置的 service tier，本次请求已自动忽略该参数，不影响使用。";
  }
  if (/falling back from websockets to https/i.test(text)) {
    return "用 WebSocket 连接模型服务没有成功，已改用 HTTPS 连接。";
  }
  const ignored = /Codex is ignoring (\d+) unrecognized configuration settings?/i.exec(text);
  if (ignored !== null) {
    // 后续每行一个键：user (<config.toml 路径>): `key` is ignored.；条数多时末尾是 ... and M more ignored settings.
    const keys = [...text.matchAll(/`([^`]+)` is ignored/g)].map((match) => match[1]);
    const more = /and (\d+) more ignored settings?/i.test(text);
    const list = keys.length > 0 ? `：${keys.join("、")}${more ? " 等" : ""}` : "";
    return `Codex 忽略了 ${ignored[1]} 个不认识的配置项（可能拼错了，或是新版已不再支持）${list}。不影响使用；在 Codex 配置里删掉或改正即可消除这条提示。`;
  }
  if (/could not find bubblewrap on PATH/i.test(text)) {
    return "这台机器没装 bubblewrap，Codex 暂时用自带的沙箱组件。按 OpenAI 的说明安装 bubblewrap（Ubuntu / Debian：sudo apt install bubblewrap；Ubuntu 24.04 还要加载官方的 AppArmor 配置），处理办法见「设置 → 诊断」的「命令沙箱」一项。";
  }
  if (/sandbox uses bubblewrap and needs access to create user namespaces/i.test(text)) {
    return "Codex 的 Linux 沙箱建不了用户命名空间，需要审批或受限执行的命令会失败。处理办法见「设置 → 诊断」的「命令沙箱」一项。";
  }
  return text;
}

/**
 * Codex 的错误对象（{ message, codexErrorInfo, additionalDetails }）说成人话：
 * 先看 HTTP 状态与附加说明判断原因，再补上「正在重连（第 N/M 次）」这类进度。
 */
export function describeCodexError(error: Record<string, JsonValue>): string {
  const message = typeof error["message"] === "string" ? error["message"] : "";
  const details = typeof error["additionalDetails"] === "string" ? error["additionalDetails"] : "";
  const info = error["codexErrorInfo"];
  // 不带 HTTP 状态的错误种类（codexErrorInfo 是字符串）：直接说原因。
  if (typeof info === "string" && CODEX_ERROR_TEXT[info] !== undefined) {
    return CODEX_ERROR_TEXT[info];
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
    return "和模型服务的连接断了，正在等网络恢复后重连…";
  }
  const reconnect = /reconnecting\.*\s*(\d+)\s*\/\s*(\d+)/i.exec(message);
  const input = `${status === null ? "" : String(status)} ${details} ${reconnect === null ? message : ""}`.trim();
  const reason = localizeTurnError(input);
  if (reconnect === null) return reason;
  // 认出了原因只取第一句（后面的「请…」建议在重连中不需要）；认不出就只说连接断了。
  const recognized = input !== "" && reason !== input;
  const head = recognized ? (reason.split("。")[0] ?? reason) : "和模型服务的连接中断了";
  return `${head}，正在重连（第 ${reconnect[1]}/${reconnect[2]} 次）…`;
}

/** turn 失败原因人话化：已知错误翻译并给出下一步，未知错误原样透出。 */
export function localizeTurnError(text: string): string {
  if (/429|too many requests/i.test(text)) {
    return "模型服务限流（429），已自动重试仍失败。请稍等几分钟再发送；若持续出现请联系管理员检查配额。";
  }
  if (/401|unauthorized|authentication/i.test(text)) {
    return "模型服务认证失败（401）。请在设置的模型服务里检查凭证，或联系管理员重新配置。";
  }
  if (/403|forbidden/i.test(text)) {
    return "模型服务拒绝了请求（403），当前凭证可能没有权限使用这个模型。";
  }
  if (/5\d\d|internal server error|bad gateway|service unavailable/i.test(text)) {
    return "模型服务暂时出错，请稍后重试。";
  }
  if (/timeout|timed out/i.test(text)) {
    return "模型服务响应超时，请稍后重试。";
  }
  return text === "" ? "本回合执行失败，原因未知。" : text;
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

/** 字符串形式的 codexErrorInfo（Codex 协议 `CodexErrorInfo` 的无参分支）。 */
const CODEX_ERROR_TEXT: Record<string, string> = {
  contextWindowExceeded: "这段对话已经超出模型的上下文窗口。可以新开一个会话，或让 Codex 先总结再继续。",
  usageLimitExceeded: "模型用量已经到上限，请稍后再试，或联系管理员调整额度。",
  unauthorized: "模型服务认证失败（401）。请在设置的模型服务里检查凭证，或联系管理员重新配置。",
  serverOverloaded: "模型服务现在很忙，请稍等一会儿再试。",
  internalServerError: "模型服务暂时出错，请稍后重试。",
  badRequest: "模型服务拒绝了这次请求，可能是参数或附件不被支持。",
  sandboxError: "命令没能在沙箱里运行。可以检查审批档与项目目录的权限设置。",
  rateLimitExceeded: "模型服务限流了，请稍等几分钟再发送。",
  flexUnavailable: "模型服务当前的处理档位暂时不可用，请稍后重试。",
  misalignmentPolicyViolation: "这次请求触发了模型服务的安全策略，本回合已停止。可以换个说法再试。",
  tooManyDenials: "被拒绝的操作太多，本回合已停止。可以调整审批方式或换个做法再试。",
  sessionBudgetExceeded: "这个会话的用量预算已经用完。可以新开一个会话继续。",
  cyberPolicy: "请求涉及网络安全相关内容，被模型服务的安全策略拦下了。",
  threadRollbackFailed: "回退对话没有成功，请重试。",
};

const ACCESS_LABEL: Record<string, string> = { read: "读取", write: "写入", deny: "禁止访问" };

/**
 * 权限审批请求的范围说成人话（每项一行）：「写入 /work/out」「读取 …」「联网」。
 * 形状按 Codex 的 RequestPermissionProfile：fileSystem.entries（新）/ read、write（旧）与 network.enabled。
 */
export function describePermissions(value: JsonValue | undefined): string {
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
    lines.push(`${ACCESS_LABEL[access] ?? access} ${target}`);
  }
  for (const [key, label] of [["read", "读取"], ["write", "写入"]] as const) {
    const paths = fileSystem[key];
    if (Array.isArray(paths)) for (const path of paths) if (typeof path === "string") lines.push(`${label} ${path}`);
  }
  if (objectValue(profile["network"])["enabled"] === true) lines.push("联网");
  return lines.join("\n");
}
