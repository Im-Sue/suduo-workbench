import { Link } from "@tanstack/react-router";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import { ChevronDownIcon, ChevronUpIcon, Maximize2Icon, PlayIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { classifyFailure } from "../../../feedback/classify.js";
import { RegionError } from "../../../feedback/components/index.js";
import { Markdown } from "../../../ui/markdown.js";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PriorityIcon } from "@/components/ui/priority-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RequirementRoomButton } from "../../rooms/sections/RequirementRoomButton.js";
import { useCloudFeature } from "../cloud-features.js";
import { requirementCode } from "../format.js";
import { useRequirement, useUpdateRequirement } from "../queries.js";
import { ActivityFeed } from "../sections/ActivityFeed.js";
import { LocalSessions } from "../sections/LocalSessions.js";
import { MaterialsPreview } from "../sections/Materials.js";
import { AssigneeMenu } from "./AssigneeMenu.js";
import { PriorityMenu } from "./PriorityMenu.js";
import { StatusMenu } from "./StatusMenu.js";
import { UserAvatar } from "./UserAvatar.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";
import { requirementPriorityLabel } from "../../../ui/requirement-priority.js";
import { useT } from "../../../i18n/provider.js";

/**
 * 需求速览（原型 Main · 速览）：看板 / 列表右侧 480px，不离开当前页面。
 * 与详情页共用查询，点「打开完整页」零等待；↑↓ / K J 切换上一条 / 下一条不关闭面板；Esc 关闭。
 * 窄屏时速览盖在看板上，打开后焦点移进面板（focusOnOpen）；宽屏并排时焦点留在卡片上，方便继续用键盘挑。
 * 底部：开始会话 ｜ 进入 / 创建讨论（在悬浮窗口里打开，不离开看板）｜ 打开完整页。
 */
export function RequirementPeek({
  projectId,
  requirementId,
  focusOnOpen = false,
  currentUserId,
  onClose,
  onPrev,
  onNext,
  onStartSession,
}: {
  projectId: string;
  requirementId: string;
  focusOnOpen?: boolean;
  currentUserId: string | null;
  onClose(): void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onStartSession(requirement: RequirementListItemDto): void;
}) {
  const t = useT();
  const { requirement, detail } = useRequirement(requirementId);
  const update = useUpdateRequirement();
  const priorityEnabled = useCloudFeature("requirement_priority");
  const bodyRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  // 切换到另一条时回到顶部。
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [requirementId]);

  useEffect(() => {
    if (focusOnOpen) asideRef.current?.focus();
  }, [focusOnOpen, requirementId]);

  const code = requirement === undefined ? "" : requirementCode(requirement.number);
  // 旧链接可能带着别的项目的需求 id：链接一律用需求自己所在的项目。
  const ownProjectId = requirement?.projectId ?? projectId;
  const statusPending =
    update.isPending && update.variables?.requirement.id === requirementId && update.variables.patch.status !== undefined;

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      aria-label={requirement === undefined ? t.requirements.peek.label : t.requirements.peek.labelWith(code, requirement.title)}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(480px,100%)] flex-col border-l border-border bg-card shadow-2 outline-none animate-in slide-in-from-right-4 fade-in-0 duration-150 min-[1440px]:static min-[1440px]:w-[480px] min-[1440px]:shrink-0 min-[1440px]:shadow-none"
      data-testid="requirement-peek"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pr-3 pl-5">
        <span className="font-mono text-caption text-subtle-foreground">{code}</span>
        {requirement === undefined ? null : (
          <StatusMenu
            status={requirement.status}
            pending={statusPending}
            onChange={(status) => update.mutate({ requirement, patch: { status } })}
          />
        )}
        <div className="flex-1" />
        <NavButton label={t.requirements.peek.prev} shortcut="K" onClick={onPrev}>
          <ChevronUpIcon />
        </NavButton>
        <NavButton label={t.requirements.peek.next} shortcut="J" onClick={onNext}>
          <ChevronDownIcon />
        </NavButton>
        {requirement === undefined ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild size="icon-sm" variant="ghost">
                <Link
                  to="/p/$projectId/requirements/$number"
                  params={{ projectId: ownProjectId, number: String(requirement.number) }}
                  state={(previous) => ({ ...previous, fromList: true })}
                  aria-label={t.requirements.peek.openFull}
                >
                  <Maximize2Icon />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t.requirements.peek.openFull}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t.requirements.peek.close} onClick={onClose}>
              <XIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t.requirements.peek.closeHint} <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        {requirement === undefined ? (
          detail.isError ? (
            <RegionError
              kind={classifyFailure(detail.error).kind}
              message={t.requirements.peek.loadFailed(classifyFailure(detail.error).message)}
              busy={detail.isFetching}
              onRetry={() => void detail.refetch()}
            />
          ) : (
            <PeekSkeleton />
          )
        ) : (
          <>
            <h2 className="m-0 text-page font-semibold break-words">{requirement.title}</h2>
            <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-small">
              <dt className="text-subtle-foreground">{t.requirements.peek.field.assignee}</dt>
              <dd className="m-0">
                <AssigneeMenu
                  assignee={requirement.assignee}
                  currentUserId={currentUserId}
                  onChange={(assignee) =>
                    update.mutate({ requirement, patch: { assigneeId: assignee?.id ?? null }, assignee })
                  }
                >
                  <button
                    type="button"
                    className="-mx-1.5 -my-0.5 inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t.requirements.peek.assigneeTrigger(
                      requirement.assignee?.displayName ?? t.requirements.assignee.unassigned,
                    )}
                  >
                    <UserAvatar user={requirement.assignee} />
                    <span className={requirement.assignee === null ? "text-subtle-foreground" : undefined}>
                      {requirement.assignee?.displayName ?? t.requirements.assignee.unassigned}
                    </span>
                  </button>
                </AssigneeMenu>
              </dd>
              {priorityEnabled ? (
                <>
                  <dt className="text-subtle-foreground">{t.requirements.peek.field.priority}</dt>
                  <dd className="m-0">
                    <PriorityMenu
                      priority={requirement.priority ?? null}
                      pending={update.isPending && update.variables?.patch.priority !== undefined}
                      onChange={(priority) => update.mutate({ requirement, patch: { priority } })}
                      trigger={
                        <button
                          type="button"
                          className="-mx-1.5 -my-0.5 inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={t.requirements.priorityMenu.triggerLabel(
                            requirementPriorityLabel(requirement.priority, t),
                            false,
                          )}
                        >
                          <PriorityIcon priority={requirement.priority} aria-hidden="true" />
                          <span className={requirement.priority == null ? "text-subtle-foreground" : undefined}>
                            {requirementPriorityLabel(requirement.priority, t)}
                          </span>
                        </button>
                      }
                    />
                  </dd>
                </>
              ) : null}
              <dt className="text-subtle-foreground">{t.requirements.peek.field.created}</dt>
              <dd className="m-0">
                {requirement.createdBy.displayName} ·{" "}
                <time title={formatDateTime(requirement.createdAt)}>{formatRelativeTime(requirement.createdAt)}</time>
              </dd>
              <dt className="text-subtle-foreground">{t.requirements.peek.field.updated}</dt>
              <dd className="m-0">
                {requirement.updatedBy.displayName} ·{" "}
                <time title={formatDateTime(requirement.updatedAt)}>{formatRelativeTime(requirement.updatedAt)}</time>
              </dd>
            </dl>
            {requirement.summary.trim() === "" ? (
              <p className="m-0 text-small text-subtle-foreground">
                {t.requirements.peek.noDescription}
                <Link
                  to="/p/$projectId/requirements/$number"
                  params={{ projectId: ownProjectId, number: String(requirement.number) }}
                  state={(previous) => ({ ...previous, fromList: true })}
                  className="text-primary-text"
                >
                  {t.requirements.peek.addDescription}
                </Link>
              </p>
            ) : (
              <div className="text-body">
                <Markdown text={requirement.summary} />
              </div>
            )}
            <MaterialsPreview requirementId={requirement.id} />
            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-small font-semibold">{t.requirements.peek.localSessions}</h3>
              <LocalSessions projectId={ownProjectId} requirementId={requirement.id} limit={3} />
            </section>
            <section className="flex flex-col gap-2.5">
              <h3 className="m-0 text-small font-semibold">{t.requirements.peek.recentActivity}</h3>
              <ActivityFeed requirementId={requirement.id} mode="recent" limit={3} />
            </section>
          </>
        )}
      </div>

      <div className="flex shrink-0 gap-2 border-t border-border px-5 py-3">
        <Button
          variant="primary"
          className="flex-1"
          disabled={requirement === undefined}
          onClick={() => requirement !== undefined && onStartSession(requirement)}
        >
          <PlayIcon />
          {t.requirements.peek.startSession}
        </Button>
        {/* 按需求重新挂载：J / K 换需求时面板不卸载，新建讨论的默认名字要跟着换。 */}
        {requirement === undefined ? null : <RequirementRoomButton key={requirement.id} requirement={requirement} />}
        {requirement === undefined ? null : (
          <Button asChild variant="secondary">
            <Link
              to="/p/$projectId/requirements/$number"
              params={{ projectId: ownProjectId, number: String(requirement.number) }}
              state={(previous) => ({ ...previous, fromList: true })}
            >
              {t.requirements.peek.openFull}
            </Link>
          </Button>
        )}
      </div>
    </aside>
  );
}

function NavButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut: string;
  onClick: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={label} disabled={onClick === null} onClick={() => onClick?.()}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function PeekSkeleton() {
  const t = useT();
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={t.requirements.peek.loading}>
      <Skeleton className="h-6 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
