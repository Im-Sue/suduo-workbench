import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 卡片：用于分区容器（我的工作、概览、设置分组）。层级靠细边框，不靠投影。 */
function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("rounded-lg border border-border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-11 items-center gap-2 border-b border-border px-4 py-2.5", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("text-body font-semibold text-foreground", className)} {...props} />;
}

function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("text-small text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-2 border-t border-border px-4 py-3", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
