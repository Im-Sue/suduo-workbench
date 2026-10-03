import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 文本输入：aria-invalid 时自动显示错误态（红框 + 光晕），无需额外 className。 */
const inputClassName = [
  "flex h-(--ctl-h) w-full min-w-0 rounded-sm border border-input bg-card px-2.5 text-small text-foreground",
  "placeholder:text-subtle-foreground transition-[border-color,box-shadow] duration-(--dur-fast) outline-none",
  "focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft",
  "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger-soft",
  "disabled:cursor-not-allowed disabled:bg-muted disabled:text-disabled-foreground",
  "read-only:bg-muted",
  "file:border-0 file:bg-transparent file:text-small file:font-medium",
].join(" ");

function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(inputClassName, className)} {...props} />;
}

export { Input, inputClassName };
