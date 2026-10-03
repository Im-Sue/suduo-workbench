import { CheckIcon, LockKeyholeIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { sectionMeta, settingAnchorId, type SettingsSectionId } from "../sections.js";

/**
 * 设置页的行式布局（需求 §4.7）：每组一个标题 + 说明，下面一行一项——左边标题与说明，右边控件。
 * 保存语义靠控件形态区分：开关 / 单选即时生效并在原位显示「已保存」；多字段表单用底部保存条。
 */

export function SettingsSection({
  id,
  description,
  badge,
  actions,
  children,
}: {
  id: SettingsSectionId;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const title = sectionMeta(id).title;
  return (
    <section aria-labelledby={`settings-${id}-title`} className="flex flex-col" data-testid={`settings-group-${id}`}>
      <header className="mb-2 flex flex-col gap-1">
        <div className="flex min-h-8 flex-wrap items-center gap-2.5">
          <h2 id={`settings-${id}-title`} className="m-0 text-page font-semibold text-foreground">
            {title}
          </h2>
          {badge}
          {actions === undefined ? null : <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
        {description === undefined ? null : <p className="m-0 text-small text-muted-foreground">{description}</p>}
      </header>
      {children}
    </section>
  );
}

export const rowLabelId = (anchor: string) => `${settingAnchorId(anchor)}-label`;
export const rowDescId = (anchor: string) => `${settingAnchorId(anchor)}-desc`;

export function SettingsRow({
  anchor,
  title,
  description,
  htmlFor,
  status,
  stacked = false,
  children,
  className,
}: {
  anchor: string;
  title: ReactNode;
  description?: ReactNode;
  /** 控件是单个输入框时，标题渲染成它的 <label>。 */
  htmlFor?: string;
  /** 标题旁的原位状态（已保存 / 锁定等）。 */
  status?: ReactNode;
  /** 控件较宽（单选卡片、列表）时上下排列。 */
  stacked?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const TitleTag = htmlFor === undefined ? "span" : "label";
  return (
    <div
      id={settingAnchorId(anchor)}
      data-setting-row={anchor}
      className={cn(
        "scroll-mt-6 border-b border-border py-[18px] last:border-b-0 data-[flash=true]:animate-flash",
        stacked ? "flex flex-col gap-3" : "grid grid-cols-1 gap-3 @xl:grid-cols-[200px_minmax(0,1fr)] @xl:gap-7",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
          <TitleTag
            id={rowLabelId(anchor)}
            {...(htmlFor === undefined ? {} : { htmlFor })}
            className="text-body font-medium text-foreground"
          >
            {title}
          </TitleTag>
          {status}
        </div>
        {description === undefined ? null : (
          <p id={rowDescId(anchor)} className="m-0 text-small text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children === undefined ? null : <div className="flex min-w-0 flex-col justify-center gap-2">{children}</div>}
    </div>
  );
}

/** 行列表的外框：用于代码目录、Skills、MCP、诊断等「一行一个对象」的列表。 */
export function ItemList({ label, className, ...rest }: ComponentProps<"ul"> & { label: string }) {
  return (
    <ul
      aria-label={label}
      className={cn("m-0 list-none overflow-hidden rounded-md border border-border p-0", className)}
      {...rest}
    />
  );
}

export function ItemRow({ className, ...rest }: ComponentProps<"li">) {
  return (
    <li
      className={cn("flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5 last:border-b-0", className)}
      {...rest}
    />
  );
}

export type SaveState = "idle" | "saving" | "saved";

/**
 * 即时生效控件的原位反馈：保存中显示「正在保存…」，成功后「已保存」停留 2 秒；
 * 失败时回到 idle（失败提示与回滚由调用方的 mutation 负责）。
 */
export function useSaveIndicator(): [SaveState, (work: Promise<unknown> | (() => void)) => void] {
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<number | null>(null);
  const token = useRef(0);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const track = useCallback((work: Promise<unknown> | (() => void)) => {
    const current = ++token.current;
    if (timer.current !== null) window.clearTimeout(timer.current);
    const done = () => {
      if (current !== token.current) return;
      setState("saved");
      timer.current = window.setTimeout(() => setState("idle"), 2_000);
    };
    if (typeof work === "function") {
      work();
      done();
      return;
    }
    setState("saving");
    work.then(done, () => {
      if (current === token.current) setState("idle");
    });
  }, []);
  return [state, track];
}

export function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span aria-live="polite" className="inline-flex items-center">
      {state === "saving" ? (
        <span className="inline-flex items-center gap-1 text-caption text-subtle-foreground">
          <Spinner size="sm" />
          正在保存…
        </span>
      ) : null}
      {state === "saved" ? (
        <span className="inline-flex items-center gap-1 text-caption text-success" data-testid="settings-saved-flash">
          <CheckIcon aria-hidden="true" className="size-3.5" />
          已保存
        </span>
      ) : null}
    </span>
  );
}

/** 被管理员限制的设置：说清是谁限制的、该找谁，而不是只把控件灰掉。 */
export function LockNote({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-start gap-1.5 text-small text-warning" data-testid="settings-lock-reason">
      <LockKeyholeIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

const PILL_TONE = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-muted text-muted-foreground",
} as const;

/** 分组标题旁的状态胶囊（已连接 / 未配置 / 有提醒）。 */
export function StatusPill({ tone, children }: { tone: keyof typeof PILL_TONE; children: ReactNode }) {
  return (
    <span
      className={cn("inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-caption font-medium", PILL_TONE[tone])}
      data-tone={tone}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** 首次读取时的骨架：按行式布局画。 */
export function SectionSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid grid-cols-1 gap-3 border-b border-border py-[18px] last:border-b-0 @xl:grid-cols-[200px_minmax(0,1fr)] @xl:gap-7">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-8 w-full max-w-80" />
        </div>
      ))}
    </div>
  );
}
