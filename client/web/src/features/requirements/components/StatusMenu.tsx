import {
  REQUIREMENT_STATUSES,
  type RequirementStatus,
} from "@suduo/cloud-contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { requirementStatusLabel } from "../../../ui/requirement-status.js";
import { useT } from "../../../i18n/provider.js";

/**
 * 需求状态菜单：七个状态按流程顺序排列，数字键 1–7 直接选择。
 * 触发器由调用方决定外观（看板卡片、速览面板、详情属性栏各不相同）。
 * 保存中触发器只标记 aria-disabled、不真正禁用，焦点不会因此丢失；选当前状态不重复提交。
 */
export function StatusMenu({
  status,
  onChange,
  pending = false,
  disabled = false,
  trigger,
  align = "start",
}: {
  status: RequirementStatus;
  onChange(next: RequirementStatus): void;
  pending?: boolean;
  disabled?: boolean;
  trigger?: ReactNode;
  align?: "start" | "end";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pick = (next: RequirementStatus) => {
    setOpen(false);
    if (next !== status) onChange(next);
  };
  return (
    <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !pending)}>
      <DropdownMenuTrigger asChild disabled={disabled} aria-disabled={pending || undefined}>
        {trigger ?? (
          <button
            type="button"
            aria-label={t.requirements.statusMenu.triggerLabel(requirementStatusLabel(status), pending)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-small font-medium text-foreground outline-none",
              "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-disabled:opacity-60 data-[state=open]:bg-muted",
            )}
          >
            {pending ? <Spinner size="sm" className="text-subtle-foreground" /> : <StatusIcon status={status} aria-hidden="true" />}
            {requirementStatusLabel(status)}
            <ChevronDownIcon className="size-3.5 text-subtle-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-52"
        onKeyDown={(event) => {
          const index = Number(event.key) - 1;
          const next = REQUIREMENT_STATUSES[index];
          if (next !== undefined && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            pick(next);
          }
        }}
      >
        {REQUIREMENT_STATUSES.map((item, index) => (
          <DropdownMenuItem key={item} onSelect={() => pick(item)}>
            <StatusIcon status={item} aria-hidden="true" />
            <span className="flex-1">{requirementStatusLabel(item)}</span>
            {item === status ? <CheckIcon className="size-4 text-primary-text!" /> : null}
            <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
