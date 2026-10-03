export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${String(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(ts);
}

/** 会话列表用的相对时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / MM-DD。 */
export function relativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) {
    return "刚刚";
  }
  if (diff < 3_600_000) {
    return `${String(Math.floor(diff / 60_000))} 分钟前`;
  }
  const date = new Date(ts);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return formatTime(ts);
  }
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) {
    return `昨天 ${formatTime(ts)}`;
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" })
    .format(ts)
    .replace("/", "-");
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${String(seconds)} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? `${String(minutes)} 分钟`
    : `${String(minutes)} 分 ${String(rest)} 秒`;
}

/** 新会话默认名：新会话 MM-DD HH:mm。 */
export function defaultSessionTitle(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `新会话 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** child 是否位于 parent 目录内（大小写与分隔符不敏感，用于全局 skill 判定）。 */
export function isSubPath(child: string, parent: string): boolean {
  if (!child || !parent) {
    return false;
  }
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const normalizedChild = normalize(child);
  const normalizedParent = normalize(parent);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(normalizedParent + "/")
  );
}
