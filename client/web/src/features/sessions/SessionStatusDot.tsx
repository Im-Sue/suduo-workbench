import { CheckIcon, XIcon } from "lucide-react";
import { SESSION_STATUS_LABEL, type SessionUiStatus } from "../../ui/session-status.js";
import { cn } from "@/lib/utils";

/**
 * 会话状态标记（技术设计 §3.2）：形状 + 颜色双编码。
 * 运行中 强调色实心点 + 呼吸；等你确认 警告色实心点；失败 危险色叉；已完成 成功色对勾；空闲 空心圆。
 */
export function SessionStatusDot({ status, className }: { status: SessionUiStatus; className?: string }) {
  const label = SESSION_STATUS_LABEL[status];
  const box = cn("relative inline-flex size-3.5 shrink-0 items-center justify-center", className);
  switch (status) {
    case "running":
      return (
        <span className={box} role="img" aria-label={label}>
          <span className="absolute size-2 animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
          <span className="relative size-2 rounded-full bg-primary" />
        </span>
      );
    case "approval":
      return (
        <span className={box} role="img" aria-label={label}>
          <span className="size-2 rounded-full bg-warning" />
        </span>
      );
    case "error":
      return (
        <span className={box} role="img" aria-label={label}>
          <XIcon className="size-3.5 text-danger" strokeWidth={2.5} />
        </span>
      );
    case "completed":
      return (
        <span className={box} role="img" aria-label={label}>
          <CheckIcon className="size-3.5 text-success" strokeWidth={2.5} />
        </span>
      );
    case "idle":
      return (
        <span className={box} role="img" aria-label={label}>
          <span className="size-2 rounded-full border-[1.5px] border-subtle-foreground" />
        </span>
      );
  }
}
