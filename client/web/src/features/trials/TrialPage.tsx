import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TrialDto, TrialEntryDto } from "@suduo/client-contracts";
import { CheckIcon, ExternalLinkIcon, GitBranchIcon, GitForkIcon, GitMergeIcon, HandIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { RegionError } from "../../feedback/components/index.js";
import { reportFailure } from "../../feedback/report.js";
import { useT } from "../../i18n/provider.js";
import { Markdown } from "../../ui/markdown.js";
import { showMessage } from "../../ui/message.js";
import { formatElapsed } from "../sessions/stream/describe.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const ACTIVE = new Set(["preparing", "queued", "running"]);
/** 采用成了（合并成功或保留了分支）；冲突、git 拒绝不算。 */
const adoptedOk = (entry: TrialEntryDto) => entry.adoptResult?.kind === "merged" || entry.adoptResult?.kind === "kept";

export const trialQuery = (trialId: string) =>
  queryOptions({
    queryKey: ["trial", trialId] as const,
    queryFn: ({ signal }) => api.getTrial(trialId, { signal }),
    // 还有版本在准备 / 运行时每 3 秒刷新（改动、状态随之更新）；都停下后放慢到 15 秒（在会话里接着发消息也能看到），全清理了不再刷新。
    refetchInterval: (query) =>
      query.state.data?.status === "closed" ? false : query.state.data?.entries.some((entry) => ACTIVE.has(entry.state) || entry.busy) === true ? 3_000 : 15_000,
  });

/**
 * 并行试做的比较视图（多 Agent 协作 S10，需求 4.5）：各版并排——状态、分支、最终回答、改动文件与增删、测试命令与结果、
 * 耗时；做完后「采用这一版」（合并到原分支 / 保留分支），采用结果如实告知（冲突时停在冲突状态由人处理）；
 * 「清理工作目录」先列出要删的路径与分支请用户确认（R11）。
 */
export function TrialPage({ trialId }: { trialId: string }) {
  const t = useT();
  const text = t.collab.trial;
  const query = useQuery(trialQuery(trialId));
  const client = useQueryClient();
  const [adopting, setAdopting] = useState<TrialEntryDto | null>(null);
  const [cleaning, setCleaning] = useState(false);
  if (query.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (query.isError) {
    const failure = classifyFailure(query.error);
    return (
      <div className="p-6">
        <RegionError kind={failure.kind} message={text.loadFailed(failure.message)} busy={query.isFetching} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  const trial = query.data;
  const update = (next: TrialDto) => client.setQueryData(["trial", trialId], next);
  const removable = trial.entries.filter((entry) => entry.cleanup !== null);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="trial-page">
      <header className="flex flex-col gap-1 border-b border-border px-6 py-4">
        <h1 className="m-0 flex items-center gap-2 text-section font-semibold text-foreground">
          <GitForkIcon className="size-4 text-subtle-foreground" aria-hidden="true" />
          {text.pageTitle}
          {trial.requirementLabel === null ? null : <span className="text-small font-normal text-muted-foreground">· {trial.requirementLabel}</span>}
        </h1>
        <p className="m-0 whitespace-pre-wrap text-small text-foreground">{trial.task}</p>
        <p className="m-0 text-caption text-subtle-foreground">
          {text.base(trial.baseCommit, trial.baseBranch)}
          {trial.setupCommand === null ? "" : ` · ${trial.setupCommand}`}
        </p>
        {trial.adoptResult === null ? null : <AdoptResult trial={trial} />}
        {removable.length === 0 ? null : (
          <div>
            <Button size="sm" variant="secondary" onClick={() => setCleaning(true)} data-testid="trial-cleanup">
              <Trash2Icon />
              {text.cleanup}
            </Button>
          </div>
        )}
      </header>
      <div className="grid min-h-0 gap-4 p-6" style={{ gridTemplateColumns: `repeat(${String(Math.max(1, trial.entries.length))}, minmax(0, 1fr))` }}>
        {trial.entries.map((entry) => (
          <EntryColumn key={entry.id} trial={trial} entry={entry} onAdopt={() => setAdopting(entry)} />
        ))}
      </div>
      {adopting === null ? null : <AdoptDialog trial={trial} entry={adopting} onClose={() => setAdopting(null)} onDone={update} />}
      {cleaning ? <CleanupDialog trial={trial} entries={removable} onClose={() => setCleaning(false)} onDone={update} /> : null}
    </div>
  );
}

function EntryColumn({ trial, entry, onAdopt }: { trial: TrialDto; entry: TrialEntryDto; onAdopt(): void }) {
  const t = useT();
  const text = t.collab.trial;
  const adopted = adoptedOk(entry);
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 rounded-md border bg-card p-4", adopted ? "border-primary" : "border-border")} data-testid="trial-entry" data-state={entry.state} data-agent-id={entry.agentId}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-body font-medium text-foreground">{entry.agentName}</span>
        <StateBadge state={entry.state} />
        {adopted ? (
          <span className="inline-flex items-center gap-1 rounded-xs bg-primary-soft px-1.5 text-caption text-primary-text">
            <CheckIcon className="size-3" aria-hidden="true" />
            {text.adopted}
          </span>
        ) : null}
      </header>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-caption">
        <dt className="text-subtle-foreground">{text.branch}</dt>
        <dd className="m-0 min-w-0 truncate font-mono text-muted-foreground" title={entry.branch}>
          {entry.branch}
          {entry.state === "removed" && entry.branchRemoved ? " ✕" : ""}
        </dd>
        <dt className="text-subtle-foreground">{text.path}</dt>
        <dd className="m-0 min-w-0 truncate font-mono text-muted-foreground" title={entry.path}>
          {entry.path}
        </dd>
      </dl>
      {entry.pendingApprovals === 0 ? null : (
        <p className="m-0 flex items-center gap-1 text-caption text-warning" data-testid="trial-waiting">
          <HandIcon className="size-3" aria-hidden="true" />
          {text.waitingApproval(entry.pendingApprovals)}
        </p>
      )}
      {entry.error === null ? null : <p className="m-0 text-caption text-danger">{entry.error}</p>}
      {entry.setupLog === null ? null : (
        <details className="text-caption" open={entry.state === "setup_failed"}>
          <summary className="cursor-pointer text-muted-foreground">{text.setupLog}</summary>
          <pre className="m-0 mt-1 max-h-40 overflow-auto rounded-sm bg-code-bg px-2 py-1.5 font-mono whitespace-pre-wrap text-foreground">{entry.setupLog}</pre>
        </details>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-caption font-medium text-muted-foreground">{text.finalMessage}</span>
        <div className="max-h-64 overflow-y-auto rounded-sm bg-muted px-2.5 py-1.5 text-small text-foreground">
          {entry.finalMessage === null ? <span className="text-muted-foreground">{text.noFinalMessage}</span> : <Markdown text={entry.finalMessage} />}
        </div>
      </div>
      <div className="flex flex-col gap-1 text-small">
        <span className="text-caption font-medium text-muted-foreground">
          {entry.changedFiles.length === 0 ? text.noChanges : text.changes(entry.changedFiles.length, entry.additions, entry.deletions)}
        </span>
        {entry.changedFiles.length === 0 ? null : (
          <ul className="m-0 flex max-h-48 list-none flex-col gap-0.5 overflow-y-auto p-0 font-mono text-caption" data-testid="trial-files">
            {entry.changedFiles.map((file) => (
              <li key={file.path} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-foreground" title={file.path}>
                  {file.path}
                </span>
                <span className="text-success">{file.additions === null ? "" : `+${String(file.additions)}`}</span>
                <span className="text-danger">{file.deletions === null ? "" : `−${String(file.deletions)}`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-caption font-medium text-muted-foreground">{text.tests}</span>
        {entry.tests.length === 0 ? (
          <span className="text-caption text-subtle-foreground">{text.noTests}</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-caption" data-testid="trial-tests">
            {entry.tests.map((test, index) => (
              <li key={`${test.command}-${String(index)}`} className="flex items-center gap-1.5">
                {test.exitCode === 0 ? <CheckIcon className="size-3 shrink-0 text-success" aria-hidden="true" /> : <XIcon className="size-3 shrink-0 text-danger" aria-hidden="true" />}
                <span className="min-w-0 truncate text-foreground" title={test.command}>
                  {test.command}
                </span>
                {test.exitCode === null || test.exitCode === 0 ? null : <span className="text-danger">({String(test.exitCode)})</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {entry.durationMs === null ? null : <span className="text-caption text-subtle-foreground">{text.duration(formatElapsed(entry.durationMs))}</span>}
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {entry.sessionId === null ? null : (
          <Button asChild size="sm" variant="ghost">
            <Link to="/sessions/$sessionId" params={{ sessionId: entry.sessionId }} data-testid="trial-open">
              <ExternalLinkIcon />
              {text.open}
            </Link>
          </Button>
        )}
        {entry.state === "completed" || entry.state === "interrupted" || entry.state === "turn_failed" ? (
          <Button size="sm" variant={trial.adoptedEntryId === null ? "primary" : "secondary"} onClick={onAdopt} data-testid="trial-adopt">
            <GitMergeIcon />
            {text.adopt}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function StateBadge({ state }: { state: TrialEntryDto["state"] }) {
  const t = useT();
  const active = ACTIVE.has(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-caption",
        state === "completed"
          ? "bg-success-soft text-success"
          : state === "setup_failed" || state === "failed" || state === "turn_failed"
            ? "bg-danger-soft text-danger"
            : "bg-muted text-muted-foreground",
      )}
      data-testid="trial-state"
    >
      {active ? <Spinner size="sm" /> : state === "completed" ? <CheckIcon className="size-3" aria-hidden="true" /> : state === "removed" ? null : <TriangleAlertIcon className="size-3" aria-hidden="true" />}
      {t.collab.trial.state[state] ?? state}
    </span>
  );
}

function AdoptResult({ trial }: { trial: TrialDto }) {
  const t = useT();
  const text = t.collab.trial.result;
  const result = trial.adoptResult;
  if (result === null) return null;
  const message =
    result.kind === "merged" ? text.merged(result.commit) : result.kind === "conflict" ? text.conflict(result.files.join(", ")) : result.kind === "refused" ? text.refused(result.message) : text.kept(result.branch);
  return (
    <p
      className={cn("m-0 rounded-md px-3 py-2 text-small", result.kind === "merged" || result.kind === "kept" ? "bg-success-soft text-foreground" : "bg-warning-soft text-foreground")}
      data-testid="trial-adopt-result"
      data-kind={result.kind}
    >
      {message}
    </p>
  );
}

/** 采用前说明合并到哪个分支（原目录现在的分支）、原目录有没有未提交的改动、之前采用过哪一版。 */
function AdoptDialog({ trial, entry, onClose, onDone }: { trial: TrialDto; entry: TrialEntryDto; onClose(): void; onDone(trial: TrialDto): void }) {
  const t = useT();
  const text = t.collab.trial;
  const [mode, setMode] = useState<"merge" | "keep-branch">("merge");
  const [busy, setBusy] = useState(false);
  // 按试做组记下的本机项目查（不经云端、不随目录关联变），合并就合并到它现在的分支。
  const repo = useQuery({ queryKey: ["trial-repo", trial.id], queryFn: () => api.trialRepo(trial.id), staleTime: 0 });
  const current = repo.data;
  const earlier = trial.entries.find((other) => other.id !== entry.id && adoptedOk(other));
  const adopt = async () => {
    setBusy(true);
    try {
      onDone(await api.adoptTrial(trial.id, { entryId: entry.id, mode }));
      onClose();
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.adoptFailed });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent size="md" data-testid="trial-adopt-dialog">
        <DialogHeader>
          <DialogTitle>{text.adoptTitle(entry.agentName)}</DialogTitle>
          <DialogDescription>{text.adoptDescription}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={mode} onValueChange={(value) => setMode(value === "keep-branch" ? "keep-branch" : "merge")}>
          <RadioCard value="merge" title={text.merge} description={text.mergeHint(current === undefined ? trial.baseBranch : current.branch)} data-testid="trial-adopt-merge" />
          <RadioCard value="keep-branch" title={text.keepBranch} description={text.keepBranchHint} data-testid="trial-adopt-keep" />
        </RadioGroup>
        {mode === "merge" && current?.dirty === true ? (
          <p className="m-0 rounded-md bg-warning-soft px-3 py-2 text-small text-foreground" data-testid="trial-adopt-dirty">
            {text.adoptDirty}
          </p>
        ) : null}
        {earlier === undefined ? null : (
          <p className="m-0 text-small text-muted-foreground" data-testid="trial-adopt-again">
            {text.adoptAgain(earlier.agentName)}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t.feedback.dialog.cancel}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void adopt()} data-testid="trial-adopt-confirm">
            {mode === "merge" ? <GitMergeIcon /> : <GitBranchIcon />}
            {text.adopt}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 删除前照各版的清理计划列出会删的工作目录与分支请用户确认（R11）：分支已合并 / 有没合并的提交 / 保留，各自写明。
 * 默认勾上没采用的版本；还在进行的版本不能勾（先停下）。
 */
function CleanupDialog({ trial, entries, onClose, onDone }: { trial: TrialDto; entries: TrialEntryDto[]; onClose(): void; onDone(trial: TrialDto): void }) {
  const t = useT();
  const text = t.collab.trial;
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(entries.filter((entry) => !adoptedOk(entry) && !entry.busy).map((entry) => entry.id)));
  const [busy, setBusy] = useState(false);
  const cleanup = async () => {
    setBusy(true);
    try {
      // 只有确认里写明「没合并的提交会丢」且勾上的版本，才允许 -D 删分支。
      const force = entries.filter((entry) => chosen.has(entry.id) && entry.cleanup?.branch === "delete-unmerged").map((entry) => entry.id);
      const next = await api.cleanupTrial(trial.id, [...chosen], force);
      onDone(next);
      const unfinished = next.entries.filter((entry) => chosen.has(entry.id) && entry.error !== null).length;
      showMessage(unfinished === 0 ? text.cleaned : text.cleanedPartly(unfinished), unfinished === 0 ? "success" : "warning");
      onClose();
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.cleanupFailed });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent size="md" data-testid="trial-cleanup-dialog">
        <DialogHeader>
          <DialogTitle>{text.cleanupTitle}</DialogTitle>
          <DialogDescription>{text.cleanupDescription}</DialogDescription>
        </DialogHeader>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {entries.map((entry) => {
            const id = `trial-clean-${entry.id}`;
            const plan = entry.cleanup!;
            const busyNow = entry.busy;
            const lines = [
              ...(plan.worktree ? [{ text: text.plan.worktree(entry.path), danger: false }] : []),
              ...(plan.gitSaid === null ? [] : [{ text: text.plan.gitSaid(plan.gitSaid), danger: true }]),
              ...(plan.branch === "delete-merged"
                ? [{ text: text.plan.branchMerged(entry.branch), danger: false }]
                : plan.branch === "delete-unmerged"
                  ? [{ text: plan.gitSaid === null ? text.plan.branchUnmerged(entry.branch) : text.plan.branchForced(entry.branch), danger: true }]
                  : plan.branch === "keep"
                    ? [{ text: text.plan.branchKeep(entry.branch), danger: false }]
                    : []),
            ];
            return (
              <li key={entry.id} className="flex items-start gap-2 text-small">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  disabled={busyNow}
                  checked={chosen.has(entry.id)}
                  onCheckedChange={(value) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (value === true) next.add(entry.id);
                      else next.delete(entry.id);
                      return next;
                    })
                  }
                  data-testid="trial-cleanup-entry"
                />
                <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col gap-0.5" data-testid="trial-cleanup-plan">
                  <span className="text-foreground">{entry.agentName}</span>
                  {lines.length === 0 ? <span className="text-caption text-muted-foreground">{text.plan.nothing}</span> : null}
                  {lines.map((line) => (
                    <span key={line.text} className={cn("break-all text-caption", line.danger ? "text-danger" : "text-muted-foreground")}>
                      {line.text}
                    </span>
                  ))}
                  {busyNow ? <span className="text-caption text-warning">{text.plan.busy}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t.feedback.dialog.cancel}
          </Button>
          <Button variant="danger" disabled={chosen.size === 0} loading={busy} onClick={() => void cleanup()} data-testid="trial-cleanup-confirm">
            <Trash2Icon />
            {text.cleanupConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
