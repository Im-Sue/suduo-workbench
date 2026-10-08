import { REQUIREMENT_PRIORITIES, type RequirementPriority } from "@suduo/cloud-contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PriorityIcon } from "@/components/ui/priority-icon";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { requirementPriorityLabel } from "../../../ui/requirement-priority.js";
import { useT } from "../../../i18n/provider.js";

/** 菜单里的顺序与数字键：1 紧急 … 4 低，0 无优先级。 */
const OPTIONS: ReadonlyArray<{ value: RequirementPriority | null; key: string }> = [
  ...REQUIREMENT_PRIORITIES.map((value, index) => ({ value, key: String(index + 1) })),
  { value: null, key: "0" },
];

/**
 * 需求优先级菜单：紧急 / 高 / 中 / 低 / 无，数字键 1–4、0 直接选择。
 * 触发器由调用方决定外观（新建对话框、速览面板、详情属性栏各不相同）；用法同 StatusMenu。
 */
export function PriorityMenu({
  priority,
  onChange,
  pending = false,
  disabled = false,
  trigger,
  align = "start",
}: {
  priority: RequirementPriority | null;
  onChange(next: RequirementPriority | null): void;
  pending?: boolean;
  disabled?: boolean;
  trigger?: ReactNode;
  align?: "start" | "end";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pick = (next: RequirementPriority | null) => {
    setOpen(false);
    if (next !== priority) onChange(next);
  };
  const label = requirementPriorityLabel(priority, t);
  return (
    <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !pending)}>
      <DropdownMenuTrigger asChild disabled={disabled} aria-disabled={pending || undefined}>
        {trigger ?? (
          <button
            type="button"
            data-testid="priority-menu-trigger"
            aria-label={t.requirements.priorityMenu.triggerLabel(label, pending)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-small font-medium text-foreground outline-none",
              "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 aria-disabled:opacity-60 data-[state=open]:bg-muted",
              priority === null && "text-subtle-foreground",
            )}
          >
            {pending ? <Spinner size="sm" className="text-subtle-foreground" /> : <PriorityIcon priority={priority} aria-hidden="true" />}
            {label}
            <ChevronDownIcon className="size-3.5 text-subtle-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-48"
        onKeyDown={(event) => {
          const option = OPTIONS.find((item) => item.key === event.key);
          if (option !== undefined && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            pick(option.value);
          }
        }}
      >
        {OPTIONS.map((option) => (
          <PriorityOption key={option.key} option={option} current={priority} onPick={pick} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityOption({
  option,
  current,
  onPick,
}: {
  option: { value: RequirementPriority | null; key: string };
  current: RequirementPriority | null;
  onPick(next: RequirementPriority | null): void;
}) {
  const t = useT();
  return (
    <>
      {option.value === null ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={() => onPick(option.value)}>
        <PriorityIcon priority={option.value} aria-hidden="true" />
        <span className="flex-1">{requirementPriorityLabel(option.value, t)}</span>
        {option.value === current ? <CheckIcon className="size-4 text-primary-text!" /> : null}
        <DropdownMenuShortcut>{option.key}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </>
  );
}
