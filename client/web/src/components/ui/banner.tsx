import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * 横幅：页面或区域内持续可见的提示（断线重连、设置未完成、开工后需求有更新）。
 * 需要用户动手的问题用它，而不是会自动消失的 toast。
 */
type BannerTone = "info" | "success" | "warning" | "danger" | "pending";

const TONE_CLASS: Record<BannerTone, string> = {
  info: "bg-primary-soft text-primary-text",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-foreground [&_[data-slot=banner-icon]]:text-warning",
  danger: "bg-danger-soft text-foreground [&_[data-slot=banner-icon]]:text-danger",
  pending: "bg-warning-soft text-foreground [&_[data-slot=banner-icon]]:text-warning",
};

const TONE_ICON: Record<BannerTone, ReactNode> = {
  info: <InfoIcon />,
  success: <CheckCircle2Icon />,
  warning: <AlertTriangleIcon />,
  danger: <XCircleIcon />,
  pending: <Spinner size="sm" />,
};

function Banner({
  tone = "info",
  title,
  children,
  actions,
  icon,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  tone?: BannerTone;
  title?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-slot="banner"
      data-tone={tone}
      className={cn("flex items-center gap-2.5 rounded-md px-3.5 py-2 text-small", TONE_CLASS[tone], className)}
      {...props}
    >
      <span data-slot="banner-icon" className="flex shrink-0 items-center [&_svg]:size-4">
        {icon ?? TONE_ICON[tone]}
      </span>
      <div className="min-w-0 flex-1">
        {title === undefined ? null : <span className="font-semibold">{title}</span>}
        {title !== undefined && children !== undefined ? <span className="opacity-80"> · </span> : null}
        {children === undefined ? null : <span className={cn(title !== undefined && "text-muted-foreground")}>{children}</span>}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export { Banner, type BannerTone };
