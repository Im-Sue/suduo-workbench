import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentDto, AgentShareDuration, RoomDto } from "@suduo/cloud-contracts";
import { BotIcon, FolderGit2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { requestProjectAction } from "../../../app/shell/shell-actions.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { useT } from "../../../i18n/provider.js";
import type { Messages } from "../../../i18n/messages/index.js";
import { requirementKeys } from "../../requirements/keys.js";
import { api } from "../../../api/client.js";
import { findCachedRoom } from "../cache.js";
import { activeShares, agentName, expiresLabel, shareDurationOf } from "../model.js";
import {
  agentsQuery,
  selfAgentQuery,
  shareRequestsQuery,
  sharesQuery,
  useCloseShare,
  useOpenShare,
  useRequestShare,
  useResolveShareRequest,
} from "../queries.js";
import { readShareDuration, writeShareDuration } from "../share-prefs.js";

/**
 * 「共享 Agent」面板（需求 4.5 / 十一）：
 * - 我的 Agent：本机登记状态（没登记说明原因）、共享到本房间的开关与时长（直到我关闭 / 2 小时 / 今天）、
 *   本机正在为哪个房间执行、还有几个在排队；时长已共享时按共享读回，没共享时用上次选的档；
 * - 本房间已共享的 Agent（在线、到期时间）；
 * - 可申请的 Agent（别人的、在这里没共享的 →「申请共享」）；
 * - 我收到的待处理申请（开启 / 忽略）。
 */
const DURATIONS: readonly AgentShareDuration[] = ["until_closed", "two_hours", "today"];

function durationOptions(t: Messages): { value: AgentShareDuration; label: string }[] {
  return DURATIONS.map((value) => ({ value, label: t.rooms.share.duration[value] }));
}

/** compact：只留图标与数字（悬浮窗口窄时的标题栏），说明在 aria-label 与悬停提示里。 */
export function ShareAgentButton({ room, meId, compact = false }: { room: RoomDto; meId: string | null; compact?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const shares = useQuery(sharesQuery(room.id));
  const count = activeShares(shares.data?.items).length;
  const requests = useQuery(shareRequestsQuery(room.id));
  const incoming = (requests.data?.items ?? []).filter((item) => item.status === "pending" && item.agent.owner.id === meId).length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          className={compact ? "px-2" : undefined}
          title={compact ? t.rooms.share.button : undefined}
          data-testid="share-agent-button"
          aria-label={t.rooms.share.buttonLabel(count, incoming)}
        >
          <BotIcon />
          {compact ? null : t.rooms.share.button}
          {count > 0 ? <span className="text-subtle-foreground">{count}</span> : null}
          {incoming > 0 ? <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(640px,80vh)] w-[380px] overflow-y-auto p-0">
        <ShareAgentPanel room={room} meId={meId} />
      </PopoverContent>
    </Popover>
  );
}

export function ShareAgentPanel({ room, meId }: { room: RoomDto; meId: string | null }) {
  const t = useT();
  const shares = useQuery(sharesQuery(room.id));
  const agents = useQuery(agentsQuery);
  const requests = useQuery(shareRequestsQuery(room.id));
  const requestShare = useRequestShare(room.id);
  const resolve = useResolveShareRequest(room.id);
  const [incomingDuration, setIncomingDuration] = useState<AgentShareDuration>(readShareDuration);
  const active = activeShares(shares.data?.items);
  const pending = (requests.data?.items ?? []).filter((item) => item.status === "pending");
  const incoming = pending.filter((item) => item.agent.owner.id === meId && item.requester.id !== meId);
  const requestedByMe = new Set(pending.filter((item) => item.requester.id === meId).map((item) => item.agent.id));
  const requestable = (agents.data?.items ?? []).filter(
    (agent) => agent.owner.id !== meId && !active.some((share) => share.agent.id === agent.id),
  );
  const archived = room.archivedAt !== null;

  return (
    <div className="flex flex-col divide-y divide-border" data-testid="share-agent-panel">
      <MyAgentSection room={room} meId={meId} />

      <section className="flex flex-col gap-2 px-4 py-3" aria-labelledby={`shared-${room.id}`}>
        <h3 id={`shared-${room.id}`} className="m-0 text-small font-semibold">{t.rooms.share.sharedHere}</h3>
        {shares.isPending ? <Skeleton className="h-8 w-full" /> : null}
        {shares.isError ? (
          <p className="m-0 text-caption text-danger" role="alert">{t.rooms.share.sharesLoadFailed(classifyFailure(shares.error).message)}</p>
        ) : null}
        {shares.isSuccess && active.length === 0 ? (
          <p className="m-0 text-caption text-subtle-foreground">{t.rooms.share.noneShared}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {active.map((share) => (
            <li key={share.id} className="flex items-center gap-2 text-small" data-testid="shared-agent-row" data-agent-id={share.agent.id}>
              <OnlineDot online={share.agent.online} />
              <span className="min-w-0 flex-1 truncate">{share.agent.label}</span>
              <span className="shrink-0 text-caption text-subtle-foreground">
                {share.agent.online ? t.rooms.agent.available : t.rooms.agent.offline} · {expiresLabel(share.expiresAt, undefined, t)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {incoming.length === 0 ? null : (
        <section className="flex flex-col gap-2 px-4 py-3" aria-labelledby={`incoming-${room.id}`}>
          <h3 id={`incoming-${room.id}`} className="m-0 text-small font-semibold">{t.rooms.share.incomingTitle}</h3>
          <SegmentedControl
            size="sm"
            aria-label={t.rooms.share.incomingDurationLabel}
            value={incomingDuration}
            onValueChange={(next) => {
              setIncomingDuration(next);
              writeShareDuration(next);
            }}
            options={durationOptions(t)}
          />
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {incoming.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-small" data-testid="incoming-share-request">
                <span className="min-w-0 flex-1">
                  {t.rooms.share.incomingRequest(item.requester.displayName, <span key="agent" className="font-medium">{agentName(item.agent, t)}</span>)}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  loading={resolve.isPending && resolve.variables?.requestId === item.id && resolve.variables.action === "accept"}
                  onClick={() => resolve.mutate({ requestId: item.id, action: "accept", duration: incomingDuration })}
                >
                  {t.rooms.share.accept}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => resolve.mutate({ requestId: item.id, action: "ignore" })}
                >
                  {t.rooms.share.ignore}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2 px-4 py-3" aria-labelledby={`requestable-${room.id}`}>
        <h3 id={`requestable-${room.id}`} className="m-0 text-small font-semibold">{t.rooms.share.requestableTitle}</h3>
        {agents.isPending ? <Skeleton className="h-8 w-full" /> : null}
        {agents.isError ? (
          <RegionError
            kind={classifyFailure(agents.error).kind}
            message={t.rooms.share.agentsLoadFailed(classifyFailure(agents.error).message)}
            busy={agents.isFetching}
            onRetry={() => void agents.refetch()}
          />
        ) : null}
        {agents.isSuccess && requestable.length === 0 ? (
          <p className="m-0 text-caption text-subtle-foreground">{t.rooms.share.noneRequestable}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {requestable.map((agent) => (
            <RequestableRow
              key={agent.id}
              agent={agent}
              requested={requestedByMe.has(agent.id)}
              disabled={archived}
              busy={requestShare.isPending && requestShare.variables === agent.id}
              onRequest={() => requestShare.mutate(agent.id)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function RequestableRow({
  agent,
  requested,
  disabled,
  busy,
  onRequest,
}: {
  agent: AgentDto;
  requested: boolean;
  disabled: boolean;
  busy: boolean;
  onRequest(): void;
}) {
  const t = useT();
  return (
    <li className="flex items-center gap-2 text-small" data-testid="requestable-agent-row" data-agent-id={agent.id}>
      <OnlineDot online={agent.online} />
      <span className="min-w-0 flex-1 truncate">{agent.label}</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={requested || disabled}
        loading={busy}
        aria-label={requested ? t.rooms.share.requestedLabel(agent.label) : t.rooms.share.requestLabel(agent.label)}
        onClick={onRequest}
      >
        {requested ? t.rooms.share.requested : t.rooms.share.request}
      </Button>
    </li>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "border border-border-strong bg-transparent")}
      aria-hidden="true"
    />
  );
}

function MyAgentSection({ room, meId }: { room: RoomDto; meId: string | null }) {
  const t = useT();
  const text = t.rooms.share.myAgent;
  const queryClient = useQueryClient();
  const self = useQuery(selfAgentQuery);
  const shares = useQuery(sharesQuery(room.id));
  const mappings = useQuery({
    queryKey: requirementKeys.mappings,
    queryFn: () => api.listRequirementsMappings(),
    staleTime: 60_000,
  });
  const open = useOpenShare(room.id);
  const close = useCloseShare(room.id);
  const agent = self.data?.agent ?? null;
  const myShare = agent === null ? undefined : activeShares(shares.data?.items).find((share) => share.agent.id === agent.id);
  const [preferred, setPreferred] = useState<AgentShareDuration>(readShareDuration);
  // 选中的档：改时长的请求在路上时显示要改成的；已共享按共享读回（面板每次打开都对得上）；没共享用上次选的。
  const duration: AgentShareDuration =
    open.isPending && open.variables !== undefined
      ? open.variables.duration
      : myShare !== undefined
        ? shareDurationOf(myShare.expiresAt)
        : preferred;
  const mapped = mappings.data?.items.some((item) => item.remoteProjectId === room.projectId) ?? true;
  const archived = room.archivedAt !== null;
  const busy = open.isPending || close.isPending;

  const toggle = (next: boolean) => {
    if (agent === null) return;
    if (next) open.mutate({ agentId: agent.id, duration });
    else if (myShare !== undefined) close.mutate(myShare.id);
  };

  const changeDuration = (next: AgentShareDuration) => {
    setPreferred(next);
    writeShareDuration(next);
    // 已经共享着：按新时长重开（服务端合并成改时长，不新建）。
    if (agent !== null && myShare !== undefined) open.mutate({ agentId: agent.id, duration: next });
  };

  const activeRun = self.data?.activeRun ?? null;
  const activeRoom = activeRun === null ? undefined : activeRun.roomId === room.id ? room : findCachedRoom(queryClient, activeRun.roomId);

  return (
    <section className="flex flex-col gap-2.5 px-4 py-3" aria-labelledby={`my-agent-${room.id}`} data-testid="my-agent-section">
      <h3 id={`my-agent-${room.id}`} className="m-0 text-small font-semibold">{text.title}</h3>
      {self.isPending ? <Skeleton className="h-9 w-full" /> : null}
      {self.isError ? (
        <RegionError
          kind={classifyFailure(self.error).kind}
          message={text.loadFailed(classifyFailure(self.error).message)}
          busy={self.isFetching}
          onRetry={() => void self.refetch()}
        />
      ) : null}
      {self.isSuccess && (self.data.status !== "ready" || agent === null) ? (
        <p className="m-0 rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground" data-testid="my-agent-unavailable" data-status={self.data.status}>
          {self.data.status === "unregistered" ? text.unregistered(self.data.message) : text.unavailable(self.data.message)}
        </p>
      ) : null}
      {agent === null || self.data?.status !== "ready" ? null : (
        <>
          <div className="flex items-center gap-2 text-small">
            <OnlineDot online={agent.online} />
            <span className="min-w-0 flex-1 truncate">{agent.label}</span>
            <Switch
              checked={myShare !== undefined}
              disabled={busy || archived || meId === null}
              aria-label={text.switchLabel(agent.label)}
              data-testid="my-agent-switch"
              onCheckedChange={toggle}
            />
          </div>
          <SegmentedControl
            size="sm"
            aria-label={text.durationLabel}
            data-testid="share-duration"
            value={duration}
            onValueChange={changeDuration}
            options={durationOptions(t).map((option) => ({ ...option, disabled: busy || archived }))}
          />
          <p className="m-0 text-caption text-subtle-foreground" data-testid="my-agent-share-state">
            {myShare === undefined
              ? text.notShared(t.rooms.share.duration[duration])
              : text.shared(expiresLabel(myShare.expiresAt, undefined, t))}
          </p>
          {mapped ? null : (
            <div className="flex flex-col gap-1.5 rounded-md bg-warning-soft px-3 py-2 text-caption text-foreground" data-testid="my-agent-no-mapping">
              <span>{text.noMapping}</span>
              <Button size="sm" variant="secondary" className="self-start" onClick={() => requestProjectAction("manage")}>
                <FolderGit2Icon />
                {text.linkFolder}
              </Button>
            </div>
          )}
          {activeRun === null ? null : (
            <p className="m-0 text-caption text-muted-foreground" data-testid="my-agent-active-run">
              {text.activeRun(activeRoom?.name ?? null, self.data?.queuedRuns ?? 0)}
            </p>
          )}
          {activeRun === null && (self.data?.queuedRuns ?? 0) > 0 ? (
            <p className="m-0 text-caption text-muted-foreground">{text.queued(self.data?.queuedRuns ?? 0)}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
