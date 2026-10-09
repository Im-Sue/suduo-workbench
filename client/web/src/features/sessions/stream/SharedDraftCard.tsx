import type { SharedDraftSummaryDto } from "@suduo/client-contracts";
import { CheckIcon, FileTextIcon, ShieldAlertIcon, UploadIcon } from "lucide-react";
import { useShare } from "../../collab/share-context.js";
import { useT } from "../../../i18n/provider.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 时间线上的共享对象草稿卡（多 Agent 协作 S11）：交接包（Agent 用 handoff_submit 交的草稿）、评审报告、会话快照。
 * 草稿给「预览并发布」；疑似密钥有命中时标出处数；发布后标「已发布到需求」。
 */
export function SharedDraftCard({ draft }: { draft: SharedDraftSummaryDto }) {
  const t = useT();
  const text = t.collab.share;
  const share = useShare();
  const kind = text.kinds[draft.kind] ?? draft.kind;
  return (
    <section className="flex min-h-9 flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-small" data-testid="shared-draft-card" data-status={draft.status} data-kind={draft.kind}>
      <FileTextIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <span className="font-medium text-foreground">{kind}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={draft.title}>
        {draft.title}
      </span>
      {draft.status === "draft" && draft.secretHitCount > 0 ? (
        <span className="inline-flex items-center gap-1 text-caption text-warning">
          <ShieldAlertIcon className="size-3" aria-hidden="true" />
          {text.card.secrets(draft.secretHitCount)}
        </span>
      ) : null}
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-caption",
          draft.status === "published" ? "bg-success-soft text-success" : "bg-muted text-muted-foreground",
        )}
      >
        {draft.status === "published" ? <CheckIcon className="size-3" aria-hidden="true" /> : null}
        {text.card[draft.status]}
      </span>
      {draft.status !== "discarded" && share.canPublish ? (
        <Button size="sm" variant={draft.status === "draft" ? "secondary" : "ghost"} onClick={() => share.openDraft(draft.id)} data-testid="shared-draft-open">
          <UploadIcon />
          {draft.status === "draft" ? text.card.open : text.card.republish}
        </Button>
      ) : null}
    </section>
  );
}
