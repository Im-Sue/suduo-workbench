import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 确定进度条（上传、准备会话材料）。value 为 0–100；tone 用于失败或等待态。 */
function Progress({
  value,
  tone = "primary",
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  value: number;
  tone?: "primary" | "success" | "warning" | "danger";
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted-strong", className)}
      {...props}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-(--dur-slow) ease-(--ease-enter)",
          tone === "primary" && "bg-primary",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "danger" && "bg-danger",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export { Progress };
