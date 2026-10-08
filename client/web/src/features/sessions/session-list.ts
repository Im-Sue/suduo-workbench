import type { SessionKind, SessionListItemDto } from "@suduo/client-contracts";
import { formatRequirementNumber } from "@suduo/cloud-contracts";
import { infiniteQueryOptions, type InfiniteData } from "@tanstack/react-query";
import { isToday, isYesterday } from "date-fns";
import { api } from "../../api/client.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { sessionUiStatus, type SessionLiveRunState, type SessionUiStatus } from "../../ui/session-status.js";

/**
 * 会话列表（需求 §4.5）：会话页与侧栏只看当前项目（用户 2026-10-01 改口径），我的工作仍跨本机所有项目；
 * 按最后活动时间倒序。
 * 筛选：全部 / 运行中 / 需要我（等你确认或上一轮失败）/ 房间任务；按今天 / 昨天 / 更早分组。
 * 房间任务（共享到讨论里的 Codex 在本机执行的隐藏会话）由服务端按 kind 单独列出，普通筛选里没有它们。
 */
export type SessionFilter = "all" | "running" | "needs-me" | "room-tasks";

export const sessionKeys = {
  all: ["sessions"] as const,
  /** remoteProjectId 缺省 = 跨本机所有项目。 */
  list: (state: "active" | "archived", kind: SessionKind = "normal", remoteProjectId?: string) =>
    [
      "sessions",
      "list",
      state,
      ...(kind === "normal" ? [] : [kind]),
      ...(remoteProjectId === undefined ? [] : ["project", remoteProjectId]),
    ] as readonly string[],
  /** 会话关联的 SuDuo 上下文（所属项目、需求）。 */
  context: (sessionId: string) => ["sessions", "context", sessionId] as const,
};

const PAGE_SIZE = 50;

export function sessionListQuery(
  state: "active" | "archived" = "active",
  kind: SessionKind = "normal",
  remoteProjectId?: string,
) {
  return infiniteQueryOptions({
    queryKey: sessionKeys.list(state, kind, remoteProjectId),
    queryFn: ({ pageParam, signal }) =>
      api.listAllSessions(
        {
          state,
          ...(kind === "normal" ? {} : { kind }),
          ...(remoteProjectId === undefined ? {} : { remoteProjectId }),
          limit: PAGE_SIZE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // 运行态会变：可见时每 10 秒刷新一次（选中会话另有实时通道）。
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  });
}

export type SessionListData = InfiniteData<Awaited<ReturnType<typeof api.listAllSessions>>, unknown>;

export function flattenSessions(data: SessionListData | undefined): SessionListItemDto[] {
  if (data === undefined) return [];
  const seen = new Set<string>();
  const items: SessionListItemDto[] = [];
  for (const page of data.pages) {
    for (const item of page.items) {
      // 翻页期间会话变活跃会移到最前：以先出现的为准，不重复显示。
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/** 行状态：选中会话优先用实时通道的值，其余用列表里的运行态摘要。 */
export function rowStatus(item: SessionListItemDto, live: SessionLiveRunState | null): SessionUiStatus {
  if (live !== null && live.sessionId === item.id) {
    return sessionUiStatus(item, live.running, live.pendingApprovals, { lastTurnOutcome: live.lastTurnOutcome });
  }
  return sessionUiStatus(item, 0, 0, item.runStatus);
}

export function matchesFilter(status: SessionUiStatus, filter: SessionFilter): boolean {
  // 房间任务：列表本身就是服务端按 kind 取的，不再按状态筛。
  if (filter === "room-tasks") return true;
  if (filter === "running") return status === "running" || status === "approval";
  if (filter === "needs-me") return status === "approval" || status === "error";
  return true;
}

/** 搜索：标题、需求编号（REQ-12 / 12）、需求标题、项目名、最后一句。 */
export function matchesSearch(item: SessionListItemDto, keyword: string): boolean {
  const query = keyword.trim().toLowerCase();
  if (query === "") return true;
  const number = item.requirement?.number ?? null;
  const haystack = [
    item.title,
    item.roomTask?.roomName ?? "",
    item.requirement?.title ?? "",
    number === null ? "" : `${formatRequirementNumber(number)} ${number}`,
    item.project.name,
    item.preview?.text ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

export interface SessionGroup {
  label: string;
  items: SessionListItemDto[];
}

export function lastActivity(item: SessionListItemDto): number {
  return item.lastActivityAt ?? item.updatedAt ?? item.createdAt;
}

export function groupByDay(items: readonly SessionListItemDto[], t: Messages = messagesFor(currentLocale())): SessionGroup[] {
  const today: SessionListItemDto[] = [];
  const yesterday: SessionListItemDto[] = [];
  const earlier: SessionListItemDto[] = [];
  for (const item of items) {
    const at = new Date(lastActivity(item));
    if (isToday(at)) today.push(item);
    else if (isYesterday(at)) yesterday.push(item);
    else earlier.push(item);
  }
  return [
    { label: t.common.time.today, items: today },
    { label: t.common.time.yesterday, items: yesterday },
    { label: t.conversation.list.earlier, items: earlier },
  ].filter((group) => group.items.length > 0);
}

/** 侧栏「会话」旁的数字：需要你处理的会话数（等你确认或上一轮失败）。 */
export function attentionCount(items: readonly SessionListItemDto[], live: SessionLiveRunState | null): number {
  return items.filter((item) => matchesFilter(rowStatus(item, live), "needs-me")).length;
}
