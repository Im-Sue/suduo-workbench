import { Link } from "@tanstack/react-router";
import type { ReviewDto, ReviewFindingDto } from "@suduo/client-contracts";
import { CheckIcon, ClockIcon, CornerDownLeftIcon, ExternalLinkIcon, ScanSearchIcon, SquareIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { reportFailure } from "../../../feedback/report.js";
import { useT } from "../../../i18n/provider.js";
import { useShare } from "../../collab/share-context.js";
import { Markdown } from "../../../ui/markdown.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { StallNote } from "../../collab/StallNote.js";

/**
 * 被评会话里的评审卡片（多 Agent 协作 S9，需求 4.4）：评审 Agent、关注点、状态；拿到结构化意见时逐条列出（严重程度、
 * 文件与行、问题、建议），勾选后「交给原 Agent 修改」；没拿到时显示评审 Agent 的最终回答（R13）。可以停止、打开评审会话。
 */
export function ReviewCard({ review }: { review: ReviewDto }) {
  const t = useT();
  const text = t.collab.review;
  const active = review.finishedAt === null;
  // 默认勾上还没交回过的高、中两级；意见换了（评审中途提交、再次提交）就按新的重新勾。
  const defaults = () =>
    new Set(review.findings.filter((finding) => (finding.severity === "high" || finding.severity === "medium") && !review.appliedFindingIds.includes(finding.id)).map((finding) => finding.id));
  const [selected, setSelected] = useState<ReadonlySet<string>>(defaults);
  const signature = `${review.summary ?? ""}|${review.findings.map((finding) => `${finding.id}:${finding.title}`).join("|")}`;
  useEffect(() => {
    setSelected(defaults());
    // 只在意见本身变化时重置（交回后 appliedFindingIds 变化不重置，由交回时清空）。
  }, [signature]);
  const [busy, setBusy] = useState<"stop" | "apply" | "publish" | null>(null);
  const share = useShare();
  /** 发布到需求（S11）：从这次评审生成评审报告草稿，交给发布对话框预览。 */
  const publish = async () => {
    setBusy("publish");
    try {
      const draft = await api.createReviewDraft(review.id);
      share.openDraft(draft.id);
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: t.collab.share.dialog.failures.load });
    } finally {
      setBusy(null);
    }
  };
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const run = async (kind: "stop" | "apply") => {
    setBusy(kind);
    try {
      if (kind === "stop") await api.cancelReview(review.id);
      else {
        await api.applyReview(review.id, [...selected]);
        setSelected(new Set());
      }
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: kind === "stop" ? text.failures.stop : text.failures.apply });
    } finally {
      setBusy(null);
    }
  };
  const chosen = review.findings.filter((finding) => selected.has(finding.id)).length;
  return (
    <section className="rounded-md border border-border bg-card" data-testid="review-card" data-review-id={review.id} data-status={review.status}>
      <header className="flex min-h-9 flex-wrap items-center gap-2 px-3 py-1.5 text-small">
        <ScanSearchIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <span className="font-medium text-foreground">{text.title(review.agentName)}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{review.focus.map((focus) => text.focus[focus] ?? focus).join(" · ")}</span>
        <StatusBadge review={review} />
      </header>
      <div className="flex flex-col gap-2 border-t border-border px-3 py-2 text-small">
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-subtle-foreground">
          <span>{review.origin === "user" ? text.fromUser : text.fromAgent}</span>
          {review.note === null ? null : <span className="min-w-0 truncate" title={review.note}>{review.note}</span>}
        </p>
        {review.status === "queued" || review.status === "running" ? (
          (review.stalled ?? null) === null ? null : (
            <p className="m-0 text-caption">
              <StallNote stall={review.stalled} />
            </p>
          )
        ) : null}
        {review.error === null ? null : <p className="m-0 text-caption text-danger">{text.error(review.error)}</p>}
        {review.summary === null ? null : (
          <p className="m-0 text-foreground" data-testid="review-summary">
            <span className="text-caption font-medium text-muted-foreground">{text.summaryLabel}</span>
            {review.summary}
          </p>
        )}
        {review.status === "submitted" && review.findings.length === 0 ? <p className="m-0 text-muted-foreground">{text.noFindings}</p> : null}
        {review.findings.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="review-findings">
            {review.findings.map((finding) => (
              <FindingRow
                key={finding.id}
                reviewId={review.id}
                finding={finding}
                applied={review.appliedFindingIds.includes(finding.id)}
                checked={selected.has(finding.id)}
                onCheckedChange={(on) => toggle(finding.id, on)}
              />
            ))}
          </ul>
        )}
        {review.status === "unstructured" ? (
          <div className="flex flex-col gap-1" data-testid="review-unstructured">
            <span className="text-caption text-warning">{text.unstructuredHint}</span>
            <div className="max-h-56 overflow-y-auto rounded-sm bg-muted px-2.5 py-1.5 text-foreground">
              {review.finalMessage === null ? <span className="text-muted-foreground">{text.noFinalMessage}</span> : <Markdown text={review.finalMessage} />}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {review.reviewerSessionId === null ? (
            review.reviewerDeleted ? <span className="text-caption text-subtle-foreground">{text.reviewerDeleted}</span> : null
          ) : (
            <Button asChild size="sm" variant="ghost">
              <Link to="/sessions/$sessionId" params={{ sessionId: review.reviewerSessionId }} data-testid="review-open">
                <ExternalLinkIcon />
                {text.open}
              </Link>
            </Button>
          )}
          {active ? (
            <Button size="sm" variant="secondary" loading={busy === "stop"} data-testid="review-stop" onClick={() => void run("stop")}>
              <SquareIcon />
              {text.stop}
            </Button>
          ) : null}
          {review.findings.length === 0 ? null : (
            <Button size="sm" variant="primary" disabled={chosen === 0} loading={busy === "apply"} data-testid="review-apply" onClick={() => void run("apply")}>
              <CornerDownLeftIcon />
              {text.apply(chosen)}
            </Button>
          )}
          {review.status === "submitted" && share.canPublish ? (
            <Button size="sm" variant="ghost" loading={busy === "publish"} data-testid="review-publish" onClick={() => void publish()}>
              <UploadIcon />
              {t.collab.share.reviewPublish}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function FindingRow({
  reviewId,
  finding,
  applied,
  checked,
  onCheckedChange,
}: {
  reviewId: string;
  finding: ReviewFindingDto;
  applied: boolean;
  checked: boolean;
  onCheckedChange(on: boolean): void;
}) {
  const t = useT();
  const text = t.collab.review;
  const id = `review-${reviewId}-${finding.id}`;
  const where = finding.file === null ? null : finding.line === null ? finding.file : `${finding.file}:${String(finding.line)}`;
  return (
    <li className="flex items-start gap-2 rounded-sm px-1 py-1 hover:bg-muted" data-testid="review-finding" data-severity={finding.severity}>
      <Checkbox id={id} className="mt-0.5" checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} data-testid="review-finding-check" />
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <SeverityBadge severity={finding.severity} />
          {where === null ? null : <code className="rounded-xs bg-muted px-1 font-mono text-caption text-muted-foreground">{where}</code>}
          <span className="font-medium text-foreground">{finding.title}</span>
          {applied ? <span className="text-caption text-subtle-foreground">{text.applied}</span> : null}
        </span>
        <span className="text-muted-foreground">{finding.detail}</span>
        {finding.suggestion === null ? null : <span className="text-caption text-subtle-foreground">{text.suggestion(finding.suggestion)}</span>}
      </label>
    </li>
  );
}

function SeverityBadge({ severity }: { severity: ReviewFindingDto["severity"] }) {
  const t = useT();
  return (
    <span
      className={cn(
        "rounded-xs px-1.5 text-caption",
        severity === "high" ? "bg-danger-soft text-danger" : severity === "medium" ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground",
      )}
    >
      {t.collab.review.severity[severity] ?? severity}
    </span>
  );
}

function StatusBadge({ review }: { review: ReviewDto }) {
  const t = useT();
  const status = review.status;
  const running = status === "running" && review.finishedAt === null;
  const Icon = status === "submitted" ? CheckIcon : status === "queued" ? ClockIcon : status === "running" ? null : TriangleAlertIcon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-0.5 text-caption",
        status === "submitted"
          ? "bg-success-soft text-success"
          : status === "failed" || status === "interrupted"
            ? "bg-danger-soft text-danger"
            : status === "unstructured"
              ? "bg-warning-soft text-warning"
              : "bg-muted text-muted-foreground",
      )}
      data-testid="review-status"
    >
      {running ? <Spinner size="sm" /> : Icon === null ? null : <Icon className="size-3" aria-hidden="true" />}
      {t.collab.review.status[status]}
    </span>
  );
}
