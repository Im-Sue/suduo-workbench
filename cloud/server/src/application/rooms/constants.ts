/**
 * 房间与共享 Agent 的常量（技术设计第九节）。
 */

/** 在线判定窗口：本机每 30 秒心跳，90 秒内有心跳算在线（Agent 与真人同一口径）。 */
export const PRESENCE_WINDOW_SECONDS = 90;

/** 执行中的任务，所属 Agent 超过这么久没有心跳就判定本机下线、任务中断。 */
export const RUNNING_STALE_SECONDS = 180;

/** 远程扫描（到期共享、掉线 Agent 的任务）间隔。 */
export const ROOM_SWEEP_INTERVAL_MS = 30_000;

/** 房间事件补发用的环形缓冲条数。 */
export const REALTIME_BUFFER_SIZE = 2_000;

/**
 * 补发缓冲的字节上限（按事件序列化后的 UTF-8 长度累计）：Agent 回答单条可到 10 万字，只按条数限会把内存撑大。
 * 超出从最旧的丢；补发拿不到的由客户端按房间序号补拉。
 */
export const REALTIME_BUFFER_MAX_BYTES = 32 * 1024 * 1024;

/** 房间列表里最后一条消息的预览长度（字）。 */
export const LAST_MESSAGE_PREVIEW_LENGTH = 80;

/** 话题摘要里给出的最近回复者人数。 */
export const THREAD_LAST_REPLIERS = 3;

/** 「两小时」共享时长。 */
export const SHARE_TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

/** 浏览器给的「今天结束」只接受未来这么久以内的值，否则按服务端时区的当天结束。 */
export const SHARE_TODAY_MAX_AHEAD_MS = 24 * 60 * 60 * 1_000;

/** 房间文件根目录的所有权标记（与需求附件根目录分开，各自的启动清理互不影响）。 */
export const ROOM_FILE_ROOT_MARKER = {
  fileName: ".suduo-room-files-v1",
  content: "suduo-room-files-v1\n",
} as const;

/** 任务失败 / 停止 / 离线的原因文案（直接展示给房间里的人）。 */
export const RUN_REASONS = {
  notShared: "未共享到这个房间",
  ownerOffline: "所有者不在线",
  shareClosed: "共享已关闭",
  shareExpired: "共享已到期",
  ownerDisconnected: "所有者本机下线，执行中断",
} as const;

/** @ 所有人的展示文字。 */
export const MENTION_ALL_LABEL = "所有人";
