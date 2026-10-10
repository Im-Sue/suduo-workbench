import { useT } from "../../i18n/provider.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * 停止级联（多 Agent 协作 S8，需求 4.11 / R7）：停止发起回合时，这个会话还有没做完的委派就问一句，
 * 默认一并停止；也可以只停这一轮让子任务继续。
 */
export function CascadeStopDialog({
  open,
  count,
  onOpenChange,
  onStopAll,
  onStopThis,
}: {
  open: boolean;
  count: number;
  onOpenChange(open: boolean): void;
  onStopAll(): void;
  onStopThis(): void;
}) {
  const t = useT();
  const text = t.collab.cascade;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" data-testid="cascade-stop-dialog">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description(count)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="secondary"
            data-testid="cascade-stop-this"
            onClick={() => {
              onOpenChange(false);
              onStopThis();
            }}
          >
            {text.stopThis}
          </Button>
          <Button
            variant="danger"
            autoFocus
            data-testid="cascade-stop-all"
            onClick={() => {
              onOpenChange(false);
              onStopAll();
            }}
          >
            {text.stopAll}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
