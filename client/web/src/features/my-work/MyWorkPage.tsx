import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { REQUIREMENT_STATUS_LABELS, formatRequirementNumber } from "@suduo/cloud-contracts";
import type { SessionListItemDto, WorkbenchActionDto } from "@suduo/client-contracts";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  FolderXIcon,
  HandIcon,
  HourglassIcon,
  MessageSquareTextIcon,
  ListChecksIcon,
  RefreshCwIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/client.js";
import { invalidateMappingCaches } from "../../app/mapping-cache.js";
import { useCurrentProject } from "../../app/project-context.js";
import { clearSetupPending, readSetupPending, type SetupPendingItem } from "../../app/pages/setup-pending.js";
import { settingsQuery } from "../../app/queries.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import { relativeTime } from "../../ui/format.js";
import type { SessionUiStatus } from "../../ui/session-status.js";
import { usePersistentChoice } from "../../ui/use-persistent-state.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { DirectoryPicker } from "../requirements/components/DirectoryPicker.js";
import { SessionStatusDot } from "../sessions/SessionStatusDot.js";
import { formatClock } from "../sessions/stream/describe.js";
import { flattenSessions, sessionListQuery } from "../sessions/session-list.js";
import {
  groupByStatus,
  recentChanges,
  sessionsToShow,
  type AttentionItem,
  type MyRequirement,
} from "./model.js";
import { assignedToMeQuery, createdUnassignedQuery, useMyWorkData, workbenchQuery } from "./queries.js";

/**
 * 我的工作（需求 §4.3，默认落地页）：需要你处理 / 我的需求 / 会话 / 最近动态。
 * 数据来自三处，各自加载、各自失败、各自重试：
 * - 工作台聚合（待处理、我在做的需求）；
 * - 各项目「指派给我」的需求列表；
 * - 本机会话列表（与会话页、侧栏共用缓存，只读本机，不等需求服务）。
 * 后台刷新不转圈、不禁用按钮；只有点「刷新」时图标转。
 */
const SCOPES = ["all", "current"] as const;
type Scope = (typeof SCOPES)[number];

/** 地址里的 ?scope=all|current（可分享）；没写时用上次记住的。 */
export function validateMyWorkSearch(search: Record<string, unknown>): { scope?: Scope } {
  const scope = search["scope"];
  return scope === "all" || scope === "current" ? { scope } : {};
}

export function MyWorkPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = useCurrentProject();
  const settings = useQuery(settingsQuery);
  const meId = settings.data?.session?.user.id ?? null;
  const search = useSearch({ strict: false }) as { scope?: Scope };
  const [rememberedScope, rememberScope] = usePersistentChoice("suduo.my.scope", SCOPES, "all");
  const scope = search.scope ?? rememberedScope;
  const setScope = (next: Scope) => {
    rememberScope(next);
    void navigate({ to: "/my", search: { scope: next }, replace: true });
  };
  const [mappingToFix, setMappingToFix] = useState<Extract<WorkbenchActionDto, { kind: "invalid_mapping" }> | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const data = useMyWorkData();
  const { workbench, attention } = data;
  const sessionList = useInfiniteQuery(sessionListQuery("active"));

  // 整个工作台接口都没拿到（断网、本机服务出错）：各区块显示「暂不可用」，不能掉进「都处理完了」的空态。
  const workbenchFailed = workbench.isError && workbench.data === undefined;
  const workbenchError = workbenchFailed ? classifyFailure(workbench.error).message : null;
  const actionsError = workbenchError ?? (workbench.data?.actions.status === "unavailable" ? workbench.data.actions.error.message : null);
  const workingError = workbenchError ?? (workbench.data?.requirements.status === "unavailable" ? workbench.data.requirements.error.message : null);
  const sessions = flattenSessions(sessionList.data);
  const shownSessions = sessionsToShow(sessions);
  // 「进行中」只数在跑和等你确认的；出了问题的排在前面，但不算进行中。
  const activeSessions = shownSessions.filter((row) => row.status === "running" || row.status === "approval").length;
  const mine =
    scope === "current" && project !== null ? data.mine.filter((item) => item.remoteProjectId === project.id) : data.mine;
  const listQueries = [...data.assigned, ...data.created];
  const assignedFailed = listQueries.find((query) => query.isError && query.data === undefined);
  const assignedLoading = listQueries.some((query) => query.isPending) && mine.length === 0;

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: sessionListQuery("active").queryKey }),
        ...data.projects.flatMap((item) => [
          queryClient.invalidateQueries({ queryKey: assignedToMeQuery(item.id).queryKey }),
          queryClient.invalidateQueries({ queryKey: createdUnassignedQuery(item.id).queryKey }),
        ]),
      ]);
    } finally {
      setRefreshing(false);
    }
  };
  const openSession = (sessionId: string) => void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
  const openRequirement = (remoteProjectId: string, ref: string) =>
    void navigate({ to: "/p/$projectId/requirements/$number", params: { projectId: remoteProjectId, number: ref } });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-8 py-6">
        <header className="flex items-end gap-3">
          <div className="flex-1">
            <h1 className="m-0 text-page font-semibold text-foreground">我的工作</h1>
            <p className="m-0 mt-1 text-small text-muted-foreground">跨项目汇总需要你处理的事、在跑的会话和你的需求。</p>
          </div>
          <Button size="sm" variant="ghost" data-testid="workbench-refresh" onClick={() => void refreshAll()}>
            <RefreshCwIcon className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            刷新
          </Button>
        </header>

        <SetupChecklist mappingCount={settings.data?.mappingCount ?? null} onNavigate={(step) => void navigate({ to: "/setup", search: { step } })} />

        <Block title="需要你处理" count={attention.length} data-testid="workbench-actions">
          {workbench.isPending ? (
            <RowsSkeleton rows={2} />
          ) : actionsError !== null ? (
            <Unavailable label="待我处理的事" message={actionsError} onRetry={() => void workbench.refetch()} announce />
          ) : attention.length === 0 ? (
            <p className="m-0 flex items-center gap-2 py-2 text-small text-muted-foreground">
              <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
              都处理完了，暂时没有需要你出手的事。
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {attention.map((item) => (
                <AttentionRow
                  key={item.key}
                  item={item}
                  onOpenSession={openSession}
                  onOpenRequirement={(requirementProjectId, requirementId) => openRequirement(requirementProjectId, requirementId)}
                  onFixMapping={setMappingToFix}
                />
              ))}
            </ul>
          )}
        </Block>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-6">
            <Block
              title="我的需求"
              count={mine.length}
              data-testid="workbench-requirements"
              action={
                <SegmentedControl
                  size="sm"
                  aria-label="需求范围"
                  value={scope}
                  onValueChange={setScope}
                  options={[
                    { value: "all", label: "全部项目" },
                    { value: "current", label: project === null ? "当前项目" : project.name },
                  ]}
                />
              }
            >
              {workingError === null ? null : (
                <Unavailable label="我在做的需求" message={workingError} onRetry={() => void workbench.refetch()} announce={actionsError === null} />
              )}
              {assignedFailed === undefined ? null : (
                <Unavailable label="我负责 / 我提的需求" message={classifyFailure(assignedFailed.error).message} onRetry={() => void assignedFailed.refetch()} />
              )}
              {assignedLoading || workbench.isPending ? (
                <RowsSkeleton rows={3} />
              ) : mine.length === 0 ? (
                <p className="m-0 py-2 text-small text-muted-foreground">没有你负责、正在做或你提了还没人负责的需求。在需求页把需求指派给自己，或从需求开始会话。</p>
              ) : (
                <RequirementGroups items={mine} onOpen={(item) => openRequirement(item.remoteProjectId, item.number === null ? item.id : String(item.number))} />
              )}
            </Block>

            <Block title="会话" count={activeSessions} countLabel="进行中" data-testid="workbench-sessions">
              {sessionList.isPending ? (
                <RowsSkeleton rows={2} />
              ) : sessionList.isError && sessionList.data === undefined ? (
                <Unavailable label="本机会话" message={classifyFailure(sessionList.error).message} onRetry={() => void sessionList.refetch()} />
              ) : sessions.length === 0 ? (
                <p className="m-0 py-2 text-small text-muted-foreground">本机还没有会话。在需求页从某个需求开始会话。</p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 md:grid-cols-2">
                  {shownSessions.map(({ session, status }) => (
                    <SessionCard key={session.id} session={session} status={status} onOpen={() => openSession(session.id)} />
                  ))}
                </ul>
              )}
            </Block>
          </div>

          <Block title="最近动态" data-testid="workbench-activity">
            {assignedLoading || workbench.isPending ? (
              <RowsSkeleton rows={4} />
            ) : (
              <RecentList
                items={recentChanges(mine, meId)}
                onOpen={(item) => openRequirement(item.remoteProjectId, item.number === null ? item.id : String(item.number))}
              />
            )}
          </Block>
        </div>
      </div>
      {mappingToFix === null ? null : (
        <FixMappingDialog
          action={mappingToFix}
          onClose={() => setMappingToFix(null)}
          onSaved={() => {
            setMappingToFix(null);
            // 详情页的「本机代码目录」、设置页、首启清单都读关联：一起刷新，不等缓存过期。
            void invalidateMappingCaches(queryClient);
            void refreshAll();
          }}
        />
      )}
    </div>
  );
}

function Block({
  title,
  count,
  countLabel,
  action,
  children,
  ...rest
}: {
  title: string;
  count?: number;
  countLabel?: string;
  action?: ReactNode;
  children: ReactNode;
  "data-testid": string;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title} {...rest}>
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="m-0 text-section font-semibold text-foreground">{title}</h2>
        {count === undefined || count === 0 ? null : (
          <span className="text-caption text-subtle-foreground">
            {countLabel === undefined ? count : `${countLabel} ${count}`}
          </span>
        )}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

/** announce：同一原因导致几个区块一起失败时，只让第一个进读屏的警报，其余静默显示。 */
function Unavailable({ label, message, onRetry, announce = true }: { label: string; message: string; onRetry(): void; announce?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-small text-foreground" role={announce ? "alert" : undefined}>
      <AlertTriangleIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />
      <span className="flex-1">
        {label}暂不可用：{message}
      </span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function AttentionRow({
  item,
  onOpenSession,
  onOpenRequirement,
  onFixMapping,
}: {
  item: AttentionItem;
  onOpenSession(sessionId: string): void;
  onOpenRequirement(remoteProjectId: string, requirementId: string): void;
  onFixMapping(action: Extract<WorkbenchActionDto, { kind: "invalid_mapping" }>): void;
}) {
  const row = (props: { icon: ReactNode; title: string; detail: string; action: string; onClick(): void; testId: string }) => (
    <li>
      <button
        type="button"
        data-testid={props.testId}
        className="group flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onClick}
      >
        {props.icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-small font-medium text-foreground">{props.title}</span>
          <span className="truncate text-caption text-subtle-foreground">{props.detail}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-small font-medium text-primary-text">
          {props.action}
          <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
      </button>
    </li>
  );
  switch (item.kind) {
    case "pending_approval":
      return row({
        icon: <HandIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />,
        title: `等你确认 · ${item.action.sessionTitle}`,
        detail: `${item.action.projectName ?? "本机项目"} · ${item.action.pendingApprovals} 项等你确认${item.action.lastActivityAt === null ? "" : ` · ${relativeTime(item.action.lastActivityAt)}`}`,
        action: "去确认",
        onClick: () => onOpenSession(item.action.sessionId),
        testId: `workbench-action-pending_approval-${item.action.sessionId}`,
      });
    case "failed_turn":
      return row({
        icon: <AlertTriangleIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />,
        title: `上一轮没能完成 · ${item.action.sessionTitle}`,
        detail: `${item.action.projectName ?? "本机项目"}${item.action.lastActivityAt === null ? "" : ` · ${relativeTime(item.action.lastActivityAt)}`}`,
        action: "查看原因",
        onClick: () => onOpenSession(item.action.sessionId),
        testId: `workbench-action-failed_turn-${item.action.sessionId}`,
      });
    case "drift":
      return row({
        icon: <SparklesIcon className="size-4 shrink-0 text-primary-text" aria-hidden="true" />,
        title: `开工后需求有变化 · ${item.requirement.title ?? "需求"}`,
        detail: `${item.requirement.projectName ?? "项目"} · ${item.requirement.sessionCount} 个会话在做它，开工时看到的内容已经过时`,
        action: "看看改了什么",
        onClick: () => onOpenRequirement(item.requirement.remoteProjectId, item.requirement.requirementId),
        testId: `workbench-action-drift-${item.requirement.requirementId}`,
      });
    case "new_comments":
      return row({
        icon: <MessageSquareTextIcon className="size-4 shrink-0 text-primary-text" aria-hidden="true" />,
        title: `有新评论 · ${requirementLabel(item.requirement)}`,
        detail: `${item.requirement.projectName ?? "项目"} · ${item.count} 条你还没看过的评论`,
        action: "去看看",
        onClick: () => onOpenRequirement(item.requirement.remoteProjectId, requirementRef(item.requirement)),
        testId: `workbench-action-new_comments-${item.requirement.id}`,
      });
    case "stale":
      return row({
        icon: <HourglassIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />,
        title: `停滞较久 · ${requirementLabel(item.requirement)}`,
        detail: `${item.requirement.projectName ?? "项目"} · ${item.requirement.status === null ? "" : `${REQUIREMENT_STATUS_LABELS[item.requirement.status]} · `}${item.days} 天没有变化`,
        action: "推进一下",
        onClick: () => onOpenRequirement(item.requirement.remoteProjectId, requirementRef(item.requirement)),
        testId: `workbench-action-stale-${item.requirement.id}`,
      });
    case "invalid_mapping":
      return row({
        icon: <FolderXIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />,
        title: `本机代码目录不可用 · ${item.action.projectName ?? "项目"}`,
        detail: "目录可能被移动或删除，重新选一次就好。",
        action: "重新选择",
        onClick: () => onFixMapping(item.action),
        testId: `workbench-action-invalid_mapping-${item.action.remoteProjectId}`,
      });
  }
}

function requirementLabel(item: MyRequirement): string {
  return [item.number === null ? null : formatRequirementNumber(item.number), item.title ?? "需求"].filter(Boolean).join(" ");
}

function requirementRef(item: MyRequirement): string {
  return item.number === null ? item.id : String(item.number);
}

function RequirementGroups({ items, onOpen }: { items: MyRequirement[]; onOpen(item: MyRequirement): void }) {
  return (
    <div className="flex flex-col gap-4">
      {groupByStatus(items).map((group) => (
        <section key={group.status ?? "unknown"} className="flex flex-col gap-1" aria-label={group.status === null ? "状态未知" : REQUIREMENT_STATUS_LABELS[group.status]}>
          <h3 className="m-0 flex items-center gap-1.5 text-caption font-medium text-subtle-foreground">
            {group.status === null ? null : <StatusIcon status={group.status} aria-hidden="true" />}
            {group.status === null ? "状态未知" : REQUIREMENT_STATUS_LABELS[group.status]}
            <span>{group.items.length}</span>
          </h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {group.items.map((item) => (
              <li key={item.id} data-testid={item.working === null ? undefined : `workbench-requirement-${item.id}`}>
                <div className="flex min-h-10 items-center gap-2 rounded-md px-2 hover:bg-muted">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpen(item)}
                  >
                    <span className="w-16 shrink-0 font-mono text-caption text-subtle-foreground">
                      {item.number === null ? "REQ-—" : formatRequirementNumber(item.number)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-small text-foreground">{item.title ?? "需求暂不可用"}</span>
                  </button>
                  {item.working?.drift === true ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-xs px-1 text-caption text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpen(item)}
                    >
                      开工后需求有变化
                    </button>
                  ) : null}
                  {item.working !== null ? (
                    <span className="shrink-0 text-caption text-subtle-foreground">
                      {item.working.pendingApprovals > 0 ? "等你确认" : item.working.running ? "运行中" : `${item.working.sessionCount} 个会话`}
                    </span>
                  ) : null}
                  {item.unreadComments > 0 ? (
                    <span className="shrink-0 rounded-full bg-primary-soft px-1.5 text-caption font-medium text-primary-text">
                      {item.unreadComments} 条新评论
                    </span>
                  ) : null}
                  {item.assignedToMe ? <span className="shrink-0 text-caption text-subtle-foreground">你负责</span> : null}
                  {item.createdUnassigned ? <span className="shrink-0 text-caption text-warning">我提的 · 还没人负责</span> : null}
                  <span className="hidden w-24 shrink-0 truncate text-right text-caption text-subtle-foreground md:inline">{item.projectName ?? ""}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const SESSION_CARD_TEXT: Record<SessionUiStatus, (session: SessionListItemDto) => string> = {
  running: () => "运行中",
  approval: (session) => `等你确认 ${session.runStatus.pendingApprovals} 项`,
  error: (session) => (session.runStatus.lastTurnOutcome === "failed" ? "上一轮没能完成" : "会话出错了"),
  completed: () => "已完成",
  idle: () => "空闲",
};

/** 会话卡：状态点与文字同源（同一个 status）；副行写关联需求编号或项目，再给最后一句话。 */
function SessionCard({ session, status, onOpen }: { session: SessionListItemDto; status: SessionUiStatus; onOpen(): void }) {
  const requirementLabel =
    session.requirement === null
      ? session.project.name
      : [session.requirement.number === null ? null : formatRequirementNumber(session.requirement.number), session.requirement.title]
          .filter(Boolean)
          .join(" ") || "需求会话";
  const at = session.lastActivityAt ?? session.updatedAt;
  return (
    <li>
      <button
        type="button"
        data-testid={`workbench-session-${session.id}`}
        className="flex w-full flex-col gap-1 rounded-md border border-border bg-card px-3 py-2.5 text-left outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
      >
        <span className="flex w-full items-center gap-2">
          <SessionStatusDot status={status} />
          <span className="min-w-0 flex-1 truncate text-small font-medium text-foreground">{session.title || "未命名会话"}</span>
          <span className="shrink-0 text-caption text-subtle-foreground">{relativeTime(at)}</span>
        </span>
        <span className="truncate pl-5.5 text-caption text-subtle-foreground">
          {SESSION_CARD_TEXT[status](session)}
          {status === "running" && session.runStatus.runningSince != null ? <Elapsed since={session.runStatus.runningSince} /> : null} ·{" "}
          {requirementLabel}
        </span>
        {status === "running" && session.runStatus.activity ? (
          <span className="truncate pl-5.5 font-mono text-caption text-muted-foreground" data-testid="session-activity">
            {session.runStatus.activity}
          </span>
        ) : session.preview === null ? null : (
          <span className="truncate pl-5.5 text-caption text-muted-foreground">
            {session.preview.role === "user" ? "你：" : ""}
            {session.preview.text}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * 首启时跳过的事（需求 §4.2）：做完一项消失一项，全部完成后整块不显示；也可以直接关掉。
 * 代码目录那条以实际关联为准：已经有关联就不再提醒。
 */
function SetupChecklist({ mappingCount, onNavigate }: { mappingCount: number | null; onNavigate(step: number): void }) {
  const [items, setItems] = useState<SetupPendingItem[]>(readSetupPending);
  const visible = items.filter((item) => item.key !== "mapping" || mappingCount === 0);
  if (visible.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3" aria-label="还没做完的设置" data-testid="setup-checklist">
      <div className="flex items-center gap-2">
        <ListChecksIcon className="size-4 text-primary-text" aria-hidden="true" />
        <h2 className="m-0 flex-1 text-body font-semibold text-foreground">还有 {visible.length} 项设置没做完</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="不再提示"
          onClick={() => {
            clearSetupPending();
            setItems([]);
          }}
        >
          <XIcon />
        </Button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {visible.map((item) => (
          <li key={item.key} className="flex items-center gap-3 text-small">
            <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{item.title}</span>
              <span className="text-muted-foreground"> · {item.detail}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => onNavigate(item.key === "mapping" ? 4 : 3)}>
              {item.key === "mapping" ? "去关联" : "重新检查"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 运行中的会话已经跑了多久（每秒走一次）。 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="tabular-nums"> · 已用 {formatClock(now - since)}</span>;
}

function RecentList({ items, onOpen }: { items: MyRequirement[]; onOpen(item: MyRequirement): void }) {
  if (items.length === 0) {
    return <p className="m-0 py-2 text-small text-muted-foreground">最近没有别人改动你的需求。</p>;
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen(item)}
          >
            <span className="text-small text-foreground">
              <span className="font-medium">{item.updatedBy?.displayName ?? "有人"}</span> 更新了{" "}
              <span className="font-mono text-caption text-muted-foreground">{item.number === null ? "" : formatRequirementNumber(item.number)}</span>{" "}
              {item.title ?? ""}
            </span>
            <span className="text-caption text-subtle-foreground">
              {item.status === null ? "" : `${REQUIREMENT_STATUS_LABELS[item.status]} · `}
              {item.updatedAt === null ? "" : relativeTime(item.updatedAt)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function FixMappingDialog({
  action,
  onClose,
  onSaved,
}: {
  action: Extract<WorkbenchActionDto, { kind: "invalid_mapping" }>;
  onClose(): void;
  onSaved(): void;
}) {
  const [path, setPath] = useState("");
  const [valid, setValid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    // 提交按钮不禁用（技术设计 §6.2）：点了再说哪里不对。
    if (!valid) {
      setError(path.trim() === "" ? "先选一个代码目录。" : "这个目录现在用不了，换一个可以读写的目录。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.saveRequirementsMapping(action.remoteProjectId, path.trim());
      onSaved();
    } catch (cause) {
      setError(classifyFailure(cause).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>重新选择本机代码目录</DialogTitle>
          <DialogDescription>
            {action.projectName ?? "这个项目"}的代码目录不可用了。选一个可以读写的目录，之后这个项目的会话都在这里运行。
          </DialogDescription>
        </DialogHeader>
        <DirectoryPicker value={path} onChange={setPath} onValidityChange={setValid} />
        {error === null ? null : <InlineError kind="validation">{error}</InlineError>}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            使用这个目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
