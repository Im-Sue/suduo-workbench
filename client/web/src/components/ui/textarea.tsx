import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full resize-y rounded-sm border border-input bg-card px-2.5 py-2 text-body text-foreground",
        "placeholder:text-subtle-foreground transition-[border-color,box-shadow] duration-(--dur-fast) outline-none",
        "focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft",
        "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger-soft",
        "disabled:cursor-not-allowed disabled:bg-muted disabled:text-disabled-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
