import {
  AlertCircleIcon,
  InboxIcon,
  ListChecksIcon,
  LockKeyholeIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { EmptyStateKind, Failure, FailureKind, FeedbackRoute } from "../types.js";

/**
 * 反馈出口组件（技术设计 §5.2 / §6.2）。
 * 语义属性（data-feedback-kind / data-feedback-result / data-testid / role）是端到端与单测的定位契约，
 * 改外观时必须保持不变。
 */

export function InlineError({ children, kind }: { children: ReactNode; kind: FailureKind }) {
  return (
    <p
      className="m-0 flex items-start gap-1.5 text-caption text-danger"
      data-feedback-kind={kind}
      data-feedback-result="field"
      data-testid="inline-error"
      role="alert"
    >
      <AlertCircleIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function RegionError({
  kind,
  message,
  onRetry,
  busy = false,
}: {
  kind: FailureKind;
  message: ReactNode;
  onRetry?: () => void;
  busy?: boolean;
}) {
  return (
    <section
      aria-busy={busy}
      className="flex flex-col items-center gap-2 px-4 py-6 text-center"
      data-feedback-kind={kind}
      data-feedback-result="region"
      data-testid="region-error"
      role="alert"
    >
      <AlertCircleIcon aria-hidden="true" className="size-5 text-danger" />
      <p className="m-0 max-w-[420px] text-small text-muted-foreground">{message}</p>
      {onRetry === undefined ? null : (
        <Button loading={busy} size="sm" type="button" onClick={onRetry}>
          {busy ? null : <RotateCwIcon />}
          重试
        </Button>
      )}
    </section>
  );
}

export function PageFailure({
  failure,
  route,
  onAction,
  actionLabel,
}: {
  failure: Failure;
  route: FeedbackRoute;
  onAction?: () => void;
  actionLabel?: string;
}) {
  const label = actionLabel ?? (failure.kind === "auth_expired" ? "去登录" : "重试");
  const unavailable = failure.kind === "auth_expired" && onAction === undefined;
  const Icon = failure.kind === "auth_expired" ? LockKeyholeIcon : AlertCircleIcon;
  return (
    <section
      className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center"
      data-feedback-kind={failure.kind}
      data-feedback-result={route.outlet}
      data-testid="page-failure"
      role="alert"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <h2 className="m-0 text-section font-semibold text-foreground">
        {failure.kind === "auth_expired" ? "登录已过期" : "这里暂时无法显示"}
      </h2>
      <p className="m-0 max-w-[460px] text-small text-muted-foreground">{failure.message}</p>
      {onAction === undefined && !unavailable ? null : (
        <Button
          disabled={unavailable}
          disabledReason="登录入口暂不可用，请刷新页面后重试"
          type="button"
          variant="primary"
          onClick={onAction}
        >
          {unavailable ? `${label}（不可用）` : label}
        </Button>
      )}
    </section>
  );
}

const EMPTY_ICON: Record<EmptyStateKind, ReactNode> = {
  empty: <InboxIcon />,
  prerequisite: <ListChecksIcon />,
};

export function EmptyState({
  title,
  description,
  action,
  kind = "empty",
  size = "section",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  kind?: EmptyStateKind;
  /** inline：一行淡字（空列、空列表）；section：图标 + 一句话；page：整页引导。 */
  size?: "inline" | "section" | "page";
}) {
  if (size === "inline") {
    return (
      <section
        className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-small text-subtle-foreground"
        data-feedback-kind={kind}
        data-testid="empty-state"
      >
        <h2 className="m-0 text-small font-normal">{title}</h2>
        {action === undefined ? null : (
          <Button className="ml-auto" size="sm" type="button" variant="ghost" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </section>
    );
  }
  return (
    <section
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        size === "page" ? "px-6 py-20" : "px-4 py-8",
      )}
      data-feedback-kind={kind}
      data-testid="empty-state"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center justify-center text-subtle-foreground",
          size === "page" ? "mb-1 size-10 rounded-full bg-muted [&_svg]:size-5" : "[&_svg]:size-6",
        )}
      >
        {EMPTY_ICON[kind]}
      </span>
      <h2 className={cn("m-0 font-semibold text-foreground", size === "page" ? "text-section" : "text-body")}>
        {title}
      </h2>
      {description === undefined ? null : (
        <p className="m-0 max-w-[420px] text-small text-muted-foreground">{description}</p>
      )}
      {action === undefined ? null : (
        <Button
          className="mt-1"
          size={size === "page" ? "md" : "sm"}
          type="button"
          variant={size === "page" ? "primary" : "secondary"}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </section>
  );
}

interface DialogBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  triggerRef?: RefObject<HTMLElement | null>;
}

function focusTrigger(triggerRef: DialogBaseProps["triggerRef"]): void {
  queueMicrotask(() => triggerRef?.current?.focus());
}

/** 危险确认：按钮文案用动词说后果；默认焦点在「取消」。 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确认",
  onConfirm,
  triggerRef,
}: DialogBaseProps & {
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) queueMicrotask(() => cancelRef.current?.focus());
  }, [open]);
  const close = () => {
    onOpenChange(false);
    focusTrigger(triggerRef);
  };
  const changeOpen = (next: boolean) => {
    onOpenChange(next);
    if (!next) focusTrigger(triggerRef);
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent data-testid="confirm-dialog" showCloseButton={false} size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : (
            <DialogDescription asChild>
              <div>{description}</div>
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} type="button" onClick={close}>
            取消
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => {
              onConfirm();
              close();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 表单对话框：有未保存内容时，Esc / 点遮罩 / 点关闭不会直接丢弃，
 * 而是在底部询问「放弃已填写的内容？」，给出继续编辑与放弃两个选择。
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  hasUnsavedChanges = false,
  triggerRef,
  size = "md",
}: DialogBaseProps & {
  children: ReactNode;
  hasUnsavedChanges?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  useEffect(() => {
    if (!open) setConfirmingDiscard(false);
  }, [open]);
  const reallyClose = () => {
    setConfirmingDiscard(false);
    onOpenChange(false);
    focusTrigger(triggerRef);
  };
  const changeOpen = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (hasUnsavedChanges) {
      setConfirmingDiscard(true);
      return;
    }
    reallyClose();
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        data-testid="form-dialog"
        size={size}
        onEscapeKeyDown={(event) => {
          if (hasUnsavedChanges) {
            event.preventDefault();
            setConfirmingDiscard(true);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {confirmingDiscard ? (
          <div
            className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-small"
            data-testid="form-dialog-discard"
            role="alertdialog"
            aria-label="放弃已填写的内容？"
          >
            <span className="flex-1">放弃已填写的内容？</span>
            <Button autoFocus size="sm" type="button" variant="ghost" onClick={() => setConfirmingDiscard(false)}>
              继续编辑
            </Button>
            <Button size="sm" type="button" variant="danger" onClick={reallyClose}>
              放弃
            </Button>
          </div>
        ) : null}
        {children}
      </DialogContent>
    </Dialog>
  );
}
