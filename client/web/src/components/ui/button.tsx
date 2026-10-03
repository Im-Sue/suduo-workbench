import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/**
 * 按钮（技术设计 §5.1）。
 * - 变体：primary（每处最多一个）/ secondary / ghost / danger / danger-ghost / link。
 *   旧名 default / outline / destructive 仍可用，分别等同 primary / secondary / danger。
 * - 尺寸跟随密度令牌：sm 28 / md 32 / lg 36（紧凑档各减 4）。
 * - loading：前置加载圈 + aria-busy，期间点击无效。
 * - disabledReason：禁用时悬停说明原因，避免"按不动又不知道为什么"。
 */
const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium no-underline select-none",
    "transition-[background-color,border-color,color,box-shadow] duration-(--dur-fast)",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
    "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
        secondary: "border border-border-strong bg-card text-foreground hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        danger: "bg-destructive text-destructive-foreground hover:brightness-95",
        "danger-ghost": "text-danger hover:bg-danger-soft",
        link: "h-auto! px-0! text-primary-text underline-offset-4 hover:underline",
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline: "border border-border-strong bg-card text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:brightness-95",
      },
      size: {
        sm: "h-(--ctl-h-sm) px-2.5 text-caption",
        md: "h-(--ctl-h) px-3 text-small",
        lg: "h-(--ctl-h-lg) px-4 text-body",
        icon: "size-(--ctl-h) p-0",
        "icon-sm": "size-(--ctl-h-sm) p-0",
        default: "h-(--ctl-h) px-3 text-small",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

const PRIMARY_LIKE: ReadonlySet<ButtonVariant> = new Set(["primary", "default"]);

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabledReason,
  wrapperClassName,
  disabled,
  children,
  onClick,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    loading?: boolean;
    disabledReason?: ReactNode;
    /** 带 disabledReason 时外层包装元素的类名（例如 w-full / flex-1）。 */
    wrapperClassName?: string;
  }) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const Comp = asChild ? Slot : "button";
  const resolvedVariant: ButtonVariant = variant ?? "secondary";
  const button = (
    <Comp
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      data-variant={PRIMARY_LIKE.has(resolvedVariant) ? "primary" : resolvedVariant}
      className={cn(buttonVariants({ variant, size, className }), loading && "cursor-progress")}
      disabled={asChild ? undefined : disabled}
      onClick={
        loading
          ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault()
          : onClick
      }
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner /> : null}
          {children}
        </>
      )}
    </Comp>
  );
  if (disabledReason !== undefined && disabledReason !== null) {
    // 传了禁用原因就始终保留同一层包装：禁用 / 可用切换时按钮 DOM 不重建，焦点与引用不丢。
    // 提示始终受控：只有禁用时才可能打开，恢复可用时立即收起。
    return (
      <TooltipProvider>
        <Tooltip open={Boolean(disabled) && reasonOpen} onOpenChange={setReasonOpen}>
          <TooltipTrigger asChild>
            <span className={cn("inline-flex", wrapperClassName)} tabIndex={disabled ? 0 : undefined}>
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return button;
}

export { Button, buttonVariants };
