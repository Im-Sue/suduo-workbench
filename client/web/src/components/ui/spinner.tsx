import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 行内加载圈：跟随 currentColor；需要读屏播报时由外层容器负责 aria-live。 */
function Spinner({
  className,
  size = "md",
  ...props
}: ComponentProps<"span"> & { size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      data-slot="spinner"
      className={cn(
        "inline-block shrink-0 animate-spin-fast rounded-full border-2 border-current border-r-transparent",
        size === "sm" && "size-3",
        size === "md" && "size-3.5",
        size === "lg" && "size-5",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
