import type { RequirementStatus } from "@suduo/cloud-contracts";
import { REQUIREMENT_STATUS_LABELS } from "@suduo/cloud-contracts";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * 需求状态图标：形状 + 颜色双编码（技术设计 §3.2），色弱与灰度下依然可分。
 * 草稿 虚线环 / 梳理中 环+点 / 待开发 实线环 / 开发中 半饼 / 测试中 3/4 饼 / 已完成 实心勾 / 暂缓 暂停线。
 */
const STATUS_COLOR: Record<RequirementStatus, string> = {
  draft: "text-status-draft",
  in_refinement: "text-status-refine",
  ready_for_development: "text-status-todo",
  in_development: "text-status-dev",
  in_testing: "text-status-test",
  completed: "text-status-done",
  on_hold: "text-status-hold",
};

function StatusIcon({
  status,
  className,
  title,
  ...props
}: Omit<ComponentProps<"svg">, "children"> & { status: RequirementStatus; title?: string }) {
  const label = title ?? REQUIREMENT_STATUS_LABELS[status];
  return (
    <svg
      viewBox="0 0 14 14"
      role="img"
      aria-label={label}
      data-status={status}
      className={cn("size-3.5 shrink-0", STATUS_COLOR[status], className)}
      {...props}
    >
      {status === "completed" ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.4 7.2 6.2 9l3.4-3.8"
            fill="none"
            stroke="var(--card)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray={status === "draft" ? "2.2 2" : undefined}
        />
      )}
      {status === "in_refinement" ? <circle cx="7" cy="7" r="2" fill="currentColor" /> : null}
      {status === "in_development" ? <path d="M7 3.5A3.5 3.5 0 0 1 7 10.5Z" fill="currentColor" /> : null}
      {status === "in_testing" ? <path d="M7 3.5A3.5 3.5 0 1 1 3.5 7L7 7Z" fill="currentColor" /> : null}
      {status === "on_hold" ? (
        <path d="M5.8 5.2v3.6M8.2 5.2v3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

/** 图标 + 文字的状态标签。 */
function StatusLabel({ status, className }: { status: RequirementStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-small text-foreground", className)}>
      <StatusIcon status={status} aria-hidden="true" />
      {REQUIREMENT_STATUS_LABELS[status]}
    </span>
  );
}

export { StatusIcon, StatusLabel };
