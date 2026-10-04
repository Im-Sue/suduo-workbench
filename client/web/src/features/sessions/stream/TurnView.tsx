import {
  AlertTriangleIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleIcon,
  FileDiffIcon,
  FileSearchIcon,
  FolderTreeIcon,
  GlobeIcon,
  HandIcon,
  RotateCwIcon,
  SearchIcon,
  SquareIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  FileChangeEntry,
  PlanStepView,
  StepStatus,
  TimelineStep,
  TurnBlock,
  TurnPlan,
  TurnTimeline,
} from "../../../event-projection/timeline.js";
import { useT } from "../../../i18n/provider.js";
import { Markdown } from "../../../ui/markdown.js";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { collapseEmptyThinking, formatElapsed, stepGroupSummary, turnSummaryText } from "./describe.js";
import { UserBubble } from "./UserBubble.js";

/**
 * 一个回合（需求 §4.5「对话流」）：文字段落与步骤组按时间交错；计划在最前实时勾选；
 * 文件改动是卡片，点开在检查面板看 diff；结束时一行摘要；失败时错误卡带「重试」。
 */
export interface TurnViewActions {
  onOpenChange?(path: string): void;
  onViewChanges?(): void;
  onRetry?(turn: TurnTimeline): void;
  /** 回到这一轮开始前（用回合前的自动存档还原）。 */
  onRestoreBefore?(turn: TurnTimeline): void;
  /** Codex 报回的是绝对路径：显示时换成项目内相对路径。 */
  displayPath?(path: string): string;
}

export function TurnView({
  turn,
  slot,
  now,
  actions,
}: {
  turn: TurnTimeline;
  /** 需求动作卡等挂在回合末尾的内容。 */
  slot?: ReactNode;
  now: number;
  actions: TurnViewActions;
}) {
  const t = useT();
  const lastIndex = turn.blocks.length - 1;
  const visible = turn.blocks.filter((block) => block.kind !== "text" || block.text.trim() !== "");
  const thinking = turn.status === "running" && visible.length === 0 && turn.plan === null;
  return (
    <article className="flex flex-col gap-3" data-turn-id={turn.turnId ?? undefined} data-testid="turn" data-status={turn.status}>
      {turn.truncatedHead ? (
        <p className="m-0 text-caption text-subtle-foreground">{t.conversation.turn.truncatedHead}</p>
      ) : null}
      {turn.plan === null ? null : <PlanChecklist plan={turn.plan} running={turn.status === "running"} />}
      {thinking ? (
        <p className="m-0 inline-flex items-center gap-2 text-small text-muted-foreground" role="status">
          <Spinner size="sm" />
          {t.conversation.turn.thinking}
        </p>
      ) : null}
      {turn.blocks.map((block, index) => (
        <Block
          key={block.id}
          block={block}
          live={turn.status === "running" && index === lastIndex}
          now={now}
          actions={actions}
        />
      ))}
      {turn.error === null ? null : turn.error.retrying ? (
        <p className="m-0 inline-flex items-center gap-2 text-small text-warning" role="status">
          <RotateCwIcon className="size-3.5 animate-spin [animation-duration:2s]" aria-hidden="true" />
          {turn.error.message}
        </p>
      ) : (
        <ErrorCard message={turn.error.message} onRetry={actions.onRetry === undefined ? undefined : () => actions.onRetry?.(turn)} />
      )}
      {slot === undefined || slot === null ? null : (
        <div data-testid="assistant-turn-slot">{slot}</div>
      )}
      {turn.status === "running" || (turn.status === "failed" && turn.summary.filesChanged === 0) ? null : (
        <TurnFooter
          turn={turn}
          onViewChanges={actions.onViewChanges}
          onRestoreBefore={actions.onRestoreBefore === undefined ? undefined : () => actions.onRestoreBefore?.(turn)}
        />
      )}
    </article>
  );
}

function Block({ block, live, now, actions }: { block: TurnBlock; live: boolean; now: number; actions: TurnViewActions }) {
  switch (block.kind) {
    case "text":
      if (block.text.trim() === "") return null;
      return (
        <div className="min-w-0 text-body text-foreground" data-testid="assistant-text">
          <Markdown text={block.text} />
        </div>
      );
    case "steps":
      return <StepGroup steps={block.steps} live={live} now={now} />;
    case "file-change":
      return (
        <FileChangeCard
          changes={block.changes}
          status={block.status}
          onOpen={actions.onOpenChange}
          displayPath={actions.displayPath ?? ((path) => path)}
        />
      );
    case "user":
      return <UserBubble message={block.message} inline />;
  }
}

// ---------- 步骤组 ----------

function StepGroup({ steps, live, now }: { steps: TimelineStep[]; live: boolean; now: number }) {
  const t = useT();
  const running = steps.find((step) => step.status === "running");
  const waiting = steps.some((step) => step.status === "waiting");
  const failed = steps.some((step) => step.status === "failed" || (step.exitCode !== null && step.exitCode !== 0));
  // 进行中默认展开最后一组，结束后收起成一行；用户手动开合后以用户为准。
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (live && (running !== undefined || waiting));
  const started = Math.min(...steps.map((step) => step.startedTs));

  return (
    <section className="rounded-md border border-border bg-card" data-testid="turn-card">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setToggled(!open)}
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
        {running !== undefined ? (
          <>
            <Spinner size="sm" className="text-primary-text" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{running.title}</span>
            <span className="shrink-0 font-mono text-caption text-subtle-foreground">{formatElapsed(now - started)}</span>
          </>
        ) : waiting ? (
          <>
            <HandIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{t.conversation.turn.waiting}</span>
          </>
        ) : (
          <>
            {failed ? (
              <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            ) : (
              <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{stepGroupSummary(steps, t)}</span>
          </>
        )}
      </button>
      {open ? (
        <ol className="m-0 flex list-none flex-col gap-0.5 border-t border-border p-1.5">
          {collapseEmptyThinking(steps, t).map((step) => (
            <StepRow key={step.id} step={step} now={now} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

const STEP_ICON: Record<TimelineStep["kind"], typeof TerminalIcon> = {
  command: TerminalIcon,
  read: FileSearchIcon,
  search: SearchIcon,
  list: FolderTreeIcon,
  thinking: BrainIcon,
  tool: WrenchIcon,
  web: GlobeIcon,
  approval: HandIcon,
  other: CircleDashedIcon,
};

function StepRow({ step, now }: { step: TimelineStep; now: number }) {
  const t = useT();
  const text = t.conversation.turn;
  const hasBody = step.output.trim() !== "" || (step.kind === "command" && step.detail !== "");
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICON[step.kind];
  const duration = step.durationMs ?? (step.endedTs === null ? null : step.endedTs - step.startedTs);
  return (
    <li className="flex flex-col" data-testid="tool-card" data-status={step.status}>
      <button
        type="button"
        disabled={!hasBody}
        aria-expanded={hasBody ? open : undefined}
        className="flex min-h-7 items-center gap-2 rounded-sm px-1.5 text-left text-small outline-none enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        onClick={() => setOpen((value) => !value)}
      >
        <StepStatusMark status={step.status} />
        {step.kind === "approval" ? null : <Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />}
        <span className={cn("min-w-0 flex-1 truncate", step.status === "running" ? "text-foreground" : "text-muted-foreground")}>
          {step.title}
          {step.progress === null ? null : <span className="text-subtle-foreground"> · {step.progress}</span>}
        </span>
        {step.exitCode !== null && step.exitCode !== 0 ? (
          <span className="shrink-0 rounded-xs bg-danger-soft px-1 font-mono text-caption text-danger">{text.exitCode(step.exitCode)}</span>
        ) : null}
        {step.status === "aborted" && step.kind !== "approval" ? <span className="shrink-0 text-caption text-subtle-foreground">{text.unfinished}</span> : null}
        <span className="w-12 shrink-0 text-right font-mono text-caption text-subtle-foreground">
          {step.status === "running" ? formatElapsed(now - step.startedTs) : duration !== null && duration >= 1000 ? formatElapsed(duration) : ""}
        </span>
      </button>
      {open && hasBody ? <StepBody step={step} /> : null}
    </li>
  );
}

function StepBody({ step }: { step: TimelineStep }) {
  const t = useT();
  if (step.kind === "thinking") {
    return (
      <div className="ml-9 border-l border-border py-1 pl-3 text-small text-muted-foreground">
        <Markdown text={step.output} />
      </div>
    );
  }
  const output =
    step.output.length > OUTPUT_TAIL_CHARS
      ? `${t.conversation.turn.outputTruncated(OUTPUT_TAIL_CHARS)}\n${step.output.slice(-OUTPUT_TAIL_CHARS)}`
      : step.output;
  return (
    <div className="ml-9 mt-1 mb-1.5 overflow-hidden rounded-sm bg-code-bg">
      {step.detail === "" ? null : (
        <div className="border-b border-border px-2.5 py-1.5 font-mono text-caption text-foreground">
          <span className="select-none text-subtle-foreground">$ </span>
          {step.detail}
        </div>
      )}
      {output.trim() === "" ? null : (
        <pre className="m-0 max-h-72 overflow-auto px-2.5 py-2 font-mono text-caption leading-[18px] whitespace-pre-wrap text-muted-foreground">
          {output}
        </pre>
      )}
    </div>
  );
}

/** 步骤输出只显示末尾这么多字符。 */
const OUTPUT_TAIL_CHARS = 20_000;

function StepStatusMark({ status }: { status: StepStatus }) {
  const label = useT().conversation.turn.stepStatus;
  switch (status) {
    case "running":
      return <Spinner size="sm" className="text-primary-text" />;
    case "waiting":
      return <HandIcon className="size-3.5 shrink-0 text-warning" aria-label={label.waiting} />;
    case "completed":
      return <CheckIcon className="size-3.5 shrink-0 text-success" aria-label={label.completed} />;
    case "failed":
      return <XIcon className="size-3.5 shrink-0 text-danger" aria-label={label.failed} />;
    case "declined":
      return <XIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-label={label.declined} />;
    case "aborted":
      return <SquareIcon className="size-3 shrink-0 text-subtle-foreground" aria-label={label.aborted} />;
  }
}

// ---------- 改动卡 ----------

function FileChangeCard({
  changes,
  status,
  onOpen,
  displayPath,
}: {
  changes: FileChangeEntry[];
  status: StepStatus;
  onOpen?: ((path: string) => void) | undefined;
  displayPath(path: string): string;
}) {
  const text = useT().conversation.turn.changes;
  if (changes.length === 0) {
    return status === "running" ? (
      <p className="m-0 inline-flex items-center gap-2 text-small text-muted-foreground">
        <Spinner size="sm" />
        {text.writing}
      </p>
    ) : null;
  }
  const additions = changes.reduce((sum, change) => sum + change.additions, 0);
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0);
  const rejected = status === "declined" || status === "failed" || status === "aborted";
  return (
    <section className={cn("rounded-md border border-border bg-card", rejected && "opacity-70")} data-testid="change-card">
      <header className="flex h-9 items-center gap-2 border-b border-border px-3 text-small">
        <FileDiffIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
        <span className="font-medium text-foreground">
          {(status === "declined"
            ? text.title.declined
            : status === "failed"
              ? text.title.failed
              : status === "aborted"
                ? text.title.aborted
                : status === "running"
                  ? text.title.running
                  : text.title.done)(changes.length)}
        </span>
        <DiffStat additions={additions} deletions={deletions} />
      </header>
      <ul className="m-0 flex list-none flex-col p-1">
        {changes.map((change) => (
          <li key={change.path}>
            <button
              type="button"
              disabled={onOpen === undefined}
              className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-small outline-none enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpen?.(change.path)}
              title={onOpen === undefined ? displayPath(change.path) : text.viewInInspector(displayPath(change.path))}
            >
              <span className="w-8 shrink-0 text-caption text-subtle-foreground">{text.kind[change.kind]}</span>
              {/* 从左边截断：长路径也能看到文件名。 */}
              <span className="min-w-0 flex-1 truncate text-left font-mono text-caption text-foreground" dir="rtl">
                <bdi>{change.movePath === null ? displayPath(change.path) : `${displayPath(change.path)} → ${displayPath(change.movePath)}`}</bdi>
              </span>
              <DiffStat additions={change.additions} deletions={change.deletions} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="ml-auto shrink-0 font-mono text-caption">
      <span className="text-diff-add-fg">+{additions}</span> <span className="text-diff-del-fg">−{deletions}</span>
    </span>
  );
}

// ---------- 计划 ----------

function PlanChecklist({ plan, running }: { plan: TurnPlan; running: boolean }) {
  const text = useT().conversation.turn.plan;
  const done = plan.steps.filter((step) => step.status === "completed").length;
  return (
    <section className="rounded-md border border-border bg-card px-3 py-2.5" data-testid="plan-checklist" aria-label={text.label}>
      <header className="mb-1.5 flex items-center gap-2 text-small">
        <span className="font-medium text-foreground">{text.label}</span>
        <span className="text-caption text-subtle-foreground">
          {done}/{plan.steps.length}
        </span>
      </header>
      {plan.explanation === null ? null : <p className="m-0 mb-1.5 text-small text-muted-foreground">{plan.explanation}</p>}
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {plan.steps.map((step, index) => (
          <li key={`${index}:${step.text}`} className="flex items-start gap-2 text-small">
            <PlanMark status={step.status} running={running} />
            <span className={cn(step.status === "completed" ? "text-subtle-foreground line-through" : "text-foreground")}>{step.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PlanMark({ status, running }: { status: PlanStepView["status"]; running: boolean }) {
  const text = useT().conversation.turn.plan;
  if (status === "completed") return <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-label={text.completed} />;
  if (status === "in_progress" && running) return <Spinner size="sm" className="mt-0.5 text-primary-text" />;
  return <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" aria-label={status === "in_progress" ? text.inProgress : text.pending} />;
}

// ---------- 结束 ----------

function ErrorCard({ message, onRetry }: { message: string; onRetry?: (() => void) | undefined }) {
  const text = useT().conversation.turn.error;
  // 点过一次就不能再点：避免连点把同一句话排进队列好几份。
  const [retried, setRetried] = useState(false);
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5" role="alert" data-testid="turn-error">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 text-small font-medium text-foreground">{text.title}</p>
        <p className="m-0 text-small break-words text-muted-foreground">{message}</p>
      </div>
      {onRetry === undefined ? null : (
        <Button
          size="sm"
          variant="secondary"
          disabled={retried}
          onClick={() => {
            setRetried(true);
            onRetry();
          }}
        >
          <RotateCwIcon />
          {retried ? text.retried : text.retry}
        </Button>
      )}
    </div>
  );
}

function TurnFooter({
  turn,
  onViewChanges,
  onRestoreBefore,
}: {
  turn: TurnTimeline;
  onViewChanges?: (() => void) | undefined;
  onRestoreBefore?: (() => void) | undefined;
}) {
  const t = useT();
  return (
    // 对话栏窄时（或英文较长）按钮整体换到下一行，不在按钮文字中间折行。
    <footer className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-subtle-foreground" data-testid="turn-summary">
      <span className="flex min-w-0 items-center gap-2">
        {turn.status === "completed" ? (
          <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <SquareIcon className="size-3 shrink-0 text-subtle-foreground" aria-hidden="true" />
        )}
        <span>{turnSummaryText(turn, t)}</span>
      </span>
      {turn.summary.filesChanged > 0 && onViewChanges !== undefined ? (
        <button type="button" className="rounded-xs px-1 whitespace-nowrap text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={onViewChanges}>
          {t.conversation.turn.viewChanges}
        </button>
      ) : null}
      {turn.summary.filesChanged > 0 && onRestoreBefore !== undefined ? (
        <button type="button" className="rounded-xs px-1 whitespace-nowrap text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={onRestoreBefore}>
          {t.conversation.turn.restoreBefore}
        </button>
      ) : null}
    </footer>
  );
}
