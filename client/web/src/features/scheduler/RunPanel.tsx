import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SchedulerItemDto, SchedulerSnapshotDto } from "@suduo/client-contracts";
import { ArrowUpToLineIcon, ExternalLinkIcon, SquareIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { reportFailure } from "../../feedback/report.js";
import { useT } from "../../i18n/provider.js";
import { formatElapsed } from "../sessions/stream/describe.js";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** 本机运行情况（多 Agent 协作 S8）：侧栏的数字与运行面板共用；面板打开时刷得更勤。 */
export function schedulerQuery(open: boolean) {
  return queryOptions({
    queryKey: ["scheduler"],
    queryFn: ({ signal }) => api.schedulerSnapshot({ signal }),
    refetchInterval: open ? 2_000 : 10_000,
    staleTime: 1_000,
  });
}

/**
 * 运行面板（需求 4.11）：本机运行中与排队中的回合，按 Agent 分组；运行中的可停止、打开会话，
 * 排队中的可「先跑这个」、取消。上限在 AI Agent 设置里改。
 */
export function RunPanel({ onNavigate }: { onNavigate(): void }) {
  const t = useT();
  const text = t.collab.panel;
  const query = useQuery(schedulerQuery(true));
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  // 停止运行中的回合时，这个会话还有没做完的委派：就地问一句（R7，默认一并停止）。
  const [cascade, setCascade] = useState<{ item: SchedulerItemDto; count: number } | null>(null);
  const act = async (itemId: string, action: "promote" | "cancel", withDelegations = false) => {
    setBusy(itemId);
    try {
      if (withDelegations) {
        const item = query.data?.running.find((candidate) => candidate.id === itemId);
        if (item !== undefined) await api.cancelAllDelegations(item.sessionId);
      }
      const snapshot = action === "promote" ? await api.promoteSchedulerItem(itemId) : await api.cancelSchedulerItem(itemId);
      client.setQueryData(["scheduler"], snapshot);
    } catch (cause) {
      reportFailure(cause, { surface: "action" });
      void query.refetch();
    } finally {
      setBusy(null);
    }
  };
  const stop = async (item: SchedulerItemDto) => {
    if (item.state !== "running") return act(item.id, "cancel");
    const active = await api
      .listDelegations(item.sessionId)
      .then((page) => page.items.filter((delegation) => delegation.status === "queued" || delegation.status === "running").length)
      .catch(() => 0);
    if (active === 0) return act(item.id, "cancel");
    setCascade({ item, count: active });
  };
  if (query.isPending) {
    return (
      <div className="flex items-center justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (query.isError) {
    return <p className="m-0 p-4 text-small text-danger">{text.loadFailed(classifyFailure(query.error).message)}</p>;
  }
  const snapshot: SchedulerSnapshotDto = query.data;
  const agents = groupByAgent(snapshot);
  return (
    <div className="flex max-h-[min(560px,80vh)] flex-col" data-testid="run-panel">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="m-0 text-small font-semibold">{text.title}</h2>
        <span className="text-caption text-muted-foreground">{text.summary(snapshot.running.length, snapshot.limits.global)}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {cascade === null ? null : (
          <div className="mb-2 flex flex-col gap-2 rounded-md border border-warning/40 bg-card px-3 py-2" data-testid="run-panel-cascade">
            <p className="m-0 text-small text-foreground">{t.collab.cascade.description(cascade.count)}</p>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                data-testid="run-panel-stop-this"
                onClick={() => {
                  setCascade(null);
                  void act(cascade.item.id, "cancel");
                }}
              >
                {t.collab.cascade.stopThis}
              </Button>
              <Button
                size="sm"
                variant="danger"
                autoFocus
                data-testid="run-panel-stop-all"
                onClick={() => {
                  setCascade(null);
                  void act(cascade.item.id, "cancel", true);
                }}
              >
                {t.collab.cascade.stopAll}
              </Button>
            </div>
          </div>
        )}
        {snapshot.running.length === 0 && snapshot.queued.length === 0 ? <p className="m-0 px-2 py-3 text-small text-muted-foreground">{text.empty}</p> : null}
        {agents.map((group) => (
          <section key={group.agentId} className="mb-2" data-testid="run-panel-agent" data-agent-id={group.agentId}>
            <h3 className="m-0 flex items-center justify-between px-2 py-1 text-caption font-medium text-muted-foreground">
              <span>{group.agentName}</span>
              <span>{text.agentUsage(group.running.length, snapshot.limits.perAgent[group.agentId] ?? 1)}</span>
            </h3>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {[...group.running, ...group.queued].map((item) => (
                <RunRow
                  key={item.id}
                  item={item}
                  busy={busy === item.id}
                  onNavigate={onNavigate}
                  onAct={(action) => void (action === "cancel" ? stop(item) : act(item.id, action))}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <footer className="border-t border-border px-4 py-2">
        <Link to="/settings/$section" params={{ section: "agents" }} onClick={onNavigate} className="text-caption text-primary-text hover:underline">
          {text.settings}
        </Link>
      </footer>
    </div>
  );
}

function RunRow({ item, busy, onNavigate, onAct }: { item: SchedulerItemDto; busy: boolean; onNavigate(): void; onAct(action: "promote" | "cancel"): void }) {
  const t = useT();
  const text = t.collab.panel;
  const running = item.state === "running";
  return (
    <li className="group/run flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted" data-testid="run-panel-item" data-state={item.state}>
      {running ? <Spinner size="sm" className="shrink-0 text-primary-text" /> : <span className="w-8 shrink-0 text-caption text-subtle-foreground">{text.position(item.position ?? 0)}</span>}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-small text-foreground" title={item.label}>
          {item.label}
        </span>
        <span className="truncate text-caption text-subtle-foreground">
          {text.source[item.source]}
          {item.sessionTitle !== item.label ? ` · ${item.sessionTitle}` : ""}
          {running && item.startedAt !== null ? ` · ${formatElapsed(Date.now() - item.startedAt)}` : ""}
        </span>
      </div>
      <Button asChild size="icon-sm" variant="ghost" title={text.open} aria-label={text.open}>
        <Link to="/sessions/$sessionId" params={{ sessionId: item.sessionId }} onClick={onNavigate}>
          <ExternalLinkIcon />
        </Link>
      </Button>
      {running ? null : (
        <Button size="icon-sm" variant="ghost" title={text.promote} aria-label={text.promote} disabled={busy || item.position === 1} data-testid="run-panel-promote" onClick={() => onAct("promote")}>
          <ArrowUpToLineIcon />
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        title={running ? text.stop : text.cancel}
        aria-label={running ? text.stop : text.cancel}
        loading={busy}
        data-testid="run-panel-cancel"
        onClick={() => onAct("cancel")}
      >
        {running ? <SquareIcon /> : <XIcon />}
      </Button>
    </li>
  );
}

function groupByAgent(snapshot: SchedulerSnapshotDto) {
  const groups = new Map<string, { agentId: string; agentName: string; running: SchedulerItemDto[]; queued: SchedulerItemDto[] }>();
  for (const item of [...snapshot.running, ...snapshot.queued]) {
    const group = groups.get(item.agentId) ?? { agentId: item.agentId, agentName: item.agentName, running: [], queued: [] };
    (item.state === "running" ? group.running : group.queued).push(item);
    groups.set(item.agentId, group);
  }
  return [...groups.values()];
}
