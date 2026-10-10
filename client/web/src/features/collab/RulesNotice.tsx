import type { SessionAiRulesDto } from "@suduo/client-contracts";
import { ScrollTextIcon } from "lucide-react";
import { useState } from "react";
import { useT } from "../../i18n/provider.js";
import { formatDateTime } from "../../ui/format.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * 项目 AI 规范有新版本（多 Agent 协作 S11，需求 4.8）：会话用的版本比项目当前的旧（或开工时还没有）时提示。
 * 先给用户看这一版的内容，确认后才发给 Agent（发的就是看过的这一版）。不提示就不占地方。
 */
export function RulesNotice({ status, onApply }: { status: SessionAiRulesDto | null; onApply(version: number): Promise<void> }) {
  const t = useT();
  const text = t.collab.share.rulesNotice;
  const [viewing, setViewing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (status === null || status.current === null) return null;
  const current = status.current;
  if (status.used !== null && status.used >= current.version) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary-soft px-4 py-1.5 text-small text-foreground" data-testid="rules-notice">
      <ScrollTextIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">{status.used === null ? text.missing(current.version) : text.newer(status.used, current.version)}</span>
      <Button size="sm" variant="secondary" onClick={() => setViewing(true)} data-testid="rules-view">
        {text.view}
      </Button>
      <Dialog open={viewing} onOpenChange={(open) => (!open && !busy ? setViewing(false) : undefined)}>
        <DialogContent size="md" data-testid="rules-dialog">
          <DialogHeader>
            <DialogTitle>{text.dialogTitle(current.version)}</DialogTitle>
            <DialogDescription>
              {text.dialogDescription(current.updatedBy, current.updatedAt === null ? null : formatDateTime(current.updatedAt))}
            </DialogDescription>
          </DialogHeader>
          <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-3 text-small text-foreground" data-testid="rules-content">
            {current.content}
          </pre>
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setViewing(false)}>
              {t.feedback.dialog.cancel}
            </Button>
            <Button
              loading={busy}
              onClick={() => {
                setBusy(true);
                void onApply(current.version).finally(() => {
                  setBusy(false);
                  setViewing(false);
                });
              }}
              data-testid="rules-apply"
            >
              {text.apply}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
