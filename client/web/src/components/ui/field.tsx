import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 表单字段：标签 + 控件 + 说明 / 错误。
 * 自动把 id、aria-describedby、aria-invalid 接到唯一的子控件上。
 */
function Field({
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const autoId = useId();
  const childProps = isValidElement(children) ? children.props : {};
  const controlId = typeof childProps["id"] === "string" ? childProps["id"] : autoId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasError = error !== undefined && error !== null && error !== false;
  const ownDescribedBy = typeof childProps["aria-describedby"] === "string" ? childProps["aria-describedby"] : null;
  const describedBy = [ownDescribedBy, hasError ? errorId : null, hint === undefined ? null : hintId]
    .filter(Boolean)
    .join(" ");
  const ownInvalid = childProps["aria-invalid"] === true || childProps["aria-invalid"] === "true";
  // 与调用方显式传入的 aria 属性合并，而不是覆盖。
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        "aria-invalid": hasError || ownInvalid || undefined,
        "aria-describedby": describedBy === "" ? undefined : describedBy,
        "aria-required": required || childProps["aria-required"] || undefined,
      })
    : children;
  return (
    <div data-slot="field" className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={controlId} className="text-small font-medium text-foreground">
        {label}
        {required ? <span className="ml-0.5 text-danger" aria-hidden="true">*</span> : null}
      </label>
      {control}
      {hasError ? (
        <p id={errorId} role="alert" className="m-0 text-caption text-danger">
          {error}
        </p>
      ) : null}
      {hint === undefined ? null : (
        <p id={hintId} className="m-0 text-caption text-subtle-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export { Field };
