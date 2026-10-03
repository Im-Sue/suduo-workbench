import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { localSessionsQuery } from "../queries.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";

/** 这条需求在本机的会话（速览与详情共用）。点击进入会话。 */
export function LocalSessions({
  projectId,
  requirementId,
  limit,
}: {
  projectId: string;
  requirementId: string;
  limit?: number;
}) {
  const sessions = useQuery(localSessionsQuery(projectId));
  if (sessions.isPending) {
    return <Skeleton className="h-9 w-full" />;
  }
  if (sessions.isError) {
    return <p className="m-0 text-caption text-subtle-foreground">暂时读不到本机会话</p>;
  }
  const items = sessions.data
    .filter((item) => item.requirement?.remoteRequirementId === requirementId)
    .sort((a, b) => activity(b.session) - activity(a.session));
  if (items.length === 0) {
    return <p className="m-0 text-caption text-subtle-foreground">还没有人在本机为它开过会话</p>;
  }
  const shown = limit === undefined ? items : items.slice(0, limit);
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {shown.map(({ session }) => (
        <li key={session.id}>
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: session.id }}
            className="flex h-9 items-center gap-2.5 rounded-sm bg-muted px-2.5 text-small text-foreground no-underline outline-none hover:bg-muted-strong focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MessageSquareIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{session.title || "未命名会话"}</span>
            <time className="shrink-0 text-caption text-subtle-foreground" title={formatDateTime(activity(session))}>
              {formatRelativeTime(activity(session))}
            </time>
          </Link>
        </li>
      ))}
      {shown.length < items.length ? (
        <li className="text-caption text-subtle-foreground">还有 {items.length - shown.length} 个会话</li>
      ) : null}
    </ul>
  );
}

function activity(session: { lastActivityAt: number | null; updatedAt: number }): number {
  return session.lastActivityAt ?? session.updatedAt;
}
