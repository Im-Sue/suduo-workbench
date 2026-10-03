import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

/**
 * 不可逆操作的确认框（删除附件、删除会话、退出登录、切换到完全访问）。
 * Radix AlertDialog 默认把焦点放在 Cancel 上，符合"默认焦点在取消"。
 */
const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        className="fixed inset-0 z-60 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />
      <AlertDialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-60 flex w-[calc(100vw-32px)] max-w-[440px] -translate-x-1/2 -translate-y-1/2 flex-col gap-2",
          "rounded-lg bg-popover p-6 text-popover-foreground shadow-dialog outline-none",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title className={cn("m-0 text-section font-semibold text-foreground", className)} {...props} />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description className={cn("m-0 text-small text-muted-foreground", className)} {...props} />
  );
}

function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-4 flex items-center justify-end gap-2", className)} {...props} />;
}

function AlertDialogCancel({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return <AlertDialogPrimitive.Cancel className={cn(buttonVariants({ variant: "secondary" }), className)} {...props} />;
}

function AlertDialogAction({
  className,
  tone = "danger",
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action> & { tone?: "danger" | "primary" }) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants({ variant: tone === "danger" ? "danger" : "primary" }), className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
};
