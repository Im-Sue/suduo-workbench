import { Link } from "@tanstack/react-router";
import type { DelegationDto } from "@suduo/client-contracts";
import { CheckIcon, ClockIcon, CornerDownLeftIcon, ExternalLinkIcon, HandIcon, SplitIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { api } from "../../../api/client.js";
import { reportFailure } from "../../../feedback/report.js";
import { useT } from "../../../i18n/provider.js";
import { Markdown } from "../../../ui/markdown.js";
import { StallNote } from "../../collab/StallNote.js";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const ACTIVE = new Set<DelegationDto["status"]>(["queued", "running"]);

/**
 * 发起会话里的委派卡片（多 Agent 协作 S8，需求 4.3）：Agent、任务、状态（排队中 / 运行中 / 等审批 / 已完成 / 失败 / 已取消），
 * 可以停止、打开子会话；做完后显示结果（最终回答、改动文件），没交回时给「让原 Agent 继续」。
 */
export function DelegationCard({ delegation }: { delegation: DelegationDto }) {
  const t = useT();
  const text = t.collab.delegation;
  const [busy, setBusy] = useState<"stop" | "handback" | null>(null);
  const active = ACTIVE.has(delegation.status);
  const waiting = active && delegation.pendingApprovals > 0;
  const run = async (kind: "stop" | "handback") => {
    setBusy(kind);
    try {
      if (kind === "stop") await api.cancelDelegation(delegation.id);
      else await api.handbackDelegation(delegation.id);
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: kind === "stop" ? text.failures.stop : text.failures.handback });
    } finally {
      setBusy(null);
    }
  };
  const result = delegation.result;
  return (
    <section
      className="rounded-md border border-border bg-card"
      data-testid="delegation-card"
      data-delegation-id={delegation.id}
      data-status={delegation.status}
    >
      <header className="flex min-h-9 flex-wrap items-center gap-2 px-3 py-1.5 text-small">
        <SplitIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <span className="font-medium text-foreground">{text.title(delegation.agentName)}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={delegation.task}>
          {delegation.task}
        </span>
        <StatusBadge delegation={delegation} />
      </header>
      <div className="flex flex-col gap-2 border-t border-border px-3 py-2 text-small">
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-subtle-foreground">
          <span>{delegation.origin === "user" ? text.fromUser : text.fromAgent}</span>
          {delegation.autoHandback ? <span>{text.autoHandback}</span> : null}
          {waiting ? (
            <span className="inline-flex items-center gap-1 text-warning" data-testid="delegation-waiting">
              <HandIcon className="size-3" aria-hidden="true" />
              {text.waitingApproval(delegation.pendingApprovals)}
            </span>
          ) : null}
          {active ? <StallNote stall={delegation.stalled} /> : null}
        </p>
        {delegation.error === null ? null : <p className="m-0 text-caption text-danger">{text.error(delegation.error)}</p>}
        {result === null || active ? null : (
          <div className="flex flex-col gap-1" data-testid="delegation-result">
            <span className="text-caption font-medium text-muted-foreground">{text.finalMessage}</span>
            <div className="max-h-48 overflow-y-auto rounded-sm bg-muted px-2.5 py-1.5 text-foreground">
              {result.finalMessage === null ? <span className="text-muted-foreground">{text.noFinalMessage}</span> : <Markdown text={result.finalMessage} />}
            </div>
            {result.changedFiles.length === 0 ? null : (
              <span className="text-caption text-muted-foreground" title={result.changedFiles.map((file) => file.path).join("\n")}>
                {text.changedFiles(result.changedFiles.length, result.additions, result.deletions)}
              </span>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {delegation.childSessionId === null ? (
            <span className="text-caption text-subtle-foreground">{text.childDeleted}</span>
          ) : (
            <Button asChild size="sm" variant="ghost">
              <Link to="/sessions/$sessionId" params={{ sessionId: delegation.childSessionId }} data-testid="delegation-open">
                <ExternalLinkIcon />
                {text.open}
              </Link>
            </Button>
          )}
          {active ? (
            <Button size="sm" variant="secondary" loading={busy === "stop"} data-testid="delegation-stop" onClick={() => void run("stop")}>
              <SquareIcon />
              {text.stop}
            </Button>
          ) : null}
          {!active && delegation.status !== "cancelled" && !delegation.delivered ? (
            <Button size="sm" variant="primary" loading={busy === "handback"} data-testid="delegation-handback" onClick={() => void run("handback")}>
              <CornerDownLeftIcon />
              {text.handback}
            </Button>
          ) : null}
          {!active && delegation.delivered ? <span className="text-caption text-subtle-foreground">{text.handedBack}</span> : null}
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ delegation }: { delegation: DelegationDto }) {
  const t = useT();
  const status = delegation.status;
  const Icon = status === "completed" ? CheckIcon : status === "queued" ? ClockIcon : status === "running" ? null : TriangleAlertIcon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-0.5 text-caption",
        status === "completed" ? "bg-success-soft text-success" : status === "failed" || status === "interrupted" ? "bg-danger-soft text-danger" : "bg-muted text-muted-foreground",
      )}
      data-testid="delegation-status"
    >
      {status === "running" ? <Spinner size="sm" /> : Icon === null ? null : <Icon className="size-3" aria-hidden="true" />}
      {t.collab.delegation.status[status]}
    </span>
  );
}

/** 排队中的消息（多 Agent 协作 S8）：轮到前一直显示、可以取消；开起来或没发出后不再显示（流里另有说明）。 */
export function QueuedRow({ itemId }: { itemId: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <p className="m-0 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-small text-muted-foreground" data-testid="stream-queued" role="status">
      <ClockIcon className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words">{t.collab.queue.queued}</span>
      {itemId === "" ? null : (
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          data-testid="queued-cancel"
          onClick={() => {
            setBusy(true);
            void api
              .cancelSchedulerItem(itemId)
              .catch((cause: unknown) => reportFailure(cause, { surface: "action", title: t.collab.queue.cancelFailed }))
              .finally(() => setBusy(false));
          }}
        >
          {t.collab.queue.cancel}
        </Button>
      )}
    </p>
  );
}
