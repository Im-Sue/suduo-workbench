import { useQuery } from "@tanstack/react-query";
import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { projectEvents } from "../../../event-projection/reducer.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { EmptyState, RegionError } from "../../../feedback/components/index.js";
import { formatDuration } from "../../../ui/format.js";
import { useT } from "../../../i18n/provider.js";
import { ConversationStream } from "../../sessions/stream/ConversationStream.js";
import { agentName, runElapsedMs, runReasonText, runStatusLabel } from "../model.js";
import { runQuery } from "../queries.js";
import { RunIcon, useTicker } from "./RunStatusLine.js";

/**
 * 运行详情（需求 4.7 第三层）：完整执行过程——文字、查看的文件、运行的命令及输出，
 * 与本机会话页的回合时间线同一套投影与渲染（只读，不给任何操作）。执行中随房间事件重取。
 */
export function toEnvelopes(events: readonly unknown[] | undefined): EventEnvelope<string, JsonValue>[] {
  if (events === undefined) return [];
  return events.filter((event): event is EventEnvelope<string, JsonValue> => {
    if (event === null || typeof event !== "object") return false;
    const record = event as Record<string, unknown>;
    return typeof record["type"] === "string" && typeof record["seq"] === "number";
  });
}

const NO_ACTIONS = {};

export function AgentRunDetail({ runId, onBack }: { runId: string; onBack(): void }) {
  const t = useT();
  const text = t.rooms.runDetail;
  const run = useQuery(runQuery(runId));
  const data = run.data;
  const projection = useMemo(() => projectEvents(toEnvelopes(data?.events)), [data?.events]);
  const now = useTicker(data?.status === "running");
  const elapsed = data === undefined ? null : runElapsedMs(data, now);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-detail" data-status={data?.status}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          {text.back}
        </Button>
        {data === undefined ? null : (
          <span className="flex min-w-0 items-center gap-1.5 text-small">
            <RunIcon status={data.status} />
            <span className="truncate font-medium text-foreground">{agentName(data.agent, t)}</span>
            <span className="shrink-0 text-muted-foreground">{runStatusLabel(data.status, t)}</span>
            {elapsed === null || elapsed < 1_000 ? null : (
              <span className="shrink-0 text-caption text-subtle-foreground">{t.rooms.run.elapsed(formatDuration(elapsed))}</span>
            )}
          </span>
        )}
      </div>
      {run.isPending ? (
        <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label={text.loading}>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {run.isError && data === undefined ? (
        <RegionError
          kind={classifyFailure(run.error).kind}
          message={text.loadFailed(classifyFailure(run.error).message)}
          busy={run.isFetching}
          onRetry={() => void run.refetch()}
        />
      ) : null}
      {data === undefined ? null : (
        <ConversationStream
          timeline={projection.timeline}
          historyLoading={false}
          now={now}
          actions={NO_ACTIONS}
          empty={
            <EmptyState
              title={data.status === "queued" ? text.emptyQueued : data.status === "offline" ? text.emptyOffline : text.emptyNone}
              description={data.status === "offline" ? (runReasonText(data, t) ?? text.offlineDescription) : text.emptyDescription}
            />
          }
        />
      )}
    </div>
  );
}
