import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 徽标：计数、状态、标签。语义色都用浅底 + 深字，保证两套主题下对比度达标。 */
const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs px-1.5 text-caption leading-none font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "bg-muted text-muted-foreground",
        default: "bg-muted text-muted-foreground",
        outline: "border border-border text-muted-foreground",
        primary: "bg-primary-soft text-primary-text",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        destructive: "bg-danger-soft text-danger",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
