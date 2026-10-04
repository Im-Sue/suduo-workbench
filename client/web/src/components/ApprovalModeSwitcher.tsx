import { useState } from "react";
import type { ApprovalMode, SessionDto } from "@suduo/client-contracts";
import { CheckIcon, ChevronDownIcon, ShieldIcon } from "lucide-react";
import { ConfirmDialog } from "../feedback/components/index.js";
import { useT } from "../i18n/provider.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const MODES: readonly ApprovalMode[] = ["ask", "auto", "full"];

/**
 * 会话级审批档（下个回合生效），放在输入框底栏。
 * 部署侧锁定上限时只做置灰与说明，真正的强制在服务端。切到完全访问需要二次确认（不可逆风险提示）。
 */
export function ApprovalModeSwitcher(props: {
  session: SessionDto;
  approvalModeLocked?: boolean;
  maxApprovalMode?: ApprovalMode;
  onChange(mode: ApprovalMode): Promise<void>;
}) {
  const t = useT();
  const text = t.workbench.approvalMode;
  const modes = t.settingsAgent.execution.modes;
  const [confirmFull, setConfirmFull] = useState(false);
  const [switching, setSwitching] = useState(false);

  const run = (mode: ApprovalMode) => {
    setSwitching(true);
    void props.onChange(mode).finally(() => setSwitching(false));
  };

  const apply = (mode: ApprovalMode) => {
    if (mode === props.session.approvalMode) return;
    if (mode === "full") {
      setConfirmFull(true);
      return;
    }
    run(mode);
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              // 输入框底栏放不下时（运行中多了排队、停止，或对话栏很窄）档名截断，完整名字在菜单里。
              "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-2 text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [&>svg]:shrink-0",
              props.session.approvalMode === "full" ? "text-warning" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="approval-mode"
            title={text.title}
          >
            {switching ? <Spinner size="sm" /> : <ShieldIcon className="size-3.5" aria-hidden="true" />}
            <span className="truncate">{modes[props.session.approvalMode].label}</span>
            <ChevronDownIcon className="size-3 opacity-70" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72">
          <DropdownMenuLabel>{text.menuLabel}</DropdownMenuLabel>
          {MODES.map((mode) => {
            const blocked = props.approvalModeLocked === true && mode === "full" && props.maxApprovalMode !== "full";
            return (
              <DropdownMenuItem
                key={mode}
                data-testid={`approval-mode-option-${mode}`}
                disabled={blocked}
                title={blocked ? text.lockedReason : undefined}
                onSelect={() => apply(mode)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-small text-foreground">{modes[mode].label}</span>
                  <span className="text-caption text-subtle-foreground">
                    {blocked ? text.locked : text.descriptions[mode]}
                  </span>
                </span>
                {mode === props.session.approvalMode ? <CheckIcon className="size-4 text-primary-text!" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmFull}
        onOpenChange={setConfirmFull}
        title={text.fullConfirm.title}
        description={text.fullConfirm.description}
        confirmLabel={text.fullConfirm.confirm}
        onConfirm={() => {
          setConfirmFull(false);
          run("full");
        }}
      />
    </>
  );
}
