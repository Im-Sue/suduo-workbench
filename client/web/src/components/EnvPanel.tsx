import { useEffect, useState } from "react";
import { usePersistentState } from "../ui/use-persistent-state.js";
import type { GitCheckpointDto, GitStatusDto, SystemOpenTarget } from "@suduo/client-contracts";
import { api } from "../api/client.js";
import { messageOf, relativeTime } from "../ui/format.js";
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

const AUTO_SUBJECT = "SuDuo 自动存档：回合开始前";
const MANUAL_PREFIX = "SuDuo 检查点：";

/** 运行中保存检查点的告知文案（ADR-0004：告知后继续）。 */
const CHECKPOINT_RUNNING_NOTE = "这一轮还在跑，现在存的快照可能不包含正在写入的改动";
/** 运行中不可还原的原因（ADR-0004 不可逆字节损失红线；后续提交可从 reflog 找回，所以不说「无法撤回」）。 */
const RESTORE_RUNNING_REASON = "回合进行中不可还原：会以检查点覆盖 Codex 正在写入的文件，可能丢失未提交改动";

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
    props.projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "本机项目";

  return (
    <section className="flex flex-col gap-4" aria-label="环境">
      <dl className="m-0 grid grid-cols-[20px_64px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2.5 text-small">
        <FileDiffIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
        <dt className="text-subtle-foreground">改动</dt>
        <dd className="m-0 col-span-2 font-mono text-caption">
          {props.changedFiles > 0 ? (
            <>
              <span className="text-diff-add-fg">+{props.additions.toLocaleString("en-US")}</span>{" "}
              <span className="text-diff-del-fg">−{props.deletions.toLocaleString("en-US")}</span>
              <span className="ml-1.5 font-sans text-subtle-foreground">{props.changedFiles} 个文件</span>
            </>
          ) : (
            <span className="font-sans text-subtle-foreground">暂无</span>
          )}
        </dd>

        <MonitorIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
        <dt className="text-subtle-foreground">目录</dt>
        <dd className="m-0 min-w-0 truncate font-mono text-caption text-foreground" title={props.projectRoot}>
          {folderName}
        </dd>
        <dd className="m-0">
          <OpenMenu path="" targets={props.openTargets} onOpen={props.onSystemOpen} label="打开" />
        </dd>

        {status?.available && status.repo ? (
          <>
            <GitBranchIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
            <dt className="text-subtle-foreground">分支</dt>
            <dd className="m-0 col-span-2 flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-caption text-foreground">{status.branch ?? "（游离）"}</span>
              <span className="shrink-0 text-caption text-subtle-foreground">
                {status.dirty > 0 ? `${status.dirty} 处未提交` : "干净"}
              </span>
            </dd>
          </>
        ) : null}
        {status !== null && !status.available ? (
          <>
            <InfoIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
            <dt className="text-subtle-foreground">版本管理</dt>
            <dd className="m-0 col-span-2 text-subtle-foreground">本机没有可用的 Git</dd>
          </>
        ) : null}
      </dl>

      {status?.available && !status.repo ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3">
          <p className="m-0 text-small text-muted-foreground">这个目录还没有版本管理。初始化后，每一轮开始前会自动存档，改坏了可以一键回到之前。</p>
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            loading={acting === "init"}
            disabled={busy}
            onClick={() => void act("init", async () => void (await api.gitInit(props.projectId)))}
          >
            <GitBranchIcon />
            初始化版本管理
          </Button>
        </div>
      ) : null}

      {status?.available && status.repo ? (
        <section className="flex flex-col gap-2" aria-labelledby="checkpoint-heading">
          <div className="flex items-center gap-2">
            <h3 id="checkpoint-heading" className="m-0 flex-1 text-small font-semibold text-foreground">检查点</h3>
            {/* ADR-0004：运行中保存只是「快照时点可能不理想」，仲裁者是人、可重存——告知后继续，不拒绝。 */}
            <Button
              size="sm"
              variant="secondary"
              data-testid="save-checkpoint"
              loading={acting === "save"}
              disabled={busy}
              title={props.running ? CHECKPOINT_RUNNING_NOTE : "把当前文件状态存为检查点"}
              onClick={() =>
                void act("save", async () => {
                  const result = await api.gitCheckpoint(props.projectId);
                  if (result.checkpoint === null) {
                    props.onError("当前没有需要保存的改动");
                  }
                })
              }
            >
              <GitCommitHorizontalIcon />
              保存检查点
            </Button>
          </div>
          {props.running ? (
            <p className="m-0 text-caption text-warning" data-testid="checkpoint-running-note" role="note">
              {CHECKPOINT_RUNNING_NOTE}
            </p>
          ) : null}
          {checkpoints.length === 0 ? (
            <p className="m-0 text-caption text-subtle-foreground">还没有检查点。</p>
          ) : (
            <>
              <button
                type="button"
                className="inline-flex items-center gap-1 self-start rounded-xs text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((value) => !value)}
              >
                <ChevronRightIcon className={cn("size-3.5 transition-transform", historyOpen && "rotate-90")} aria-hidden="true" />
                历史（{checkpoints.length}）
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
                        title={index === 0 ? "最新检查点" : "检查点"}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-small text-foreground" title={checkpoint.subject}>
                        {subjectLabel(checkpoint)}
                      </span>
                      <time className="shrink-0 text-caption text-subtle-foreground">{relativeTime(checkpoint.ts)}</time>
                      {/* ADR-0004 红线：还原会覆盖 Codex 正在写的文件（不可逆字节损失），运行中保留禁用，但把原因说清。 */}
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="restore-checkpoint"
                        loading={acting === `restore:${checkpoint.hash}`}
                        disabled={busy || props.running}
                        title={props.running ? RESTORE_RUNNING_REASON : "还原到此检查点"}
                        onClick={() => setConfirming(checkpoint)}
                      >
                        还原
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
              aria-label="回合前自动存档"
              onCheckedChange={(checked) =>
                void act("toggle", async () => void (await api.gitSettings(props.projectId, checked)))
              }
            />
            回合前自动存档
          </label>
          {status.lastError ? (
            <p className="m-0 text-caption text-warning">上次自动存档失败：{status.lastError}</p>
          ) : null}
        </section>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="还原到这个检查点？"
        description={
          confirming === null
            ? ""
            : `项目文件会恢复到「${subjectLabel(confirming)} · ${relativeTime(confirming.ts)}」时的状态，这之后新建的文件会被移走（.gitignore 里的除外）。还原前会先自动存一份当前状态（包括新建的文件），需要时可以再还原回来。${
                status?.hasRemote === true ? "这个仓库配置了远端，相关提交如果已经推送，请谨慎操作。" : ""
              }`
        }
        confirmLabel="还原"
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

function subjectLabel(checkpoint: GitCheckpointDto): string {
  if (checkpoint.auto || checkpoint.subject === AUTO_SUBJECT) {
    return "回合前自动存档";
  }
  if (checkpoint.subject.startsWith(MANUAL_PREFIX)) {
    return "检查点：" + checkpoint.subject.slice(MANUAL_PREFIX.length);
  }
  return checkpoint.subject;
}
