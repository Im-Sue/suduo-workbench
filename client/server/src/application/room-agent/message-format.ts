import type { Locale } from "@suduo/client-contracts";
import { agentKindName, type RoomFileDto, type RoomMessageDto } from "@suduo/cloud-contracts";
import { messagesFor } from "../../i18n/messages/index.js";

/**
 * 房间消息给模型看的一行文字（回合输入与房间工具共用）：
 * `10:02 李娜：正文 [图片 订单截图.png]（文件 ID f-1）`。
 * 正文、人名、文件名原样；作者标签、文件标签、截断提示按任务会话的语言（`locale`）。
 */

/**
 * 作者名。Agent 不用云端标签（S6 起是英文兜底），按会话语言用所有者名、Agent 种类与设备名自己拼，
 * 与前端 `rooms.agent.withDevice` 同一写法。
 */
export function authorNameOf(message: RoomMessageDto, locale: Locale): string {
  const text = messagesFor(locale).roomPrompt.message;
  if (message.authorKind === "agent") {
    if (message.agent) {
      return text.agentWithDevice(message.agent.owner.displayName, agentKindName(message.agent.kind), message.agent.deviceName);
    }
    return message.author ? text.agentName(message.author.displayName, "Agent") : "Agent";
  }
  if (message.authorKind === "system") {
    return text.systemAuthor;
  }
  return message.author?.displayName ?? text.unknownUser;
}

/** 正文截到 limit 字（按字符计），超出注明总字数。 */
export function clipBody(body: string, limit: number, locale: Locale): string {
  const text = body.trim();
  const characters = Array.from(text);
  if (characters.length <= limit) {
    return text;
  }
  return characters.slice(0, limit).join("") + messagesFor(locale).roomPrompt.message.clipped(characters.length);
}

export function describeFiles(files: readonly RoomFileDto[], options: { withTool: boolean; locale: Locale }): string {
  const text = messagesFor(options.locale).roomPrompt.message;
  const kinds: Readonly<Record<string, string>> = text.fileKind;
  return files
    .map((file) => text.file(kinds[file.kind] ?? text.fileKind.file, file.fileName, file.id, options.withTool))
    .join(" ");
}

/** 本机时区的 `HH:mm`；和参考时间不在同一天时带上 `MM-DD`。 */
export function shortTime(value: string, reference?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (reference === undefined) {
    return time;
  }
  const ref = new Date(reference);
  const sameDay =
    !Number.isNaN(ref.getTime()) &&
    ref.getFullYear() === date.getFullYear() &&
    ref.getMonth() === date.getMonth() &&
    ref.getDate() === date.getDate();
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** 完整时间 `2026-09-30 10:02`（房间工具里跨天的历史用）。 */
export function fullTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatMessageLine(
  message: RoomMessageDto,
  options: { bodyLimit: number; time: string; withTool: boolean; withSeq?: boolean; locale: Locale },
): string {
  const text = messagesFor(options.locale).roomPrompt.message;
  const body = clipBody(message.body, options.bodyLimit, options.locale);
  const files =
    message.files.length === 0 ? "" : describeFiles(message.files, { withTool: options.withTool, locale: options.locale });
  const content = [body, files].filter((part) => part !== "").join(" ");
  const prefix = options.withSeq ? `#${message.seq} ` : "";
  return prefix + text.line(options.time, authorNameOf(message, options.locale), content === "" ? text.empty : content);
}
