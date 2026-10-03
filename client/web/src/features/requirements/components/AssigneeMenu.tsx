import { useQuery } from "@tanstack/react-query";
import type { UserSummaryDto } from "@suduo/cloud-contracts";
import { CheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { usersQuery } from "../queries.js";
import { UserAvatar } from "./UserAvatar.js";
import { useT } from "../../../i18n/provider.js";

/**
 * 负责人选择：可搜索；「未指派」和「我」固定在最前。
 * 触发器由调用方提供（卡片、速览、详情属性栏、新建对话框外观各不相同）。
 */
export function AssigneeMenu({
  assignee,
  currentUserId,
  onChange,
  children,
  align = "start",
  disabled = false,
}: {
  assignee: UserSummaryDto | null;
  currentUserId: string | null;
  onChange(next: UserSummaryDto | null): void;
  children: ReactNode;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const users = useQuery({ ...usersQuery, enabled: open });
  const items = users.data?.items ?? [];
  const me = items.find((user) => user.id === currentUserId) ?? null;
  const others = items.filter((user) => user.id !== currentUserId);

  const pick = (next: UserSummaryDto | null) => {
    setOpen(false);
    if ((next?.id ?? null) !== (assignee?.id ?? null)) onChange(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {children}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-60 p-0">
        <Command>
          <CommandInput placeholder={t.requirements.assignee.search} />
          <CommandList>
            {users.isPending ? (
              <div className="flex items-center gap-2 px-3 py-2.5 text-small text-subtle-foreground">
                <Spinner size="sm" />
                {t.requirements.assignee.loading}
              </div>
            ) : null}
            {users.isError ? (
              <div className="px-3 py-2.5 text-small text-danger">{t.requirements.assignee.loadFailed}</div>
            ) : null}
            <CommandEmpty>{t.requirements.assignee.empty}</CommandEmpty>
            <CommandGroup>
              <CommandItem value={t.requirements.assignee.unassignedKeywords} onSelect={() => pick(null)}>
                <UserAvatar user={null} />
                <span className="flex-1">{t.requirements.assignee.unassigned}</span>
                {assignee === null ? <CheckIcon className="size-4 text-primary-text!" /> : null}
              </CommandItem>
              {me === null ? null : (
                <CommandItem value={t.requirements.assignee.meKeywords(me.displayName)} onSelect={() => pick(me)}>
                  <UserAvatar user={me} />
                  <span className="flex-1 truncate">
                    {me.displayName}
                    <span className="ml-1 text-subtle-foreground">{t.requirements.assignee.meSuffix}</span>
                  </span>
                  {assignee?.id === me.id ? <CheckIcon className="size-4 text-primary-text!" /> : null}
                </CommandItem>
              )}
              {others.map((user) => (
                <CommandItem key={user.id} value={`${user.displayName} ${user.id}`} onSelect={() => pick(user)}>
                  <UserAvatar user={user} />
                  <span className="flex-1 truncate">{user.displayName}</span>
                  {assignee?.id === user.id ? <CheckIcon className="size-4 text-primary-text!" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
