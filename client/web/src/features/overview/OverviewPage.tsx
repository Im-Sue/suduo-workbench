import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  PROJECT_STATS_WINDOWS,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUS_LABELS,
  STALE_RHYTHM,
  formatRequirementNumber,
  type ProjectStatsWindow,
  type DailyRequirementTransitionDto,
  type RequirementStatus,
  type StaleRequirementDto,
} from "@suduo/cloud-contracts";
import { AlertTriangleIcon, ChartColumnIcon, CheckCircle2Icon, PlusIcon } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";
import { api } from "../../api/client.js";
import { useCurrentProject } from "../../app/project-context.js";
import { classifyFailure } from "../../feedback/classify.js";
import { relativeTime } from "../../ui/format.js";
import { usePersistentChoice } from "../../ui/use-persistent-state.js";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusIcon } from "@/components/ui/status-icon";
import { cn } from "@/lib/utils";
import { requirementKeys } from "../requirements/keys.js";
import { useRequirementsRealtimeState } from "../requirements/realtime.js";
import { OverviewTimeline } from "./OverviewTimeline.js";

/**
 * 项目概览（需求 §4.6）：状态分布、流转趋势、停滞需求、最近动态。
 * 查询挂在项目键下：需求变化的实时事件会让它们一起刷新；统计与动态各自加载、各自失败。
 */
const TransitionChart = lazy(() => import("./TransitionChart.js"));

/** 「开发中 / 测试中 3 天、梳理中 / 待开发 7 天、草稿 14 天、暂缓 30 天」：按 STALE_RHYTHM 生成，改表即改文案。 */
export function staleRuleText(): string {
  const byDays = new Map<number, string[]>();
  for (const status of REQUIREMENT_STATUSES) {
    const rhythm = STALE_RHYTHM[status];
    if (rhythm === null) continue;
    byDays.set(rhythm.notice, [...(byDays.get(rhythm.notice) ?? []), REQUIREMENT_STATUS_LABELS[status]]);
  }
  return [...byDays.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([days, labels]) => `${labels.join(" / ")} ${days} 天`)
    .join("、");
}

/** 地址里的 ?range=7d|30d（可分享）；没写时用上次记住的。 */
export function validateOverviewSearch(search: Record<string, unknown>): { range?: ProjectStatsWindow } {
  const range = search["range"];
  return range === "7d" || range === "30d" ? { range } : {};
}

export function OverviewPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { project } = useCurrentProject();
  const realtime = useRequirementsRealtimeState();
  const search = useSearch({ strict: false }) as { range?: ProjectStatsWindow };
  const [rememberedWindow, rememberWindow] = usePersistentChoice("suduo.overview.window", PROJECT_STATS_WINDOWS, "7d");
  const statsWindow = search.range ?? rememberedWindow;
  const setStatsWindow = (range: ProjectStatsWindow) => {
    rememberWindow(range);
    void navigate({ to: "/p/$projectId/overview", params: { projectId }, search: { range }, replace: true });
  };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const stats = useQuery({
    queryKey: requirementKeys.overviewStats(projectId, statsWindow, timeZone),
    queryFn: () => api.getProjectStats(projectId, { window: statsWindow, tz: timeZone }),
    staleTime: 30_000,
    // 切时间范围 / 停滞门槛时先留着上一份，数据回来再换（期间变淡，文案按实际显示的数据写）。
    placeholderData: (previous) => previous,
  });
  const audit = useQuery({
    queryKey: requirementKeys.overviewAudit(projectId),
    queryFn: () => api.listRequirementsAudit({ projectId, limit: 50 }),
    staleTime: 30_000,
  });

  const openRequirement = (item: StaleRequirementDto) =>
    void navigate({
      to: "/p/$projectId/requirements/$number",
      // 旧版需求服务不返回编号：用 id 打开，详情页会换成编号地址。
      params: { projectId, number: typeof item.number === "number" ? String(item.number) : item.id },
    });
  const openStatus = (status: RequirementStatus) =>
    void navigate({ to: "/p/$projectId/requirements", params: { projectId }, search: { status } });

  const statsFailed = stats.isError && stats.data === undefined;
  const statusCounts = stats.data?.statusCounts;
  const total = statusCounts === undefined ? 0 : REQUIREMENT_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0);
  // 旧版需求服务（不返回 staleTotal）按统一天数与进行中的几个状态筛，或只列最久没动的几条：
  // 这里按同一张节奏表再筛掉没到门槛的；旧服务没返回的（例如开发中 3–6 天、草稿、暂缓）界面上看不到，下面照实说明。
  const stale = (stats.data?.staleRequirements ?? []).filter((item) => item.level !== "normal");
  const legacyStale = stats.data !== undefined && stats.data.staleTotal === undefined;
  const staleTotal = Math.max(stats.data?.staleTotal ?? stale.length, stale.length);
  const transitions = stats.data?.transitions ?? [];
  const transitionTotal = transitions.reduce((sum, day) => sum + day.count, 0);
  // 文案按正在显示的数据写：切换期间显示的还是上一个范围。
  const shownRange = transitions.length > 7 ? "近 30 天" : "近 7 天";
  const refreshing = stats.isPlaceholderData;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-8 py-6">
        <header className="flex items-end gap-3">
          <div className="flex-1">
            <h1 className="m-0 text-page font-semibold text-foreground">概览</h1>
            <p className="m-0 mt-1 text-small text-muted-foreground">
              {project?.name ?? "当前项目"}的需求分布、流转和停滞情况。
            </p>
          </div>
          <span className="text-caption text-subtle-foreground" role="status" data-testid="overview-realtime-state">
            {realtime === "live" ? "实时更新中" : realtime === "reconnecting" ? "实时更新已断开，正在重连…" : "正在连接实时更新…"}
          </span>
        </header>

        {/* 统计接口失败时只在这里报一次（role=alert），下面两个区块给静默的重试入口，读屏不会连播三遍。 */}
        <Block title="状态分布" subtitle={total > 0 ? `共 ${total} 条需求` : undefined}>
          {stats.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : statsFailed ? (
            <Failure label="统计" error={stats.error} onRetry={() => void stats.refetch()} announce />
          ) : total === 0 ? (
            <div className="flex items-center gap-3 py-2">
              <p className="m-0 text-small text-muted-foreground">这个项目还没有需求。</p>
              <Button size="sm" variant="secondary" onClick={() => void navigate({ to: "/p/$projectId/requirements", params: { projectId } })}>
                <PlusIcon />
                去新建第一条
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" data-testid="overview-status-funnel">
              {REQUIREMENT_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  className="flex flex-col items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${REQUIREMENT_STATUS_LABELS[status]}：${statusCounts?.[status] ?? 0} 条，查看这些需求`}
                  onClick={() => openStatus(status)}
                >
                  <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
                    <StatusIcon status={status} aria-hidden="true" />
                    {REQUIREMENT_STATUS_LABELS[status]}
                  </span>
                  <span className={cn("text-page font-semibold tabular-nums", (statusCounts?.[status] ?? 0) === 0 ? "text-subtle-foreground" : "text-foreground")}>
                    {statusCounts?.[status] ?? 0}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Block>

        <Block
          title="流转趋势"
          subtitle={stats.data === undefined ? undefined : `${shownRange}共 ${transitionTotal} 次状态变化`}
          action={
            <SegmentedControl
              size="sm"
              aria-label="时间范围"
              value={statsWindow}
              onValueChange={setStatsWindow}
              options={[
                { value: "7d", label: "7 天" },
                { value: "30d", label: "30 天" },
              ]}
            />
          }
        >
          <div
            className={cn("rounded-md border border-border bg-card p-3 transition-opacity", refreshing && "opacity-60")}
            aria-busy={refreshing}
            data-testid="overview-transition-chart"
          >
            {stats.isPending ? (
              <Skeleton className="h-[220px] w-full" />
            ) : statsFailed ? (
              <Failure label="流转趋势" error={stats.error} onRetry={() => void stats.refetch()} />
            ) : transitionTotal === 0 ? (
              <div className="flex h-[160px] flex-col items-center justify-center gap-2 text-center">
                <ChartColumnIcon className="size-5 text-subtle-foreground" aria-hidden="true" />
                <p className="m-0 text-small text-muted-foreground">这段时间没有需求改过状态。</p>
              </div>
            ) : (
              <Suspense fallback={<Skeleton className="h-[220px] w-full" />}>
                <TransitionChart transitions={transitions} />
              </Suspense>
            )}
            <TransitionTable transitions={transitions} caption={`${shownRange}每天进入各状态的次数`} />
          </div>
        </Block>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Block
            title="停滞需求"
            subtitle={
              stats.data === undefined
                ? undefined
                : staleTotal > stale.length
                  ? `共 ${staleTotal} 条，先列最要紧的 ${stale.length} 条`
                  : undefined
            }
          >
            <p className="m-0 -mt-1 text-caption text-subtle-foreground">
              {legacyStale
                ? "需求服务的版本较旧，这里只列出它给出的停滞需求；升级后按各状态的节奏判断。"
                : `按各状态的节奏：${staleRuleText()}没有变化就列出来；停滞较久的在前。`}
            </p>
            {stats.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : statsFailed ? (
              <Failure label="停滞需求" error={stats.error} onRetry={() => void stats.refetch()} />
            ) : stale.length === 0 ? (
              <p className="m-0 flex items-center gap-2 py-3 text-small text-muted-foreground">
                <CheckCircle2Icon className="size-4 text-success" aria-hidden="true" />
                没有停滞的需求，都在各自的节奏里有进展。
              </p>
            ) : (
              <ul
                className={cn("m-0 flex list-none flex-col gap-1 p-0 transition-opacity", refreshing && "opacity-60")}
                aria-busy={refreshing}
                data-testid="overview-stale-requirements"
              >
                {stale.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-left outline-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openRequirement(item)}
                    >
                      <StatusIcon status={item.status} />
                      <span className="w-16 shrink-0 font-mono text-caption text-subtle-foreground">
                        {typeof item.number === "number" ? formatRequirementNumber(item.number) : "REQ-—"}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-small font-medium text-foreground">{item.title}</span>
                        <span className="truncate text-caption text-subtle-foreground">
                          最后由 {item.lastUpdatedBy.displayName} 更新 · {relativeTime(Date.parse(item.updatedAt))}
                        </span>
                      </span>
                      <span className={cn("flex shrink-0 flex-col items-end text-caption tabular-nums", item.level === "warning" ? "text-warning" : "text-subtle-foreground")}>
                        <span className="font-medium">{item.level === "warning" ? "停滞较久" : "该推进了"}</span>
                        <span>{item.staleDays} 天没动</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block title="最近动态">
            {audit.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : audit.isError && audit.data === undefined ? (
              <Failure label="最近动态" error={audit.error} onRetry={() => void audit.refetch()} announce />
            ) : (
              <OverviewTimeline entries={audit.data?.items ?? []} />
            )}
          </Block>
        </div>
      </div>
    </div>
  );
}

function Block({ title, subtitle, action, children }: { title: string; subtitle?: string | undefined; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <h2 className="m-0 text-section font-semibold text-foreground">{title}</h2>
        {subtitle === undefined ? null : <span className="text-caption text-subtle-foreground">{subtitle}</span>}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function Failure({ label, error, onRetry, announce = false }: { label: string; error: unknown; onRetry(): void; announce?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-small text-foreground" role={announce ? "alert" : undefined}>
      <AlertTriangleIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />
      <span className="flex-1">
        {label}没能加载：{classifyFailure(error).message}
      </span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/** 图表的读屏替代：同样的数据，每天一行、每个出现过的状态一列（颜色之外的第二通道）。 */
function TransitionTable({ transitions, caption }: { transitions: readonly DailyRequirementTransitionDto[]; caption: string }) {
  const present = REQUIREMENT_STATUSES.filter((status) => transitions.some((day) => (day.byStatus?.[status] ?? 0) > 0));
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">日期</th>
          <th scope="col">合计</th>
          {present.map((status) => (
            <th key={status} scope="col">
              进入{REQUIREMENT_STATUS_LABELS[status]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {transitions.map((day) => (
          <tr key={day.date}>
            <th scope="row">{day.date}</th>
            <td>{day.count}</td>
            {present.map((status) => (
              <td key={status}>{day.byStatus?.[status] ?? 0}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
