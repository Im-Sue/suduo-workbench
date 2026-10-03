import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "../../../i18n/provider.js";

/**
 * 设置页外框与分组之间的约定：
 * - 表单分组把「有没有未保存的更改」登记到外框，外框据此在离开前提醒；
 * - 保存条渲染在外框底部的固定位置（不随内容滚走）。
 */
export interface SettingsFrameValue {
  saveBarHost: HTMLElement | null;
  /** title 为 null 表示这一处已没有未保存的更改。 */
  markDirty(id: string, title: string | null): void;
}

export const SettingsFrameContext = createContext<SettingsFrameValue | null>(null);

export function useUnsavedChanges(id: string, dirty: boolean, title: string): void {
  const frame = useContext(SettingsFrameContext);
  useEffect(() => {
    frame?.markDirty(id, dirty ? title : null);
  }, [dirty, frame, id, title]);
  useEffect(() => () => frame?.markDirty(id, null), [frame, id]);
}

/** 草稿型表单的底部保存条：有未保存的更改时出现；⌘S / Ctrl+S 保存。 */
export function SaveBar({
  dirty,
  saving,
  problems = 0,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  /** 需要修改的字段数：大于 0 时点保存会定位到第一个问题，而不是提交。 */
  problems?: number;
  onSave(): void;
  onDiscard(): void;
}) {
  const frame = useContext(SettingsFrameContext);
  const labels = useT().settings.saveBar;
  const visible = dirty || saving;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  // 保存成功或放弃后保存条消失：焦点原本在条上的话，交给分组标题，不让它掉到页面最外层。
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    if (visible || !focusInside.current) return;
    focusInside.current = false;
    // 用户已经把焦点放到别处了就不动。
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const heading = document.querySelector<HTMLElement>('[data-testid^="settings-group-"] h2');
    if (heading === null) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!saving) saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, visible]);

  if (!visible) return null;
  const text = saving ? labels.saving : problems > 0 ? labels.problems(problems) : labels.dirty;
  const bar = (
    <div
      role="region"
      aria-label={labels.label}
      data-testid="settings-dirty-bar"
      onFocusCapture={() => {
        focusInside.current = true;
      }}
      onBlurCapture={(event) => {
        // relatedTarget 为空＝焦点没去别的控件（按钮进入保存中被禁用、或正在卸载），仍算在条上。
        const next = event.relatedTarget as Node | null;
        if (next !== null && !event.currentTarget.contains(next)) focusInside.current = false;
      }}
      className="pointer-events-auto flex items-center gap-2.5 rounded-lg bg-popover py-2.5 pr-3 pl-4 text-small text-foreground shadow-overlay animate-in fade-in-0 slide-in-from-bottom-3"
    >
      {saving ? (
        <Spinner className="text-subtle-foreground" />
      ) : (
        <span aria-hidden="true" className={problems > 0 ? "size-2 rounded-full bg-danger" : "size-2 rounded-full bg-warning"} />
      )}
      <span aria-live="polite" className="min-w-0 flex-1 truncate">
        {text}
      </span>
      <Button size="sm" variant="ghost" type="button" disabled={saving} onClick={onDiscard}>
        {labels.discard}
      </Button>
      <Button size="sm" variant="primary" type="button" loading={saving} data-testid="settings-save" onClick={onSave}>
        {labels.save}
        <Kbd aria-hidden="true">⌘S</Kbd>
      </Button>
    </div>
  );
  if (frame?.saveBarHost != null) return createPortal(bar, frame.saveBarHost);
  return <div className="sticky bottom-4 mt-4">{bar}</div>;
}
