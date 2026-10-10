import type { SessionRoundSummaryDto } from "@suduo/client-contracts";
import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { reportFailure } from "../../feedback/report.js";
import { useT } from "../../i18n/provider.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

/** 发布会话快照：选回合（序号与服务端一致）→ 生成快照草稿 → 交给发布对话框预览（多 Agent 协作 S11）。 */
export function SnapshotDialog({ sessionId, onClose, onCreated }: { sessionId: string; onClose(): void; onCreated(draftId: string): void }) {
  const t = useT();
  const text = t.collab.share.snapshot;
  const [rounds, setRounds] = useState<SessionRoundSummaryDto[] | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.listSessionRounds(sessionId))
      .then((response) => {
        if (cancelled) return;
        const finished = response.items.filter((round) => round.status !== "running");
        setRounds(finished);
        setChosen(new Set(finished.map((round) => round.index)));
      })
      .catch(() => {
        if (!cancelled) setRounds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  const create = async () => {
    setBusy(true);
    try {
      const draft = await api.createSnapshotDraft(sessionId, [...chosen].sort((a, b) => a - b));
      onCreated(draft.id);
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.failed });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent size="md" data-testid="snapshot-dialog">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        {rounds === null ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : rounds.length === 0 ? (
          <p className="m-0 text-small text-muted-foreground">{text.none}</p>
        ) : (
          <ul className="m-0 flex max-h-80 list-none flex-col gap-1.5 overflow-y-auto p-0">
            {rounds.map((round) => {
              const id = `snapshot-round-${String(round.index)}`;
              return (
                <li key={round.index} className="flex items-start gap-2 text-small">
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={chosen.has(round.index)}
                    onCheckedChange={(value) =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (value === true) next.add(round.index);
                        else next.delete(round.index);
                        return next;
                      })
                    }
                    data-testid="snapshot-round"
                  />
                  <label htmlFor={id} className="min-w-0 cursor-pointer text-foreground">
                    {text.round(round.index, round.userText)}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t.feedback.dialog.cancel}
          </Button>
          <Button variant="primary" disabled={chosen.size === 0} loading={busy} onClick={() => void create()} data-testid="snapshot-create">
            {text.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
