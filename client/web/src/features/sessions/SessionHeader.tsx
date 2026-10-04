import type { SessionDto } from "@suduo/client-contracts";
import { FileTextIcon, FolderGit2Icon, InfoIcon, PanelRightIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import type { StreamNotice } from "../../event-projection/reducer.js";
import { useT } from "../../i18n/provider.js";
import { sessionStatusLabel, type SessionUiStatus } from "../../ui/session-status.js";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SessionStatusDot } from "./SessionStatusDot.js";

/**
 * 会话头（需求 §4.5）：标题（原地重命名）、关联需求、代码目录、状态；
 * 模型配置类提示收进这里的提示图标，不进对话流；右侧开关检查面板（⌘J）。
 */
export function SessionHeader({
  session,
  status,
  requirement,
  projectRoot,
  notices,
  inspectorOpen,
  onRename,
  onOpenRequirement,
  onToggleInspector,
}: {
  session: SessionDto;
  status: SessionUiStatus;
  requirement: { title: string | null } | null;
  projectRoot: string;
  notices: readonly StreamNotice[];
  inspectorOpen: boolean;
  onRename(title: string): void;
  onOpenRequirement(): void;
  onToggleInspector(): void;
}) {
  const t = useT();
  const text = t.conversation.header;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title !== "" && title !== session.title) onRename(title);
  };
  const folder = projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? projectRoot;

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border pr-3 pl-5">
      <SessionStatusDot status={status} />
      {editing ? (
        <>
          <label htmlFor="session-title-input" className="sr-only">{text.titleLabel}</label>
          <input
            id="session-title-input"
            data-testid="session-title-input"
            className="h-8 min-w-0 flex-1 rounded-sm border border-primary bg-card px-2 text-body font-semibold text-foreground outline-none"
            value={draft}
            maxLength={120}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
        </>
      ) : (
        <div className="group/title flex min-w-0 items-center gap-1">
          <h1 className="m-0 truncate text-body font-semibold text-foreground" data-testid="session-title" title={session.title}>
            {session.title}
          </h1>
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-subtle-foreground opacity-0 outline-none group-hover/title:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="rename-session"
            aria-label={text.rename}
            title={text.rename}
            onClick={() => {
              setDraft(session.title);
              setEditing(true);
            }}
          >
            <PencilIcon className="size-3.5" />
          </button>
        </div>
      )}
      <span className="shrink-0 text-caption text-subtle-foreground" data-testid="session-status" data-status={status}>
        {sessionStatusLabel(status)}
      </span>
      {requirement === null ? null : (
        <button
          type="button"
          className="inline-flex h-6 min-w-0 max-w-64 items-center gap-1 rounded-sm bg-muted px-2 text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          title={text.requirementHint}
          data-testid="side-requirement-entry"
          onClick={onOpenRequirement}
        >
          <FileTextIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{requirement.title ?? text.requirementFallback}</span>
        </button>
      )}
      <div className="flex-1" />
      {projectRoot === "" ? null : (
        <span className="hidden min-w-0 items-center gap-1 font-mono text-caption text-subtle-foreground lg:inline-flex" title={projectRoot}>
          <FolderGit2Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{folder}</span>
        </span>
      )}
      {notices.length === 0 ? null : (
        <Popover>
          {/* 不与 Tooltip 叠两层 asChild 触发器：直接用 title。 */}
          <PopoverTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={text.noticesLabel(notices.length)} title={text.noticesTitle}>
              <InfoIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96">
            <p className="m-0 mb-2 text-small font-medium text-foreground">{text.noticesTitle}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {notices.map((notice) => (
                <li key={notice.id} className="text-small text-muted-foreground">{notice.text}</li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={inspectorOpen ? text.closeInspector : text.openInspector}
            aria-pressed={inspectorOpen}
            className={cn(inspectorOpen && "bg-muted text-foreground")}
            onClick={onToggleInspector}
          >
            <PanelRightIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {text.inspector} <Kbd>⌘J</Kbd>
        </TooltipContent>
      </Tooltip>
    </header>
  );
}
