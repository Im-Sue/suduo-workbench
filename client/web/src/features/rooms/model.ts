import {
  AGENT_RUN_ACTIVITY_KINDS,
  formatRequirementNumber,
  LOCALES,
  readAgentRunProgress,
  readAgentRunReason,
  type AgentDto,
  type AgentRunStatus,
  type AgentRunSummaryDto,
  type AgentShareDto,
  type AgentShareDuration,
  type AgentSummaryDto,
  type RoomDto,
  type RoomFileDto,
  type RoomLastMessageDto,
  type RoomMemberDto,
  type RoomMentionDto,
  type RoomMessageDto,
  type UserSummaryDto,
} from "@suduo/cloud-contracts";
import { formatClock, formatMonthDay } from "../../ui/format.js";
import { summaryPreview } from "../requirements/format.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";

/**
 * 房间模块的纯逻辑（无 React、无请求），单测直接覆盖：
 * 消息合并（按 id 替换、按序号排序、新回复给话题根计数）、任务状态写回、未读、文案。
 */

// ───────────────────────────── 消息缓存 ─────────────────────────────

/** 一个房间（或一个话题）在缓存里的消息：按序号升序，含话题回复（主消息流只显示根）。 */
export interface MessagesData {
  items: RoomMessageDto[];
  hasMoreBefore: boolean;
  lastSeq: number;
}

export const EMPTY_MESSAGES: MessagesData = { items: [], hasMoreBefore: false, lastSeq: 0 };

export function sortBySeq(items: readonly RoomMessageDto[]): RoomMessageDto[] {
  return items.toSorted((left, right) => left.seq - right.seq);
}

export function maxSeq(items: readonly RoomMessageDto[]): number {
  let max = 0;
  for (const item of items) if (item.seq > max) max = item.seq;
  return max;
}

export function fromPage(page: { items: RoomMessageDto[]; hasMoreBefore: boolean; lastSeq: number }): MessagesData {
  return { items: sortBySeq(page.items), hasMoreBefore: page.hasMoreBefore, lastSeq: Math.max(page.lastSeq, maxSeq(page.items)) };
}

/** 话题根上「N 条回复」的本地累加：新回复进来时先在界面上加 1，之后以服务端返回的根为准。 */
export function bumpThread(root: RoomMessageDto, reply: RoomMessageDto): RoomMessageDto {
  const thread = root.thread ?? { replyCount: 0, lastReplyAt: null, lastRepliers: [] };
  // 最近回复者与服务端同口径：只算真人发的回复（Agent 的回答不把它的所有者算进来）。
  const replier = reply.authorKind === "user" ? reply.author : null;
  const lastRepliers =
    replier === null
      ? thread.lastRepliers
      : [replier, ...thread.lastRepliers.filter((user) => user.id !== replier.id)].slice(0, 3);
  return {
    ...root,
    thread: { replyCount: thread.replyCount + 1, lastReplyAt: reply.createdAt, lastRepliers },
  };
}

/**
 * 把一批服务端消息合进缓存：同 id 替换（任务状态、话题计数以服务端为准），新消息按序号插入；
 * 新的话题回复给缓存里的根加计数——但根本身也在这一批里时不加：不论缓存里原来有没有这个根，
 * 服务端随这一批返回的根已经算上了同批的回复（补拉、向上翻历史时根和回复常一起回来）。
 */
export function mergeMessages(
  data: MessagesData,
  incoming: readonly RoomMessageDto[],
): { data: MessagesData; added: RoomMessageDto[] } {
  if (incoming.length === 0) return { data, added: [] };
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const inBatch = new Set(incoming.map((message) => message.id));
  const added: RoomMessageDto[] = [];
  for (const message of incoming) {
    if (!byId.has(message.id)) added.push(message);
    byId.set(message.id, message);
  }
  for (const reply of added) {
    const rootId = reply.threadRootId;
    if (rootId === null || inBatch.has(rootId)) continue;
    const root = byId.get(rootId);
    if (root !== undefined) byId.set(rootId, bumpThread(root, reply));
  }
  const items = sortBySeq([...byId.values()]);
  return {
    data: { ...data, items, lastSeq: Math.max(data.lastSeq, maxSeq(items)) },
    added,
  };
}

/**
 * 向上翻到的更早一页：按 id 合并，不给话题根加计数（更早的回复在根被取回时服务端就已算进去了），
 * 「还有更早的」以这一页为准。
 */
export function mergeOlderPage(data: MessagesData, page: { items: readonly RoomMessageDto[]; hasMoreBefore: boolean }): MessagesData {
  const byId = new Map(data.items.map((item) => [item.id, item]));
  for (const message of page.items) byId.set(message.id, message);
  const items = sortBySeq([...byId.values()]);
  return { ...data, items, hasMoreBefore: page.hasMoreBefore, lastSeq: Math.max(data.lastSeq, maxSeq(items)) };
}

/**
 * 话题重取（窗口聚焦、轮询、补拉失效）只拿回根 + 最新一页：与缓存合并，不丢已经「加载更早的回复」翻出来的，
 * 也不丢重取期间推送进来的；同一条以重取结果为准。缓存比这一页翻得更早时，「还有更早的」以缓存为准。
 */
export function mergeThreadRefetch(cached: MessagesData | undefined, fresh: MessagesData, rootId: string): MessagesData {
  if (cached === undefined) return fresh;
  const byId = new Map(cached.items.map((item) => [item.id, item]));
  for (const message of fresh.items) byId.set(message.id, message);
  const items = sortBySeq([...byId.values()]);
  const earliestReply = (data: MessagesData) => data.items.find((item) => item.id !== rootId)?.seq ?? Number.POSITIVE_INFINITY;
  const reachedFurther = earliestReply(cached) < earliestReply(fresh);
  return {
    ...fresh,
    items,
    hasMoreBefore: reachedFurther ? cached.hasMoreBefore : fresh.hasMoreBefore,
    lastSeq: Math.max(cached.lastSeq, fresh.lastSeq),
  };
}

/** 任务状态写回触发消息的状态行（按任务 id 替换；还没有就追加）。找不到触发消息时原样返回。 */
export function applyRunToMessages(data: MessagesData, run: AgentRunSummaryDto): MessagesData {
  let changed = false;
  const items = data.items.map((item) => {
    if (item.id !== run.triggerMessageId) return item;
    changed = true;
    const exists = item.runs.some((entry) => entry.id === run.id);
    return {
      ...item,
      runs: exists ? item.runs.map((entry) => (entry.id === run.id ? run : entry)) : [...item.runs, run],
    };
  });
  return changed ? { ...data, items } : data;
}

/** 补拉起点：本地最大序号；还有排队 / 执行中的任务时从那条消息之前开始，顺带刷新它的状态（限 200 条以内）。 */
export function catchUpAfter(data: MessagesData): number {
  const top = data.items.length === 0 ? data.lastSeq : maxSeq(data.items);
  let from = top;
  for (const item of data.items) {
    if (item.runs.some((run) => run.status === "queued" || run.status === "running")) {
      from = Math.min(from, item.seq - 1);
      break;
    }
  }
  return Math.max(from, top - 200, 0);
}

/** 主消息流只显示话题根与普通消息；回复在话题面板里看。 */
export function rootMessages(items: readonly RoomMessageDto[]): RoomMessageDto[] {
  return items.filter((item) => item.threadRootId === null);
}

// ───────────────────────────── 房间列表与未读 ─────────────────────────────

export function messageAuthorName(
  message: Pick<RoomMessageDto, "agent" | "author" | "authorKind">,
  t: Messages = messagesFor(currentLocale()),
): string {
  if (message.agent !== null) return agentName(message.agent, t);
  if (message.authorKind === "system") return t.rooms.message.systemAuthor;
  return message.author?.displayName ?? t.rooms.message.someone;
}

/** 只有附件时的预览：「[图片]」「[视频]」「[文件] 名」，多个附件时接「等 N 个」。 */
function filesPreview(first: Pick<RoomFileDto, "fileName" | "kind">, count: number, t: Messages): string {
  const head =
    first.kind === "image" ? t.rooms.preview.image : first.kind === "video" ? t.rooms.preview.video : t.rooms.preview.file(first.fileName);
  return count > 1 ? t.rooms.preview.more(head, count) : head;
}

export function messagePreview(message: Pick<RoomMessageDto, "body" | "files">, t: Messages = messagesFor(currentLocale())): string {
  const text = summaryPreview(message.body, 80);
  if (text !== "") return text;
  const file = message.files[0];
  return file === undefined ? "" : filesPreview(file, message.files.length, t);
}

/**
 * 推送来的新消息在房间列表里的「最后一条」：与云端同形（结构化字段 + 兜底文字），
 * 显示时与云端给的走同一套渲染（lastMessageAuthor / lastMessagePreview）。
 */
export function lastMessageOf(message: RoomMessageDto, t: Messages = messagesFor(currentLocale())): RoomLastMessageDto {
  const first = message.files[0];
  return {
    seq: message.seq,
    authorName: messageAuthorName(message, t),
    preview: messagePreview(message, t),
    createdAt: message.createdAt,
    authorKind: message.authorKind,
    agent: message.agent === null ? null : { ownerName: message.agent.owner.displayName, deviceName: message.agent.deviceName },
    text: summaryPreview(message.body, 80),
    firstFile: first === undefined ? null : { fileName: first.fileName, kind: first.kind },
    fileCount: message.files.length,
  };
}

/**
 * 「最后一条」的作者（中英双语技术设计 §4.3）：Agent 与系统按结构化字段用当前语言渲染，真人就是名字；
 * 老云端没有结构化字段时显示兜底文字。
 */
export function lastMessageAuthor(last: RoomLastMessageDto, t: Messages = messagesFor(currentLocale())): string {
  if (last.authorKind === "agent" && last.agent != null) return t.rooms.agent.name(last.agent.ownerName);
  if (last.authorKind === "system") return t.rooms.message.systemAuthor;
  return last.authorName;
}

/** 「最后一条」的预览：有正文给正文，只有附件时按第一个附件与附件数用当前语言渲染；老云端没有结构化字段时显示兜底文字。 */
export function lastMessagePreview(last: RoomLastMessageDto, t: Messages = messagesFor(currentLocale())): string {
  if (last.text === undefined) return last.preview;
  if (last.text !== "") return last.text;
  return last.firstFile == null ? last.preview : filesPreview(last.firstFile, last.fileCount ?? 1, t);
}

/** 这条消息是否提醒到我：@ 了我，或 @ 所有人。 */
export function mentionsUser(mentions: readonly RoomMentionDto[], userId: string | null): boolean {
  return mentions.some((mention) => mention.kind === "all" || (mention.kind === "user" && mention.id === userId));
}

/**
 * 新消息进来时房间列表的变化：最大序号、最后一条；别人发的、序号大于本地已读、我没在看这个房间时未读 +1
 * （@ 我再 +1 提醒）。推送是广播、不带我的未读，所以由这里自己算；真值在服务端，下一次列表刷新会校正。
 * 同一条只能算一次：由调用方按消息 id 去重（cache.ts 的 firstArrival），这里不比「房间最大序号」——
 * 推送可能乱序（较早的一条晚到），广播里的房间最大序号也可能先于消息到达，比序号会少算未读。
 */
export function roomAfterMessage(
  room: RoomDto,
  message: RoomMessageDto,
  context: { meId: string | null; reading: boolean },
): RoomDto {
  const mine = message.authorKind === "user" && message.author !== null && message.author.id === context.meId;
  // 没加入的需求房间未读恒为 0（服务端口径）；自己发言后自动成为成员。
  const counts =
    room.viewer.joined && !mine && !context.reading && message.authorKind !== "system" && message.seq > room.viewer.lastReadSeq;
  return {
    ...room,
    lastSeq: Math.max(room.lastSeq, message.seq),
    lastMessage:
      room.lastMessage !== null && room.lastMessage.seq > message.seq ? room.lastMessage : lastMessageOf(message),
    viewer: {
      ...room.viewer,
      joined: room.viewer.joined || mine,
      lastReadSeq: mine ? Math.max(room.viewer.lastReadSeq, message.seq) : room.viewer.lastReadSeq,
      unreadCount: room.viewer.unreadCount + (counts ? 1 : 0),
      mentionCount: room.viewer.mentionCount + (counts && mentionsUser(message.mentions, context.meId) ? 1 : 0),
    },
  };
}

/** 记已读后（读到 upToSeq）房间列表的本地变化。 */
export function roomAfterRead(room: RoomDto, upToSeq: number): RoomDto {
  if (upToSeq <= room.viewer.lastReadSeq) return room;
  const caughtUp = upToSeq >= room.lastSeq;
  return {
    ...room,
    viewer: {
      ...room.viewer,
      lastReadSeq: upToSeq,
      unreadCount: caughtUp ? 0 : room.viewer.unreadCount,
      mentionCount: caughtUp ? 0 : room.viewer.mentionCount,
    },
  };
}

/** 房间列表顺序：项目默认房间最上；其余按最近活动倒序；归档的另放（界面折叠在底部）。 */
export function sortRooms(rooms: readonly RoomDto[]): { active: RoomDto[]; archived: RoomDto[] } {
  const activity = (room: RoomDto) => Date.parse(room.lastMessage?.createdAt ?? room.createdAt) || 0;
  const ordered = rooms.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "project_default" ? -1 : 1;
    return activity(right) - activity(left);
  });
  return {
    active: ordered.filter((room) => room.archivedAt === null),
    archived: ordered.filter((room) => room.archivedAt !== null),
  };
}

export function totalUnread(rooms: readonly RoomDto[] | undefined): number {
  if (rooms === undefined) return 0;
  return rooms.reduce((sum, room) => sum + (room.archivedAt === null ? Math.max(0, room.viewer.unreadCount) : 0), 0);
}

/** 未归档的房间里有没有 @ 我（含 @ 所有人）还没看的。 */
export function hasUnreadMention(rooms: readonly RoomDto[] | undefined): boolean {
  return (rooms ?? []).some((room) => room.archivedAt === null && room.viewer.mentionCount > 0);
}

/**
 * 悬浮入口与需求预览面板里的房间顺序（快捷入口需求 R1）：只列未归档的；
 * @ 我的 > 有未读的 > 其余，同一档里按最近消息（没有消息按创建时间）倒序。
 */
export function quickAccessRooms(rooms: readonly RoomDto[]): RoomDto[] {
  const rank = (room: RoomDto) => (room.viewer.mentionCount > 0 ? 0 : room.viewer.unreadCount > 0 ? 1 : 2);
  const activity = (room: RoomDto) => Date.parse(room.lastMessage?.createdAt ?? room.createdAt) || 0;
  return rooms
    .filter((room) => room.archivedAt === null)
    .toSorted((left, right) => rank(left) - rank(right) || activity(right) - activity(left));
}

/** 房间在列表、标题里的称呼：默认房间「# 项目名」，需求房间就是它的名字（编号另显示）。 */
export function roomTitle(room: Pick<RoomDto, "kind" | "name">): string {
  return room.kind === "project_default" ? `# ${room.name}` : room.name;
}

export function roomRequirementCode(room: Pick<RoomDto, "requirement">): string | null {
  return room.requirement === null ? null : formatRequirementNumber(room.requirement.number);
}

// ───────────────────────────── Agent 与任务 ─────────────────────────────

/** 「陈思远 的 Codex」：Agent 在消息、状态行里的名字（设备名只在需要区分时显示）。 */
export function agentName(agent: Pick<AgentSummaryDto, "owner">, t: Messages = messagesFor(currentLocale())): string {
  return t.rooms.agent.name(agent.owner.displayName);
}

/** 「陈思远 的 Codex · MacBook Pro」：需要区分设备时（@ 候选、共享面板）的名字，按界面语言（不用云端的标签）。 */
export function agentLabel(agent: Pick<AgentSummaryDto, "owner" | "deviceName">, t: Messages = messagesFor(currentLocale())): string {
  return t.rooms.agent.withDevice(agent.owner.displayName, agent.deviceName);
}

/** 任务状态名（取代云端契约的 AGENT_RUN_STATUS_LABELS，按界面语言）。 */
export function runStatusLabel(status: AgentRunStatus, t: Messages = messagesFor(currentLocale())): string {
  return t.rooms.run.status[status];
}

/**
 * 执行中的进度（中英双语技术设计 §4.3）：认得出 code 时按当前语言说（与会话时间线的步骤组摘要同一套说法），
 * 没有 code（旧数据、老版本本机写的）或认不出时显示 `progress` 原文。
 */
export function runProgressText(
  run: Pick<AgentRunSummaryDto, "progress" | "progressCode" | "progressParams">,
  t: Messages = messagesFor(currentLocale()),
): string | null {
  const progress = readAgentRunProgress(run.progressCode, run.progressParams);
  if (progress === null) return run.progress;
  if (progress.code === "thinking") return t.conversation.status.thinking;
  const counts = progress.params;
  return AGENT_RUN_ACTIVITY_KINDS.flatMap((kind) => {
    const count = counts[kind];
    return count === undefined ? [] : [t.conversation.summary[kind](count)];
  }).join(" · ");
}

/**
 * 失败 / 停止 / 离线的原因（中英双语技术设计 §4.3）：认得出 code 时按当前语言说，参数里的路径、报错原文原样嵌进去；
 * 没有 code（旧数据、老版本写的）或认不出时显示 `reason` 原文。
 */
export function runReasonText(
  run: Pick<AgentRunSummaryDto, "reason" | "reasonCode" | "reasonParams">,
  t: Messages = messagesFor(currentLocale()),
): string | null {
  const reason = readAgentRunReason(run.reasonCode, run.reasonParams);
  if (reason === null) return run.reason;
  const text = t.rooms.run.reason;
  switch (reason.code) {
    case "local_folder_unavailable":
      return text.local_folder_unavailable(reason.params.path);
    case "stalled":
      return text.stalled(reason.params.minutes);
    case "local_start_failed":
    case "run_error":
    case "reply_rejected":
      return text[reason.code](reason.params.detail);
    case "turn_failed": {
      const params = reason.params;
      if ("codexError" in params) return text.turn_failed.codexError[params.codexError];
      if ("category" in params) return text.turn_failed.category[params.category];
      if ("detail" in params) return text.turn_failed.detail(params.detail);
      return text.turn_failed.unknown;
    }
    default:
      return text[reason.code];
  }
}

/** 状态行文字：状态名 + 排队位置 / 进度 / 摘要 / 原因（摘要是所有者本机写的文字，原样显示）。 */
export function runStatusText(run: AgentRunSummaryDto, t: Messages = messagesFor(currentLocale())): string {
  const label = runStatusLabel(run.status, t);
  if (run.stopRequested && (run.status === "queued" || run.status === "running")) return t.rooms.run.stopping;
  switch (run.status) {
    case "queued":
      return run.queuePosition !== null && run.queuePosition > 0 ? t.rooms.run.queuedAhead(label, run.queuePosition) : label;
    case "running": {
      const progress = runProgressText(run, t);
      return progress !== null && progress !== "" ? `${label} · ${progress}` : label;
    }
    case "completed":
      return run.summary !== null && run.summary !== "" ? `${label} · ${run.summary}` : label;
    case "failed":
    case "stopped":
    case "offline": {
      const reason = runReasonText(run, t);
      return reason !== null && reason !== "" ? `${label} · ${reason}` : label;
    }
  }
}

export function isRunActive(run: Pick<AgentRunSummaryDto, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

/** 停止：触发人或 Agent 所有者，且任务还在排队或执行。 */
export function canStopRun(run: AgentRunSummaryDto, meId: string | null): boolean {
  return meId !== null && isRunActive(run) && !run.stopRequested && (run.triggeredBy.id === meId || run.agent.owner.id === meId);
}

/** 重试：只有触发人，任务失败、已停止或离线未执行。 */
export function canRetryRun(run: AgentRunSummaryDto, meId: string | null): boolean {
  return meId !== null && run.triggeredBy.id === meId && (run.status === "failed" || run.status === "stopped" || run.status === "offline");
}

/** 用时：开始到结束（还在执行就到现在）；还没开始为 null。 */
export function runElapsedMs(run: Pick<AgentRunSummaryDto, "startedAt" | "finishedAt">, now: number): number | null {
  if (run.startedAt === null) return null;
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// ───────────────────────────── 共享 ─────────────────────────────

export function activeShares(shares: readonly AgentShareDto[] | undefined): AgentShareDto[] {
  return (shares ?? []).filter((share) => share.active);
}

/** 「今天」到期：浏览器本地当天 23:59:59（服务端只接受未来 24 小时内的值）。 */
export function endOfLocalDay(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 0).toISOString();
}

/**
 * 已开着的共享是按哪一档开的（面板据此选中，不再每次回到默认档）：没有到期时间 = 直到我关闭；
 * 到期在本地某天 23:59:59 = 今天（浏览器给的当天结束）；其余 = 2 小时。
 */
export function shareDurationOf(expiresAt: string | null): AgentShareDuration {
  if (expiresAt === null) return "until_closed";
  const date = new Date(expiresAt);
  return date.getHours() === 23 && date.getMinutes() === 59 && date.getSeconds() === 59 ? "today" : "two_hours";
}

export function expiresLabel(expiresAt: string | null, now: Date = new Date(), t: Messages = messagesFor(currentLocale())): string {
  if (expiresAt === null) return t.rooms.share.expires.untilClosed;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return t.rooms.share.expires.until(sameDay ? formatClock(date) : `${formatMonthDay(date)} ${formatClock(date)}`);
}

// ───────────────────────────── @ 候选 ─────────────────────────────

export type AgentAvailability = "available" | "offline" | "unshared";

export type MentionCandidate =
  | { kind: "user"; id: string; text: string; user: UserSummaryDto; online: boolean }
  | { kind: "all"; id: null; text: string }
  | {
      kind: "agent";
      id: string;
      text: string;
      agent: AgentDto;
      availability: AgentAvailability;
      mine: boolean;
      /** 我已申请过、还没处理。 */
      requested: boolean;
    };

/**
 * 「@ 所有人」插进正文的文字（中英双语技术设计 §4.3）：按发送者的界面语言（「所有人」/ everyone）；
 * 高亮按提及的 kind，正文里 @所有人 / @everyone 都认。
 */
export function mentionAllText(t: Messages = messagesFor(currentLocale())): string {
  return t.rooms.mention.text.everyone;
}

/**
 * 插进输入框的 @ 文字：人用名字；Agent 按发送者的界面语言写（中文「陈思远的Codex」，英文 “Sam's Codex”），
 * 同一个人有多台设备时带设备名。高亮不靠它与云端标签对上：按 Agent 的所有者名与设备名把各语言的写法都认（mentionHighlights）。
 */
export function agentMentionText(agent: AgentDto, all: readonly AgentDto[], t: Messages = messagesFor(currentLocale())): string {
  const sameOwner = all.filter((item) => item.owner.id === agent.owner.id).length > 1;
  return t.rooms.mention.text.agent(agent.owner.displayName, sameOwner ? agent.deviceName : null);
}

export function agentAvailability(agent: AgentDto, shares: readonly AgentShareDto[]): AgentAvailability {
  const shared = shares.some((share) => share.active && share.agent.id === agent.id);
  if (!shared) return "unshared";
  return agent.online ? "available" : "offline";
}

/**
 * @ 候选：真人在前（不含自己），然后「所有人」，Agent 在后（可用 → 未共享 → 离线）。
 * query 为 @ 后面已输入的字（不含 @），按包含匹配。
 */
export function buildMentionCandidates(
  input: {
    members: readonly RoomMemberDto[];
    agents: readonly AgentDto[];
    shares: readonly AgentShareDto[];
    requestedAgentIds: ReadonlySet<string>;
    meId: string | null;
    query: string;
  },
  t: Messages = messagesFor(currentLocale()),
): MentionCandidate[] {
  const query = input.query.trim().toLowerCase();
  const matches = (...texts: string[]) => query === "" || texts.some((text) => text.toLowerCase().includes(query));
  // 按任一语言的叫法都能搜到（中文界面打 everyone、英文界面打「所有人」也行）。
  const dictionaries = LOCALES.map(messagesFor);
  const users: MentionCandidate[] = input.members
    .filter((member) => member.user.id !== input.meId && matches(member.user.displayName))
    .toSorted((left, right) => Number(right.online) - Number(left.online))
    .map((member) => ({ kind: "user", id: member.user.id, text: member.user.displayName, user: member.user, online: member.online }));
  const everyone = mentionAllText(t);
  const all: MentionCandidate[] = matches(...dictionaries.map(mentionAllText), "all")
    ? [{ kind: "all", id: null, text: everyone }]
    : [];
  const rank: Record<AgentAvailability, number> = { available: 0, unshared: 1, offline: 2 };
  const agents: MentionCandidate[] = input.agents
    .map((agent) => ({
      kind: "agent" as const,
      id: agent.id,
      text: agentMentionText(agent, input.agents, t),
      agent,
      availability: agentAvailability(agent, input.shares),
      mine: agent.owner.id === input.meId,
      requested: input.requestedAgentIds.has(agent.id),
    }))
    .filter((candidate) =>
      matches(
        candidate.text,
        ...dictionaries.map((messages) => agentLabel(candidate.agent, messages)),
        candidate.agent.label,
        candidate.agent.owner.displayName,
        "codex",
      ),
    )
    .toSorted((left, right) => rank[left.availability] - rank[right.availability]);
  return [...users, ...all, ...agents];
}

/** @ 选择框里 Agent 的说明文字。 */
export function agentAvailabilityNote(
  candidate: Extract<MentionCandidate, { kind: "agent" }>,
  t: Messages = messagesFor(currentLocale()),
): string {
  const note = t.rooms.mention.agentNote;
  if (candidate.availability === "available") return note.available;
  if (candidate.availability === "offline") return note.offline;
  if (candidate.mine) return note.unsharedMine;
  return candidate.requested ? note.unsharedRequested : note.unsharedRequest;
}

/**
 * 从云端 Agent 标签里取回所有者名与设备名（认不出时为 null）。云端标签与各语言的 agent.withDevice 同形：
 * 新云端是英文 “Sam's Codex · MacBook Pro”，老云端（与旧消息里存下的）是中文「陈思远 的 Codex · MacBook Pro」，
 * 所以由字典反推出各语言的形状来认，不另写一份。
 */
function parseAgentLabel(label: string): { owner: string; device: string } | null {
  for (const locale of LOCALES) {
    const sample = messagesFor(locale).rooms.agent.withDevice("\u0001", "\u0002");
    const pattern = sample
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace("\u0001", "(?<owner>.+?)")
      .replace("\u0002", "(?<device>.+)");
    const groups = new RegExp(`^${pattern}$`, "u").exec(label)?.groups;
    const owner = groups?.["owner"];
    const device = groups?.["device"];
    if (owner !== undefined && device !== undefined) return { owner, device };
  }
  return null;
}

/**
 * 消息正文里要高亮的 @ 文字（中英双语技术设计 §4.3：按提及的 kind）：
 * - 所有人：各语言插进正文的写法（@所有人 / @everyone）都认；
 * - Agent：按 mention.id 在 Agent 列表里找到所有者名与设备名，拼出各语言插进正文的写法（带不带设备名）；
 *   找不到（旧消息、列表没取到、Agent 已删）或改过名时由云端标签推导所有者名与设备名，同样拼出各语言的写法；
 * - 另外都认云端标签本身及其常见写法（去掉设备名、去掉空格），兼容老客户端插进正文的文字。
 */
export function mentionHighlights(
  mentions: readonly RoomMentionDto[],
  agents: readonly Pick<AgentSummaryDto, "id" | "owner" | "deviceName">[] = [],
): string[] {
  const set = new Set<string>();
  const add = (text: string) => {
    if (text.trim() !== "") set.add(text);
  };
  const dictionaries = LOCALES.map(messagesFor);
  const addAgentTexts = (owner: string, device: string) => {
    for (const messages of dictionaries) {
      add(messages.rooms.mention.text.agent(owner, null));
      add(messages.rooms.mention.text.agent(owner, device));
    }
  };
  for (const mention of mentions) {
    if (mention.kind === "all") for (const messages of dictionaries) add(mentionAllText(messages));
    const label = mention.label.trim();
    if (mention.kind === "agent") {
      const agent = agents.find((item) => item.id === mention.id);
      if (agent !== undefined) addAgentTexts(agent.owner.displayName, agent.deviceName);
      const parsed = parseAgentLabel(label);
      if (parsed !== null) addAgentTexts(parsed.owner, parsed.device);
    }
    if (label === "") continue;
    const head = label.split(" · ")[0] ?? label;
    for (const text of [label, head, label.replace(/\s+/g, ""), head.replace(/\s+/g, "")]) add(text);
  }
  return [...set].toSorted((left, right) => right.length - left.length);
}

