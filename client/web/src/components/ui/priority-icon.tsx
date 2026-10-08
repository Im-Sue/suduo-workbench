import type { RequirementPriority } from "@suduo/cloud-contracts";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { requirementPriorityLabel } from "../../ui/requirement-priority.js";

/** 高 / 中 / 低点亮的格数（共三格，从矮到高）。 */
const LIT_BARS: Record<Exclude<RequirementPriority, "urgent">, number> = { high: 3, medium: 2, low: 1 };
const BARS = [
  { x: 1.5, height: 4 },
  { x: 5.5, height: 7 },
  { x: 9.5, height: 10 },
] as const;

/**
 * 需求优先级图标：紧急是醒目的感叹号方块，高 / 中 / 低是点亮三 / 二 / 一格的信号格，
 * 无优先级是三条短横。形状本身可分，不只靠颜色。
 */
function PriorityIcon({
  priority,
  className,
  title,
  ...props
}: Omit<ComponentProps<"svg">, "children"> & { priority: RequirementPriority | null | undefined; title?: string }) {
  const label = title ?? requirementPriorityLabel(priority);
  const value = priority ?? null;
  return (
    <svg
      viewBox="0 0 14 14"
      role="img"
      aria-label={label}
      data-priority={value ?? "none"}
      className={cn("size-3.5 shrink-0", value === "urgent" ? "text-danger" : "text-muted-foreground", className)}
      {...props}
    >
      {value === "urgent" ? (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M7 3.8v4" fill="none" stroke="var(--card)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="7" cy="10.2" r="0.95" fill="var(--card)" />
        </>
      ) : value === null ? (
        BARS.map((bar) => <rect key={bar.x} x={bar.x} y="6.25" width="3" height="1.5" rx="0.75" fill="currentColor" opacity="0.45" />)
      ) : (
        BARS.map((bar, index) => (
          <rect
            key={bar.x}
            x={bar.x}
            y={12 - bar.height}
            width="3"
            height={bar.height}
            rx="0.75"
            fill="currentColor"
            opacity={index < LIT_BARS[value] ? 1 : 0.25}
          />
        ))
      )}
    </svg>
  );
}

export { PriorityIcon };
