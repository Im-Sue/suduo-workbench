import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SharedItemDto } from "@suduo/cloud-contracts";
import { BotIcon, EyeIcon, FileTextIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import { api } from "../../../api/client.js";
import { ConfirmDialog } from "../../../feedback/components/index.js";
import { reportFailure } from "../../../feedback/report.js";
import { useT } from "../../../i18n/provider.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";
import { useCloudFeature } from "../cloud-features.js";
import { SharedContentView } from "../../collab/SharedContentView.js";
import { localAgentsQuery } from "../../agents/queries.js";
import { showMessage } from "../../../ui/message.js";
import { requirementKeys } from "../keys.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

/**
 * 需求详情的「AI 协作」区（多 Agent 协作 S11，需求 4.14）：成员发布的交接包、评审报告、会话快照（标明来源、读过人数，
 * 可查看、可撤回——项目成员都能撤，撤回前说明已读过的收不回），以及协作记录（谁用哪个 Agent 做了什么，只含元数据）。
 * 团队服务器不支持（没有 ai_collab_v1）时不显示。
 */
export function AiCollabSection({ requirementId }: { requirementId: string }) {
  const enabled = useCloudFeature("ai_collab_v1");
  const t = useT();
  const text = t.collab.share.section;
  const items = useQuery({ queryKey: requirementKeys.sharedItems(requirementId), queryFn: () => api.listSharedItems(requirementId), enabled });
  const activity = useQuery({ queryKey: requirementKeys.aiActivity(requirementId), queryFn: () => api.listAiActivity(requirementId), enabled });
  const agents = useQuery({ ...localAgentsQuery, enabled });
  /** 来源 Agent 的名字（本机配置表里有的用显示名，否则原样）。 */
  const agentName = (agentId: string | null) => (agentId === null ? null : (agents.data?.agents.find((agent) => agent.id === agentId)?.displayName ?? agentId));
  const [viewing, setViewing] = useState<SharedItemDto | null>(null);
  const [retracting, setRetracting] = useState<SharedItemDto | null>(null);
  const queryClient = useQueryClient();
  if (!enabled) return null;
  /** 撤回确认里的读过人数用最新的：打开时重取一次列表（只查列表，不算读过）。 */
  const openRetract = (item: SharedItemDto) => {
    setRetracting(item);
    void queryClient.invalidateQueries({ queryKey: requirementKeys.sharedItems(requirementId) });
  };
  const retractReadCount = retracting === null ? 0 : (items.data?.items.find((item) => item.id === retracting.id)?.readCount ?? retracting.readCount);
  const retract = async (item: SharedItemDto) => {
    try {
      const retracted = await api.retractSharedItem(item.id);
      // 用撤回回包里的最新读过人数说明（列表里的可能是旧的）。
      showMessage(text.retractedNotice(retracted.readCount), retracted.readCount > 0 ? "warning" : "success");
      await queryClient.invalidateQueries({ queryKey: requirementKeys.sharedItems(requirementId) });
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.failures.retract });
    }
  };
  return (
    <section className="flex flex-col gap-3" data-testid="ai-collab-section">
      <h2 className="m-0 text-small font-semibold">{text.title}</h2>
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-caption font-medium text-muted-foreground">{text.sharedItems}</h3>
        {items.isPending ? (
          <Skeleton className="h-9 w-full" />
        ) : items.isError ? (
          <p className="m-0 text-caption text-subtle-foreground">{text.loadFailed}</p>
        ) : items.data.items.length === 0 ? (
          <p className="m-0 text-caption text-subtle-foreground">{text.empty}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {items.data.items.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5 rounded-sm bg-muted px-2.5 py-1.5 text-small" data-testid="shared-item" data-retracted={item.retractedAt === null ? "false" : "true"}>
                <span className="flex items-center gap-1.5">
                  <FileTextIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
                  <span className="shrink-0 text-caption text-muted-foreground">{t.collab.share.kinds[item.kind] ?? item.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground" title={item.title}>
                    {item.title}
                  </span>
                  {item.retractedAt === null ? (
                    <>
                      <Button size="icon-sm" variant="ghost" aria-label={text.view} title={text.view} onClick={() => setViewing(item)} data-testid="shared-item-view">
                        <EyeIcon />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={text.retract} title={text.retract} onClick={() => openRetract(item)} data-testid="shared-item-retract">
                        <Undo2Icon />
                      </Button>
                    </>
                  ) : null}
                </span>
                <span className="text-caption text-subtle-foreground">
                  {text.by(item.publishedBy.displayName)}
                  {item.source.agentId === null ? "" : ` · ${agentName(item.source.agentId) ?? ""}`}
                  {" · "}
                  <time title={formatDateTime(item.publishedAt)}>{formatRelativeTime(item.publishedAt)}</time>
                  {item.readCount > 0 ? ` · ${text.readCount(item.readCount)}` : ""}
                  {item.retractedBy === null ? "" : ` · ${text.retractedBy(item.retractedBy.displayName)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-caption font-medium text-muted-foreground">{text.activity}</h3>
        {activity.isPending ? (
          <Skeleton className="h-9 w-full" />
        ) : activity.isError ? (
          <p className="m-0 text-caption text-subtle-foreground">{text.loadFailed}</p>
        ) : activity.data.items.length === 0 ? (
          <p className="m-0 text-caption text-subtle-foreground">{text.activityEmpty}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="ai-activity">
            {activity.data.items.map((entry) => (
              <li key={entry.id} className="flex items-center gap-1.5 text-caption text-muted-foreground">
                <BotIcon className="size-3 shrink-0 text-subtle-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {entry.member.displayName} · {agentName(entry.agentId)} · {text.activityKinds[entry.kind] ?? entry.kind} · {text.activityStatus[entry.status] ?? entry.status}
                  {entry.branch === null ? "" : ` · ${entry.branch}`}
                </span>
                <time className="shrink-0 text-subtle-foreground" title={formatDateTime(entry.occurredAt)}>
                  {formatRelativeTime(entry.occurredAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
      {viewing === null ? null : <SharedItemViewer item={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog
        open={retracting !== null}
        onOpenChange={(open) => (!open ? setRetracting(null) : undefined)}
        title={text.retractTitle}
        description={retracting === null ? "" : text.retractDescription(retractReadCount)}
        confirmLabel={text.retractConfirm}
        onConfirm={() => {
          const item = retracting;
          setRetracting(null);
          if (item !== null) void retract(item);
        }}
      />
    </section>
  );
}

/** 看一份共享对象的内容（读的人不是发布人时，团队服务器记一笔「读过」）。 */
function SharedItemViewer({ item, onClose }: { item: SharedItemDto; onClose(): void }) {
  const t = useT();
  const text = t.collab.share;
  const detail = useQuery({ queryKey: ["shared-item", item.id], queryFn: () => api.getSharedItem(item.id), staleTime: 0 });
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent size="lg" data-testid="shared-item-viewer">
        <DialogHeader>
          <DialogTitle>{text.section.viewTitle(text.kinds[item.kind] ?? item.kind, item.title)}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto text-small">
          {detail.isPending ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : detail.isError ? (
            <p className="m-0 text-danger">{text.section.failures.view}</p>
          ) : (
            detail.data.content === null ? (
              <p className="m-0 text-muted-foreground">{text.section.retracted}</p>
            ) : (
              <SharedContentView kind={detail.data.kind} content={detail.data.content} />
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
