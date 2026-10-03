import { useState } from "react";
import type { ApprovalMode, SessionDto } from "@suduo/client-contracts";
import { APPROVAL_MODE_LABELS } from "@suduo/client-contracts";
import { CheckIcon, ChevronDownIcon, ShieldIcon } from "lucide-react";
import { ConfirmDialog } from "../feedback/components/index.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const MODE_DESC: Record<ApprovalMode, string> = {
  ask: "每一步写文件、执行命令都需要你批准（最稳）",
  auto: "项目目录内直接执行，越界操作才询问（推荐日常）",
  full: "不设限、不询问，Codex 可访问本机任意文件与网络",
};

const LOCKED_REASON = "本机部署设置了审批上限，不能选择完全访问；需要的话请联系管理员。";

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
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted",
              props.session.approvalMode === "full" ? "text-warning" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid="approval-mode"
            title="审批档（本会话，切换后下个回合生效）"
          >
            {switching ? <Spinner size="sm" /> : <ShieldIcon className="size-3.5" aria-hidden="true" />}
            {APPROVAL_MODE_LABELS[props.session.approvalMode]}
            <ChevronDownIcon className="size-3 opacity-70" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72">
          <DropdownMenuLabel>审批档 · 本会话 · 下个回合生效</DropdownMenuLabel>
          {(Object.keys(MODE_DESC) as ApprovalMode[]).map((mode) => {
            const blocked = props.approvalModeLocked === true && mode === "full" && props.maxApprovalMode !== "full";
            return (
              <DropdownMenuItem
                key={mode}
                data-testid={`approval-mode-option-${mode}`}
                disabled={blocked}
                title={blocked ? LOCKED_REASON : undefined}
                onSelect={() => apply(mode)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-small text-foreground">{APPROVAL_MODE_LABELS[mode]}</span>
                  <span className="text-caption text-subtle-foreground">
                    {blocked ? "已被部署上限锁定，请联系管理员" : MODE_DESC[mode]}
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
        title="切换到完全访问？"
        description="这个会话将不再弹出任何审批，Codex 可以不受限制地访问本机文件与网络。下个回合生效。"
        confirmLabel="切换到完全访问"
        onConfirm={() => {
          setConfirmFull(false);
          run("full");
        }}
      />
    </>
  );
}
