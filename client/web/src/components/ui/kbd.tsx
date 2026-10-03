import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 快捷键键帽；放在主按钮里时自动换成半透明白底。 */
function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-border bg-muted px-1 font-mono text-[11px] leading-none font-normal text-subtle-foreground",
        "in-data-[variant=primary]:border-white/25 in-data-[variant=primary]:bg-white/15 in-data-[variant=primary]:text-white/90",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
