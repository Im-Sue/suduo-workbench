import type { RoomFileDto, RoomMessageDto } from "@suduo/cloud-contracts";

/**
 * 房间消息给模型看的一行文字（回合输入与房间工具共用）：
 * `10:02 李娜：正文 [图片 订单截图.png]（文件 ID f-1）`。
 */

const FILE_KIND_LABELS: Record<RoomFileDto["kind"], string> = {
  image: "图片",
  video: "视频",
  file: "文件",
};

export function authorNameOf(message: RoomMessageDto): string {
  if (message.authorKind === "agent") {
    return message.agent?.label ?? (message.author ? `${message.author.displayName} 的 Codex` : "Agent");
  }
  if (message.authorKind === "system") {
    return "系统";
  }
  return message.author?.displayName ?? "未知用户";
}

/** 正文截到 limit 字（按字符计），超出注明总字数。 */
export function clipBody(body: string, limit: number): string {
  const text = body.trim();
  const characters = Array.from(text);
  if (characters.length <= limit) {
    return text;
  }
  return characters.slice(0, limit).join("") + `……（这条共 ${characters.length} 字，后面省略）`;
}

export function describeFiles(files: readonly RoomFileDto[], options: { withTool: boolean }): string {
  return files
    .map(
      (file) =>
        `[${FILE_KIND_LABELS[file.kind] ?? "文件"} ${file.fileName}]（文件 ID ${file.id}${options.withTool ? "，用 suduo_room_file_view 查看" : ""}）`,
    )
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
  options: { bodyLimit: number; time: string; withTool: boolean; withSeq?: boolean },
): string {
  const body = clipBody(message.body, options.bodyLimit);
  const files = message.files.length === 0 ? "" : describeFiles(message.files, { withTool: options.withTool });
  const content = [body, files].filter((part) => part !== "").join(" ");
  const prefix = options.withSeq ? `#${message.seq} ` : "";
  return `${prefix}${options.time} ${authorNameOf(message)}：${content === "" ? "（空消息）" : content}`;
}
