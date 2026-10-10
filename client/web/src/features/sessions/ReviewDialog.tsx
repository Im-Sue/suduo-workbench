import { useQuery } from "@tanstack/react-query";
import { REVIEW_FOCUSES, type ReviewFocus, type SessionDto } from "@suduo/client-contracts";
import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import { useT } from "../../i18n/provider.js";
import { showMessage } from "../../ui/message.js";
import { isUsable, localAgentsQuery } from "../agents/queries.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

/**
 * 请另一个 Agent 评审（多 Agent 协作 S9，需求 4.4）：选评审 Agent（只列做得到只读、能用的，默认避开这个会话的那一家）、
 * 关注点、补充说明。评审在只读评审会话里进行，意见出现在这个会话的评审卡片上。
 */
export function ReviewDialog({ session, open, onOpenChange }: { session: SessionDto; open: boolean; onOpenChange(open: boolean): void }) {
  const t = useT();
  const text = t.collab.review;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" data-testid="review-dialog">
        <DialogHeader>
          <DialogTitle>{text.dialogTitle}</DialogTitle>
          <DialogDescription>{text.dialogDescription(session.title || t.conversation.untitled)}</DialogDescription>
        </DialogHeader>
        {open ? <ReviewForm session={session} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ReviewForm({ session, onDone }: { session: SessionDto; onDone(): void }) {
  const t = useT();
  const text = t.collab.review;
  const agents = useQuery(localAgentsQuery);
  const candidates = (agents.data?.agents ?? []).filter((agent) => agent.readOnlyCapable && isUsable(agent));
  const [agentId, setAgentId] = useState<string | null>(null);
  const [focus, setFocus] = useState<ReadonlySet<ReviewFocus>>(() => new Set(REVIEW_FOCUSES));
  const [note, setNote] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ReturnType<typeof classifyFailure> | null>(null);
  // 默认选一家不是这个会话的 Agent（另一双眼睛）；只有它能用时照样选它。
  useEffect(() => {
    if (agentId !== null || candidates.length === 0) return;
    setAgentId((candidates.find((agent) => agent.id !== session.agentId) ?? candidates[0]!).id);
  }, [agentId, candidates, session.agentId]);
  const start = async () => {
    if (agentId === null || focus.size === 0) return;
    setStarting(true);
    setError(null);
    try {
      const review = await api.startReview(session.id, { agentId, focus: REVIEW_FOCUSES.filter((item) => focus.has(item)), ...(note.trim() === "" ? {} : { note: note.trim() }) });
      showMessage(text.started(review.agentName), "success");
      onDone();
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setStarting(false);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-4">
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-small font-medium text-foreground">{text.agentLabel}</legend>
          {agents.isPending ? null : candidates.length === 0 ? (
            <p className="m-0 text-small text-muted-foreground" data-testid="review-no-agents">{text.noAgents}</p>
          ) : (
            <RadioGroup value={agentId ?? ""} onValueChange={setAgentId}>
              {candidates.map((agent) => (
                <RadioCard key={agent.id} value={agent.id} title={agent.displayName} data-testid="review-agent" data-agent-id={agent.id} />
              ))}
            </RadioGroup>
          )}
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-small font-medium text-foreground">{text.focusLabel}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {REVIEW_FOCUSES.map((item) => {
              const id = `review-focus-${item}`;
              return (
                <span key={item} className="flex items-center gap-2 text-small">
                  <Checkbox
                    id={id}
                    checked={focus.has(item)}
                    data-testid="review-focus"
                    data-focus={item}
                    onCheckedChange={(value) =>
                      setFocus((current) => {
                        const next = new Set(current);
                        if (value === true) next.add(item);
                        else next.delete(item);
                        return next;
                      })
                    }
                  />
                  <label htmlFor={id} className="cursor-pointer text-foreground">
                    {text.focus[item]}
                  </label>
                </span>
              );
            })}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1.5 text-small">
          <span className="font-medium text-foreground">{text.noteLabel}</span>
          <Textarea value={note} rows={3} maxLength={2000} placeholder={text.notePlaceholder} onChange={(event) => setNote(event.target.value)} data-testid="review-note" />
        </label>
        {error === null ? null : <InlineError kind={error.kind}>{text.startFailed(error.message)}</InlineError>}
      </div>
      <DialogFooter>
        <Button variant="secondary" disabled={starting} onClick={onDone}>
          {t.feedback.dialog.close}
        </Button>
        <Button variant="primary" disabled={agentId === null || focus.size === 0} loading={starting} data-testid="review-start" onClick={() => void start()}>
          {text.start}
        </Button>
      </DialogFooter>
    </>
  );
}
