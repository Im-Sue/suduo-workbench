import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  FolderGit2Icon,
  FolderIcon,
  HistoryIcon,
  KeyboardIcon,
  Link2Icon,
  XCircleIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type LocalDirInspectionDto } from "../../../api/client.js";
import { projectsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useT } from "../../../i18n/provider.js";
import type { Messages } from "../../../i18n/messages/index.js";

/**
 * 选择本机代码目录（需求 §4.4「开始会话」、首启向导第 4 步）。
 * 浏览器拿不到本机绝对路径，所以由本机服务列目录；也支持直接输入路径。
 * 选中后即时检查：能否读写、是否 Git 仓库、当前分支。
 * 键盘：↑↓ 移动，Enter / 空格选中，→ 进入子目录，← 回上一级（列表只占一个 Tab 位）。
 * 目录已关联给其他项目时只提示、不拦（一个目录可以关联多个项目，ADR-0004）。
 */
export function DirectoryPicker({
  value,
  onChange,
  onValidityChange,
  remoteProjectId,
}: {
  value: string;
  onChange(path: string): void;
  onValidityChange?(valid: boolean): void;
  /** 正在给哪个项目选目录：这个项目自己的关联不算「也关联给了」。 */
  remoteProjectId?: string;
}) {
  const t = useT();
  const text = t.requirements.directoryPicker;
  // 已有选择时从它的上一级开始浏览，当前目录在列表里可见；否则从主目录开始。
  const [browsePath, setBrowsePath] = useState<string | undefined>(() => parentOf(value));
  const [manual, setManual] = useState(false);
  const listing = useQuery({
    queryKey: ["local-dirs", browsePath ?? "~"],
    queryFn: ({ signal }) => api.listLocalDirs(browsePath, { signal }),
    staleTime: 10_000,
    retry: false,
  });
  const deferredValue = useDeferredValue(value.trim());
  const inspection = useQuery({
    queryKey: ["local-dir-inspect", deferredValue],
    queryFn: ({ signal }) => api.inspectLocalDir(deferredValue, { signal }),
    enabled: deferredValue !== "",
    staleTime: 5_000,
    retry: false,
  });
  const verdict = judge(deferredValue === "" ? undefined : inspection.data, t);
  const otherProjectIds = deferredValue === "" ? [] : otherLinkedProjects(inspection.data, remoteProjectId);
  // 只有真要显示「也关联给了」时才取项目名。
  const projects = useQuery({ ...projectsQuery, enabled: otherProjectIds.length > 0 });

  useEffect(() => {
    onValidityChange?.(verdict.tone === "ok" || verdict.tone === "warn");
  }, [onValidityChange, verdict.tone]);

  const segments = listing.data === undefined ? [] : breadcrumb(listing.data.path, listing.data.home);
  const entries = listing.data?.entries ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  // 用键盘进入 / 退出目录后，新列表载入时把焦点放进去（否则焦点随旧选项一起消失）。
  const focusAfterLoad = useRef(false);

  const focusOption = (index: number) => {
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[index]?.focus();
  };

  useEffect(() => {
    if (listing.data === undefined) return;
    const selectedIndex = listing.data.entries.findIndex((entry) => entry.path === value);
    const next = selectedIndex === -1 ? 0 : selectedIndex;
    setActive(next);
    if (focusAfterLoad.current) {
      focusAfterLoad.current = false;
      if (listing.data.entries.length > 0) window.requestAnimationFrame(() => focusOption(next));
      else listRef.current?.focus();
    }
    // 只在换了一个目录列表时重置；选中变化不移动焦点。
  }, [listing.data]);

  const browse = (path: string, byKeyboard: boolean) => {
    focusAfterLoad.current = byKeyboard;
    setBrowsePath(path);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = (index: number) => {
      event.preventDefault();
      const next = Math.max(0, Math.min(entries.length - 1, index));
      setActive(next);
      focusOption(next);
    };
    const current = entries[active];
    switch (event.key) {
      case "ArrowDown":
        return move(active + 1);
      case "ArrowUp":
        return move(active - 1);
      case "Home":
        return move(0);
      case "End":
        return move(entries.length - 1);
      case "Enter":
      case " ":
        if (current !== undefined) {
          event.preventDefault();
          onChange(current.path);
        }
        return;
      case "ArrowRight":
        if (current !== undefined) {
          event.preventDefault();
          browse(current.path, true);
        }
        return;
      case "ArrowLeft":
        if (listing.data?.parent != null) {
          event.preventDefault();
          browse(listing.data.parent, true);
        }
        return;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {manual ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="directory-manual" className="text-small font-medium">{text.manualLabel}</label>
          <Input
            id="directory-manual"
            autoFocus
            className="font-mono"
            placeholder="/Users/you/code/order-center"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border-strong">
          <div className="flex h-9 items-center gap-1 border-b border-border bg-muted px-1.5">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={text.up}
              disabled={listing.data?.parent === null || listing.data === undefined}
              onClick={() => listing.data?.parent != null && browse(listing.data.parent, false)}
            >
              <ChevronLeftIcon />
            </Button>
            <nav aria-label={text.location} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-caption text-muted-foreground">
              {segments.map((segment, index) => (
                <span key={segment.path} className="flex shrink-0 items-center gap-0.5">
                  {index > 0 ? <span aria-hidden="true">/</span> : null}
                  <button
                    type="button"
                    className="rounded-xs px-1 py-0.5 hover:bg-muted-strong hover:text-foreground"
                    onClick={() => browse(segment.path, false)}
                  >
                    {segment.label}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <div className="flex max-h-60 min-h-40 flex-col overflow-y-auto p-1">
            {listing.isPending ? (
              <div className="flex flex-col gap-2 p-2" aria-busy="true" aria-label={text.loading}>
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3.5 w-2/5" />
              </div>
            ) : null}
            {listing.isError ? (
              <div className="flex flex-col items-start gap-2 p-3">
                <p className="m-0 text-small text-danger">{text.loadFailed(classifyFailure(listing.error).message)}</p>
                {browsePath === undefined ? null : (
                  <Button size="sm" variant="secondary" onClick={() => setBrowsePath(undefined)}>
                    {text.goHome}
                  </Button>
                )}
              </div>
            ) : null}
            {listing.data?.entries.length === 0 ? (
              <p className="m-0 p-3 text-small text-subtle-foreground">{text.empty}</p>
            ) : null}
            <div
              ref={listRef}
              role="listbox"
              aria-label={listing.data === undefined ? text.listLabel : text.listLabelIn(listing.data.path)}
              tabIndex={entries.length === 0 ? -1 : undefined}
              className="flex flex-col outline-none"
              onKeyDown={onListKeyDown}
            >
              {entries.map((entry, index) => {
                const selected = entry.path === value;
                return (
                  <div
                    key={entry.path}
                    role="option"
                    aria-selected={selected}
                    tabIndex={index === active ? 0 : -1}
                    className={cn(
                      "flex h-8 w-full shrink-0 cursor-default items-center gap-2 rounded-[5px] px-2 text-left text-small outline-none",
                      "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "bg-primary-soft text-primary-text hover:bg-primary-soft",
                    )}
                    onFocus={() => setActive(index)}
                    onClick={() => onChange(entry.path)}
                    onDoubleClick={() => browse(entry.path, false)}
                  >
                    {entry.isGitRepo ? (
                      <FolderGit2Icon className="size-4 shrink-0 text-primary-text" aria-hidden="true" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    {entry.isGitRepo ? <span className="text-caption text-subtle-foreground">{text.gitRepo}</span> : null}
                  </div>
                );
              })}
            </div>
            {listing.data?.truncated === true ? (
              <p className="m-0 px-2 py-1.5 text-caption text-subtle-foreground">{text.truncated}</p>
            ) : null}
          </div>
        </div>
      )}

      {listing.data !== undefined && listing.data.recent.length > 0 && !manual ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-caption text-subtle-foreground">
            <HistoryIcon className="size-3.5" />
            {text.recent}
          </span>
          {listing.data.recent.slice(0, 4).map((path) => (
            <button
              key={path}
              type="button"
              className="max-w-56 truncate rounded-xs bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground hover:text-foreground"
              title={path}
              onClick={() => onChange(path)}
            >
              {path.split("/").at(-1) ?? path}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-5 items-center gap-2" aria-live="polite">
        {deferredValue !== "" && inspection.isFetching ? (
          <span className="inline-flex items-center gap-1.5 text-small text-subtle-foreground">
            <Spinner size="sm" />
            {text.checking}
          </span>
        ) : (
          <span className={cn("inline-flex items-center gap-1.5 text-small", TONE_CLASS[verdict.tone])}>
            {verdict.tone === "ok" ? <CheckCircle2Icon className="size-4" /> : null}
            {verdict.tone === "warn" ? <AlertTriangleIcon className="size-4" /> : null}
            {verdict.tone === "error" ? <XCircleIcon className="size-4" /> : null}
            {verdict.text}
          </span>
        )}
        <Button className="ml-auto" size="sm" variant="ghost" onClick={() => setManual((current) => !current)}>
          <KeyboardIcon />
          {manual ? text.browse : text.manual}
        </Button>
      </div>

      {otherProjectIds.length > 0 && !inspection.isFetching ? (
        <p className="m-0 flex items-start gap-1.5 text-small text-subtle-foreground">
          <Link2Icon className="mt-0.5 size-4 shrink-0" />
          {text.alsoLinked(
            otherProjectIds.map((id) => projects.data?.find((project) => project.id === id)?.name ?? null),
          )}
        </p>
      ) : null}
    </div>
  );
}

/** 这个目录还关联着哪些别的项目（不算正在选目录的这个项目）。 */
export function otherLinkedProjects(
  inspection: LocalDirInspectionDto | undefined,
  remoteProjectId: string | undefined,
): string[] {
  return (inspection?.linkedRemoteProjectIds ?? []).filter((id) => id !== remoteProjectId);
}

const TONE_CLASS = { idle: "text-subtle-foreground", ok: "text-success", warn: "text-warning", error: "text-danger" } as const;

function judge(
  inspection: LocalDirInspectionDto | undefined,
  t: Messages,
): { tone: keyof typeof TONE_CLASS; text: string } {
  const text = t.requirements.directoryPicker.verdict;
  if (inspection === undefined) return { tone: "idle", text: text.idle };
  if (!inspection.exists) return { tone: "error", text: text.missing };
  if (!inspection.isDirectory) return { tone: "error", text: text.notDirectory };
  if (!inspection.readable || !inspection.writable) return { tone: "error", text: text.noAccess };
  if (!inspection.isGitRepo) return { tone: "warn", text: text.notGitRepo };
  return { tone: "ok", text: inspection.branch === null ? text.ok : text.okOnBranch(inspection.branch) };
}

function parentOf(path: string): string | undefined {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("/") || trimmed === "") return undefined;
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function breadcrumb(path: string, home: string): { label: string; path: string }[] {
  const inHome = path === home || path.startsWith(`${home}/`);
  const base = inHome ? home : "";
  const rest = (inHome ? path.slice(home.length) : path).split("/").filter(Boolean);
  const items: { label: string; path: string }[] = [{ label: inHome ? "~" : "/", path: inHome ? home : "/" }];
  let current = base;
  for (const part of rest) {
    current = `${current}/${part}`;
    items.push({ label: part, path: current });
  }
  return items;
}
