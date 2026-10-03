import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 骨架屏：按真实布局绘制，首次加载即显示（0ms）；只用于首屏，后台刷新保留旧数据。 */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        "animate-shimmer rounded-xs bg-[linear-gradient(90deg,var(--muted)_0%,var(--muted-strong)_50%,var(--muted)_100%)] bg-size-[200%_100%]",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
