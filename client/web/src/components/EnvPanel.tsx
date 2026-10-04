import { useEffect, useState } from "react";
import { usePersistentState } from "../ui/use-persistent-state.js";
import type { GitCheckpointDto, GitStatusDto, SystemOpenTarget } from "@suduo/client-contracts";
import { api } from "../api/client.js";
import { formatRelativeTime, messageOf } from "../ui/format.js";
import { useT } from "../i18n/provider.js";
import { checkpointLabel } from "../ui/checkpoint-label.js";
import {
  ChevronRightIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  InfoIcon,
  MonitorIcon,
} from "lucide-react";
import { ConfirmDialog } from "../feedback/components/index.js";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { OpenMenu } from "./OpenMenu.js";


/**
 * 检查面板「环境」：改动量、代码目录、分支，检查点时间线与还原、回合前自动存档。
 */
export function EnvPanel(props: {
  projectId: string;
  projectRoot: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  refreshKey: string;
  running: boolean;
  openTargets: SystemOpenTarget[];
  onSystemOpen(path: string, mode: SystemOpenTarget): void;
  onError(message: string): void;
}) {
  const t = useT();
  const text = t.workbench.env;
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [checkpoints, setCheckpoints] = useState<GitCheckpointDto[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = usePersistentState(
    "suduo.ui.checkpointsOpen",
    false,
  );
  const [confirming, setConfirming] = useState<GitCheckpointDto | null>(null);
  const busy = acting !== null;

  const reload = (projectId: string) => {
    if (!projectId) {
      setStatus(null);
      setCheckpoints([]);
      return;
    }
    void api
      .gitStatus(projectId)
      .then(async (next) => {
        setStatus(next);
        setCheckpoints(
          next.available && next.repo
            ? (await api.gitCheckpoints(projectId)).items
            : [],
        );
      })
      .catch(() => setStatus(null));
  };

  useEffect(() => {
    reload(props.projectId);
  }, [props.projectId, props.refreshKey]);

  const act = async (tag: string, operation: () => Promise<void>) => {
    setActing(tag);
    try {
      await operation();
      reload(props.projectId);
    } catch (cause) {
      props.onError(messageOf(cause));
    } finally {
      setActing(null);
    }
  };

  const folderName =
    props.projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? text.folderFallback;

  return (
    <section className="flex flex-col gap-4" aria-label={text.label}>
      <dl className="m-0 grid grid-cols-[20px_64px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2.5 text-small">
        <FileDiffIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
        <dt className="text-subtle-foreground">{text.changes}</dt>
        <dd className="m-0 col-span-2 font-mono text-caption">
          {props.changedFiles > 0 ? (
            <>
              <span className="text-diff-add-fg">+{props.additions.toLocaleString("en-US")}</span>{" "}
              <span className="text-diff-del-fg">−{props.deletions.toLocaleString("en-US")}</span>
              <span className="ml-1.5 font-sans text-subtle-foreground">{text.files(props.changedFiles)}</span>
            </>
          ) : (
            <span className="font-sans text-subtle-foreground">{text.noChanges}</span>
          )}
        </dd>

        <MonitorIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
        <dt className="text-subtle-foreground">{text.folder}</dt>
        <dd className="m-0 min-w-0 truncate font-mono text-caption text-foreground" title={props.projectRoot}>
          {folderName}
        </dd>
        <dd className="m-0">
          <OpenMenu path="" targets={props.openTargets} onOpen={props.onSystemOpen} label={text.open} />
        </dd>

        {status?.available && status.repo ? (
          <>
            <GitBranchIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
            <dt className="text-subtle-foreground">{text.branch}</dt>
            <dd className="m-0 col-span-2 flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-caption text-foreground">{status.branch ?? text.detached}</span>
              <span className="shrink-0 text-caption text-subtle-foreground">
                {status.dirty > 0 ? text.uncommitted(status.dirty) : text.clean}
              </span>
            </dd>
          </>
        ) : null}
        {status !== null && !status.available ? (
          <>
            <InfoIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
            <dt className="text-subtle-foreground">{text.versionControl}</dt>
            <dd className="m-0 col-span-2 text-subtle-foreground">{text.noGit}</dd>
          </>
        ) : null}
      </dl>

      {status?.available && !status.repo ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3">
          <p className="m-0 text-small text-muted-foreground">{text.initHint}</p>
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            loading={acting === "init"}
            disabled={busy}
            onClick={() => void act("init", async () => void (await api.gitInit(props.projectId)))}
          >
            <GitBranchIcon />
            {text.init}
          </Button>
        </div>
      ) : null}

      {status?.available && status.repo ? (
        <section className="flex flex-col gap-2" aria-labelledby="checkpoint-heading">
          <div className="flex items-center gap-2">
            <h3 id="checkpoint-heading" className="m-0 flex-1 text-small font-semibold text-foreground">{text.checkpoints.heading}</h3>
            {/* ADR-0004：运行中保存只是「快照时点可能不理想」，仲裁者是人、可重存——告知后继续，不拒绝。 */}
            <Button
              size="sm"
              variant="secondary"
              data-testid="save-checkpoint"
              loading={acting === "save"}
              disabled={busy}
              title={props.running ? text.checkpoints.runningNote : text.checkpoints.saveTitle}
              onClick={() =>
                void act("save", async () => {
                  const result = await api.gitCheckpoint(props.projectId);
                  if (result.checkpoint === null) {
                    props.onError(text.checkpoints.nothingToSave);
                  }
                })
              }
            >
              <GitCommitHorizontalIcon />
              {text.checkpoints.save}
            </Button>
          </div>
          {props.running ? (
            <p className="m-0 text-caption text-warning" data-testid="checkpoint-running-note" role="note">
              {text.checkpoints.runningNote}
            </p>
          ) : null}
          {checkpoints.length === 0 ? (
            <p className="m-0 text-caption text-subtle-foreground">{text.checkpoints.empty}</p>
          ) : (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1 self-start rounded-xs text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((value) => !value)}
              >
                <ChevronRightIcon className={cn("size-3.5 transition-transform", historyOpen && "rotate-90")} aria-hidden="true" />
                {text.checkpoints.history(checkpoints.length)}
              </button>
              {historyOpen ? (
                <ol className="m-0 flex list-none flex-col border-l border-border p-0 pl-3" data-testid="checkpoint-timeline">
                  {checkpoints.slice(0, 12).map((checkpoint, index) => (
                    <li key={checkpoint.hash} className="relative flex min-h-8 items-center gap-2">
                      <span
                        className={cn(
                          "absolute -left-[17px] size-2 rounded-full border-2 border-card",
                          index === 0 ? "bg-primary" : "bg-muted-strong",
                        )}
                        title={index === 0 ? text.checkpoints.latest : text.checkpoints.item}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-small text-foreground" title={checkpoint.subject}>
                        {checkpointLabel(checkpoint, t)}
                      </span>
                      <time className="shrink-0 text-caption text-subtle-foreground">{formatRelativeTime(checkpoint.ts)}</time>
                      {/* ADR-0004 红线：还原会覆盖 Codex 正在写的文件（不可逆字节损失），运行中保留禁用，但把原因说清。 */}
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="restore-checkpoint"
                        loading={acting === `restore:${checkpoint.hash}`}
                        disabled={busy || props.running}
                        title={props.running ? text.checkpoints.restoreRunning : text.checkpoints.restoreTitle}
                        onClick={() => setConfirming(checkpoint)}
                      >
                        {text.checkpoints.restore}
                      </Button>
                    </li>
                  ))}
                </ol>
              ) : null}
            </>
          )}
          <label className="flex items-center gap-2 text-small text-foreground">
            <Switch
              checked={status.autoCheckpoint}
              disabled={busy}
              aria-label={text.checkpoints.autoSave}
              onCheckedChange={(checked) =>
                void act("toggle", async () => void (await api.gitSettings(props.projectId, checked)))
              }
            />
            {text.checkpoints.autoSave}
          </label>
          {status.lastError ? (
            <p className="m-0 text-caption text-warning">{text.checkpoints.autoSaveFailed(status.lastError)}</p>
          ) : null}
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={text.restoreConfirm.title}
        description={
          confirming === null
            ? ""
            : text.restoreConfirm.description(
                checkpointLabel(confirming, t),
                formatRelativeTime(confirming.ts),
                status?.hasRemote === true,
              )
        }
        confirmLabel={text.restoreConfirm.confirm}
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (target === null) return;
          void act(`restore:${target.hash}`, async () => void (await api.gitRestore(props.projectId, target.hash)));
        }}
      />
    </section>
  );
}
