import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { menuItemBase, menuSeparator } from "./menu-styles";

/** 命令面板与 Combobox 的内核（cmdk）。⌘K 面板在 P1 由外壳挂载。 */
function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("flex size-full flex-col overflow-hidden bg-popover text-popover-foreground", className)}
      {...props}
    />
  );
}

function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex h-11 items-center gap-2 border-b border-border px-3">
      <SearchIcon className="size-4 shrink-0 text-subtle-foreground" />
      <CommandPrimitive.Input
        className={cn(
          "h-full w-full border-0 bg-transparent p-0 text-body text-foreground outline-none placeholder:text-subtle-foreground disabled:opacity-45",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("max-h-[360px] scroll-py-1 overflow-x-hidden overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-8 text-center text-small text-subtle-foreground" {...props} />;
}

function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        menuItemBase,
        // cmdk 在所有条目上都写 data-disabled="true|false"，只能按取值判断
        "cursor-pointer data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45 data-[selected=true]:bg-popover-hover",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}

function CommandShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("ml-auto font-mono text-[11px] text-subtle-foreground", className)} {...props} />;
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut };
