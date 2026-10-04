import type { JsonValue } from "@suduo/client-contracts";
import type { ServerMessages } from "../i18n/messages/index.js";

/**
 * 把一个步骤（Codex 的 item）说成一句话，给会话卡片显示「正在做什么」；按 `t`（请求的语言）生成。
 * 只做摘要：命令截到 60 字，文件只给文件名；认不出的类型返回 null（卡片就不显示这一行）。
 */
export function describeActivity(
  step: { item: JsonValue; completed: boolean } | JsonValue | null,
  t: ServerMessages,
): string | null {
  const { item, completed } =
    step !== null && typeof step === "object" && !Array.isArray(step) && "completed" in step && "item" in step
      ? (step as { item: JsonValue; completed: boolean })
      : { item: step as JsonValue | null, completed: false };
  const text = describeItem(item, t);
  if (text === null || !completed) return text;
  // 已经做完、下一步还没开始：思考 / 回复做完就没什么可说的；其余说「刚完成：…」，不假装还在跑。
  if (isThinkingOrReplying(item)) return null;
  return t.activity.step.justFinished(text);
}

function describeItem(item: JsonValue | null, t: ServerMessages): string | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const text = t.activity.step;
  const type = item["type"];
  if (type === "commandExecution") {
    const command = commandText(item["command"]);
    return command === null ? text.runCommand : text.runCommandWith(shorten(redactSecrets(command), 60));
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
    const names = changes
      .map((change) => (change !== null && typeof change === "object" && !Array.isArray(change) && typeof change["path"] === "string" ? baseName(change["path"]) : null))
      .filter((name): name is string => name !== null);
    if (names.length === 0) return text.editFiles;
    return names.length === 1 ? text.editFile(names[0]!) : text.editFilesMany(names[0]!, names.length);
  }
  if (type === "mcpToolCall") {
    const tool = typeof item["tool"] === "string" ? item["tool"] : null;
    return tool === null ? text.callTool : text.callToolWith(tool);
  }
  if (type === "webSearch") return text.webSearch;
  if (type === "reasoning") return text.thinking;
  if (type === "agentMessage") return text.replying;
  return null;
}

/** 思考 / 回复：做完就没什么可说的（按步骤类型判断，不看文字）。 */
function isThinkingOrReplying(item: JsonValue | null): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  return item["type"] === "reasoning" || item["type"] === "agentMessage";
}

function commandText(value: JsonValue | undefined): string | null {
  const raw = Array.isArray(value) ? value.filter((part) => typeof part === "string").join(" ") : typeof value === "string" ? value : null;
  if (raw === null || raw.trim() === "") return null;
  // 去掉常见的 shell 包装：/bin/zsh -lc "…" → …
  const wrapped = /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(raw.trim());
  return (wrapped?.[2] ?? raw).trim();
}

/**
 * 卡片在默认落地页上，容易被投屏或截图：命令里像密钥的片段打码。
 * 覆盖常见形态：sk-… / ghp_… / github_pat_… / xox?-… / AKIA… / Authorization: Bearer|token|Basic … /
 * URL 里的账号密码 / curl -u / mysql -p… / --token= / --password … / FOO_KEY= / api_key=（不分大小写）。
 */
export function redactSecrets(command: string): string {
  return command
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "$1_***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "github_pat_***")
    .replace(/\b(xox[abprs])-[A-Za-z0-9-]{8,}/g, "$1-***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***")
    .replace(/\b(Authorization:\s*)(?:Bearer|token|Basic)\s+[^\s"']+/gi, (match, prefix: string) => `${prefix}${match.slice(prefix.length).split(/\s+/)[0]} ***`)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"']+:[^\s/@"']+@/gi, "$1***@")
    .replace(/(\s-u\s*|--user(?:=|\s+))("[^"]*"|'[^']*'|[^\s:]+:\S+)/g, "$1***")
    .replace(/(\b(?:mysql|mysqldump|mariadb)\b[^|;&]*?\s-p)(?!\s)(\S+)/g, "$1***")
    .replace(/(--?(?:api[-_]?key|token|password|secret|passwd)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd)[A-Za-z0-9_]*=)("[^"]*"|'[^']*'|\S+)/gi, "$1***");
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function shorten(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
