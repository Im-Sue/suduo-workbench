import type { AgentRunStatus, AgentRunSummaryDto } from "@suduo/cloud-contracts";
import { BotIcon, CheckIcon, ChevronRightIcon, ClockIcon, RotateCcwIcon, SquareIcon, WifiOffIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatDuration } from "../../../ui/format.js";
import { useT } from "../../../i18n/provider.js";
import {
  agentName,
  canRetryRun,
  canStopRun,
  isRunActive,
  runElapsedMs,
  runProgressText,
  runReasonText,
  runStatusLabel,
  runStatusText,
} from "../model.js";
import { useRunAction } from "../queries.js";

/**
 * 被 @ 的 Agent 在消息下的一行状态（需求 4.7 第一层）：
 * 「陈思远 的 Codex · 排队中（前面还有 2 个）/ 执行中 · 查看了 6 个文件 / ✓ 已完成 · 摘要 / 失败 · 原因 / 已停止 / 离线，未执行」。
 * 点这一行打开话题面板；停止（触发人或所有者）、重试（触发人）按契约的授权显示。
 */
export function RunIcon({ status, className }: { status: AgentRunStatus; className?: string }) {
  const base = cn("size-3.5 shrink-0", className);
  switch (status) {
    case "queued":
      return <ClockIcon className={cn(base, "text-subtle-foreground")} aria-hidden="true" />;
    case "running":
      return <Spinner size="sm" className="text-primary" />;
    case "completed":
      return <CheckIcon className={cn(base, "text-success")} aria-hidden="true" />;
    case "failed":
      return <XIcon className={cn(base, "text-danger")} aria-hidden="true" />;
    case "stopped":
      return <SquareIcon className={cn(base, "text-subtle-foreground")} aria-hidden="true" />;
    case "offline":
      return <WifiOffIcon className={cn(base, "text-subtle-foreground")} aria-hidden="true" />;
  }
}

function RunActions({ run, meId }: { run: AgentRunSummaryDto; meId: string | null }) {
  const t = useT();
  const action = useRunAction();
  const busy = action.isPending && action.variables?.run.id === run.id;
  return (
    <>
      {canStopRun(run, meId) ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          loading={busy && action.variables?.action === "stop"}
          aria-label={t.rooms.run.stopLabel(agentName(run.agent, t))}
          data-testid="run-stop"
          onClick={() => action.mutate({ run, action: "stop" })}
        >
          <SquareIcon className="size-3" />
          {t.rooms.run.stop}
        </Button>
      ) : null}
      {canRetryRun(run, meId) ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          loading={busy && action.variables?.action === "retry"}
          aria-label={t.rooms.run.retryLabel(agentName(run.agent, t))}
          data-testid="run-retry"
          onClick={() => action.mutate({ run, action: "retry" })}
        >
          <RotateCcwIcon className="size-3" />
          {t.rooms.run.retry}
        </Button>
      ) : null}
    </>
  );
}

export function RunStatusLine({ run, meId, onOpen }: { run: AgentRunSummaryDto; meId: string | null; onOpen(): void }) {
  const t = useT();
  const text = runStatusText(run, t);
  const name = agentName(run.agent, t);
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1 text-caption" data-testid="run-status" data-status={run.status} data-run-id={run.id}>
      <button
        type="button"
        className={cn(
          "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          run.status === "failed" ? "text-danger" : "text-muted-foreground",
        )}
        aria-label={t.rooms.run.lineLabel(name, text)}
        onClick={onOpen}
      >
        <RunIcon status={run.status} />
        <BotIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">{name}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate">{text}</span>
        <ChevronRightIcon className="size-3 shrink-0 text-subtle-foreground" aria-hidden="true" />
      </button>
      <RunActions run={run} meId={meId} />
    </div>
  );
}

/** 每秒走一次的「现在」：只在任务执行中时启用。 */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

/** 话题面板里的任务状态卡（需求 4.7 第二层）：状态、用时、「查看详情」。 */
export function RunCard({ run, meId, onViewDetail }: { run: AgentRunSummaryDto; meId: string | null; onViewDetail(): void }) {
  const t = useT();
  const now = useTicker(run.status === "running");
  const elapsed = runElapsedMs(run, now);
  const detail =
    run.status === "running"
      ? runProgressText(run, t)
      : run.status === "completed"
        ? run.summary
        : run.status === "queued"
          ? run.queuePosition !== null && run.queuePosition > 0
            ? t.rooms.run.ahead(run.queuePosition)
            : null
          : runReasonText(run, t);
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-md border bg-card px-3 py-2 text-small",
        run.status === "failed" ? "border-danger/40" : "border-border",
      )}
      data-testid="run-card"
      data-status={run.status}
      data-run-id={run.id}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RunIcon status={run.status} />
        <span className="min-w-0 truncate font-medium text-foreground">{agentName(run.agent, t)}</span>
        <span className={cn("shrink-0", run.status === "failed" ? "text-danger" : "text-muted-foreground")}>
          {run.stopRequested && isRunActive(run) ? t.rooms.run.stopping : runStatusLabel(run.status, t)}
        </span>
        {elapsed === null || elapsed < 1_000 ? null : (
          <span className="shrink-0 text-caption text-subtle-foreground">{t.rooms.run.elapsed(formatDuration(elapsed))}</span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="link" className="shrink-0 text-caption" onClick={onViewDetail} data-testid="run-view-detail">
          {t.rooms.run.viewDetail}
          <ChevronRightIcon className="size-3" />
        </Button>
      </div>
      {detail === null || detail === "" ? null : (
        <p className="m-0 text-caption break-words text-muted-foreground">{detail}</p>
      )}
      <div className="-ml-1.5 flex items-center gap-1 empty:hidden">
        <RunActions run={run} meId={meId} />
      </div>
    </div>
  );
}
