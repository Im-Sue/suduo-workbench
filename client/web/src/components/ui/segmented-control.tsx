import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/** 分段选择：视图切换（看板 / 列表）、时间范围、密度等 2–5 个互斥选项。 */
function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = "md",
  className,
  ...aria
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "data-testid"?: string;
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next !== "") onValueChange(next as T);
      }}
      data-slot="segmented-control"
      className={cn("inline-flex items-center gap-0.5 rounded-[7px] border border-border bg-muted p-0.5", className)}
      {...aria}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 font-medium text-muted-foreground",
            "transition-[background-color,color,box-shadow] duration-(--dur-fast) outline-none hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring",
            "data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-raised",
            "disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-3.5",
            size === "sm" ? "h-6 text-caption" : "h-7 text-small",
          )}
        >
          {option.icon}
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

export { SegmentedControl };
