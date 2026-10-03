import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import type { UserSummaryDto } from "@suduo/cloud-contracts";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { settingsQuery } from "../../app/queries.js";
import { useSessionLauncher } from "../../app/shell/SessionLauncher.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError, PageFailure } from "../../feedback/components/index.js";
import type { Failure } from "../../feedback/types.js";
import { Markdown } from "../../ui/markdown.js";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AssigneeMenu } from "./components/AssigneeMenu.js";
import { StatusMenu } from "./components/StatusMenu.js";
import { UserAvatar } from "./components/UserAvatar.js";
import { formatFullTime, formatRelativeTime, requirementCode } from "./format.js";
import { requirementKeys } from "./keys.js";
import { useCreateComment, useRequirement, useRequirementIdByRef, useUpdateRequirement } from "./queries.js";
import { useReadMarker } from "./read-marker.js";
import { ActivityFeed, type ActivityFilter } from "./sections/ActivityFeed.js";
import { LocalSessions } from "./sections/LocalSessions.js";
import { MaterialsPanel } from "./sections/Materials.js";
import { RequirementRooms } from "../rooms/sections/RequirementRooms.js";

/**
 * 需求详情（原型 Detail）：左栏标题、描述、材料与确认版、活动；右栏属性、本机代码目录、本机会话。
 * 编辑时他人也改了同一处：不拒绝保存，只告诉你谁改了，并给「载入最新」或「保留我的」两个选择（ADR-0004）。
 */
export function RequirementDetailPage({ projectId, numberRef }: { projectId: string; numberRef: string }) {
  const navigate = useNavigate();
  const ref = useRequirementIdByRef(projectId, numberRef);
  const { requirement, detail } = useRequirement(ref.id);

  // 旧链接（UUID）或跨项目链接：换成规范地址。
  useEffect(() => {
    if (requirement === undefined) return;
    if (requirement.projectId !== projectId || numberRef !== String(requirement.number)) {
      void navigate({
        to: "/p/$projectId/requirements/$number",
        params: { projectId: requirement.projectId, number: String(requirement.number) },
        replace: true,
      });
    }
  }, [navigate, numberRef, projectId, requirement]);

  if (ref.invalid || (ref.id === null && ref.lookup.isError) || (requirement === undefined && detail.isError)) {
    const failure = classifyFailure(ref.lookup.error ?? detail.error);
    const label = ref.number === null ? `「${numberRef}」` : requirementCode(ref.number);
    const notFound = ref.invalid || ref.notFound || failure.status === 404;
    const toBoard = () => void navigate({ to: "/p/$projectId/requirements", params: { projectId } });
    return (
      <div className="flex flex-1 items-center justify-center">
        <PageFailure
          failure={
            notFound
              ? { ...failure, kind: "not_found", message: `找不到 ${label}：它可能不在这个项目里，或已被移走。` }
              : { ...failure, message: `没能打开 ${label}：${failure.message}` }
          }
          route={{ outlet: "page", durationMs: 0, politeness: "assertive" }}
          actionLabel={notFound ? "回到需求看板" : "重试"}
          onAction={notFound ? toBoard : () => void (ref.id === null ? ref.lookup.refetch() : detail.refetch())}
        />
      </div>
    );
  }

  if (requirement === undefined) return <DetailSkeleton />;
  return <DetailBody projectId={projectId} requirement={requirement} />;
}

function DetailBody({ projectId, requirement }: { projectId: string; requirement: RequirementListItemDto }) {
  const navigate = useNavigate();
  const fromList = useRouterState({ select: (state) => state.location.state.fromList === true });
  const settings = useQuery(settingsQuery);
  const launcher = useSessionLauncher();
  const update = useUpdateRequirement();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const me: UserSummaryDto | null =
    settings.data?.session?.user === undefined ? null : { id: settings.data.session.user.id, displayName: settings.data.session.user.displayName };
  const code = requirementCode(requirement.number);

  const onShownComments = useReadMarker(requirement.id, requirement.projectId);

  const back = () => {
    // 从看板 / 列表进来的回退即可（保留原位置与筛选）；直接打开的换成看板。
    if (fromList) {
      window.history.back();
      return;
    }
    void navigate({ to: "/p/$projectId/requirements", params: { projectId } });
  };

  const startSession = () =>
    launcher.launch({
      kind: "requirement",
      remoteProjectId: projectId,
      requirementId: requirement.id,
      subject: `${code} ${requirement.title}`,
    });

  // 详情页上 1–7 也能直接改状态（不在输入框里时）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"]') !== null) return;
      if (event.key === "Escape") {
        // 标题、描述正在编辑或评论还没发出去时，Esc 不离开页面，免得草稿丢失。
        if (hasUnsavedWork()) return;
        back();
        return;
      }
      if (!/^[1-7]$/.test(event.key)) return;
      const statuses = ["draft", "in_refinement", "ready_for_development", "in_development", "in_testing", "completed", "on_hold"] as const;
      const next = statuses[Number(event.key) - 1];
      if (next === undefined || next === requirement.status) return;
      event.preventDefault();
      update.mutate({ requirement, patch: { status: next } });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-testid="requirement-detail">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pr-4 pl-5">
        <nav aria-label="位置" className="flex min-w-0 items-center gap-1.5 text-small">
          <Link
            to="/p/$projectId/requirements"
            params={{ projectId }}
            className="text-muted-foreground no-underline hover:text-foreground"
            onClick={(event) => {
              if (fromList) {
                event.preventDefault();
                back();
              }
            }}
          >
            需求
          </Link>
          <ChevronRightIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
          <span className="font-mono text-caption text-foreground" aria-current="page">{code}</span>
        </nav>
        <div className="flex-1" />
        <Button variant="primary" onClick={startSession} data-testid="start-session">
          <PlayIcon />
          开始会话
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1120px] gap-10 px-8 py-6">
          <div className="flex min-w-0 flex-1 flex-col gap-8">
            <div className="flex flex-col gap-3">
              <EditableTitle requirement={requirement} onSave={(title) => update.mutate({ requirement, patch: { title } })} />
              <CompactProperties requirement={requirement} me={me} />
              <DescriptionEditor
                requirement={requirement}
                currentUserId={me?.id ?? null}
                saving={update.isPending && update.variables?.patch.summary !== undefined}
                onSave={(summary) => update.mutateAsync({ requirement, patch: { summary } })}
              />
            </div>
            <MaterialsPanel requirementId={requirement.id} />
            <RequirementRooms requirement={requirement} me={me} />
            <section aria-labelledby="activity-heading" className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <h2 id="activity-heading" className="m-0 text-section font-semibold">活动</h2>
                {/* 这是筛选（同一列表换口径），不是切换面板的标签页：用分段选择，读屏按单选组读出。 */}
                <SegmentedControl<ActivityFilter>
                  size="sm"
                  aria-label="活动筛选"
                  value={filter}
                  onValueChange={setFilter}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "comments", label: requirement.commentCount > 0 ? `评论 ${requirement.commentCount}` : "评论" },
                    { value: "changes", label: "变更" },
                  ]}
                />
              </div>
              <CommentThread requirementId={requirement.id} me={me} filter={filter} onShownComments={onShownComments} />
            </section>
          </div>
          <PropertiesRail projectId={projectId} requirement={requirement} me={me} />
        </div>
      </div>
    </div>
  );
}

function hasUnsavedWork(): boolean {
  if (document.querySelector('#requirement-title, [data-testid="description-editor"]') !== null) return true;
  const comment = document.querySelector<HTMLTextAreaElement>("#comment-composer");
  return comment !== null && comment.value.trim() !== "";
}

// ---------- 标题 ----------

function EditableTitle({ requirement, onSave }: { requirement: RequirementListItemDto; onSave(title: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(requirement.title);
  const [error, setError] = useState(false);
  const save = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setError(true);
      return;
    }
    setEditing(false);
    setError(false);
    if (trimmed !== requirement.title) onSave(trimmed);
  };
  if (!editing) {
    return (
      <h1
        className="group/title m-0 -mx-1.5 cursor-text rounded-sm px-1.5 text-display font-semibold break-words hover:bg-muted"
        onClick={() => {
          setDraft(requirement.title);
          setEditing(true);
        }}
      >
        {requirement.title}
        <button
          type="button"
          className="ml-2 inline-flex size-6 items-center justify-center rounded-sm align-middle text-subtle-foreground opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100"
          aria-label="修改标题"
          onClick={(event) => {
            event.stopPropagation();
            setDraft(requirement.title);
            setEditing(true);
          }}
        >
          <PencilIcon className="size-3.5" />
        </button>
      </h1>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="requirement-title" className="sr-only">需求标题</label>
      <input
        id="requirement-title"
        autoFocus
        maxLength={200}
        className="-mx-1.5 rounded-sm border border-primary bg-card px-1.5 text-display font-semibold text-foreground outline-none"
        value={draft}
        aria-invalid={error || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          // 拼音输入按回车是上屏，不是保存。
          if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            save();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
            setError(false);
          }
        }}
      />
      {error ? <InlineError kind="validation">标题不能为空</InlineError> : null}
    </div>
  );
}

// ---------- 描述 ----------

function DescriptionEditor({
  requirement,
  currentUserId,
  saving,
  onSave,
}: {
  requirement: RequirementListItemDto;
  currentUserId: string | null;
  saving: boolean;
  onSave(summary: string): Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // 开始编辑时看到的版本：服务端描述变了就提示，不拦截保存。
  const [base, setBase] = useState("");
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null);
  const previous = useRef(requirement.summary);
  // 自己提交过的内容：保存中（乐观更新）或失败后点「重试」时描述会变成它，不算「他人也改了」。
  const submitted = useRef(new Set<string>());

  // 没在编辑时，他人改了描述：原地更新，并提示一句是谁改的。
  useEffect(() => {
    if (previous.current !== requirement.summary && !editing && requirement.updatedBy.id !== currentUserId) {
      setRemoteNotice(`${requirement.updatedBy.displayName} 刚刚更新了描述`);
    }
    previous.current = requirement.summary;
  }, [requirement.summary, requirement.updatedBy, editing, currentUserId]);

  const begin = () => {
    setDraft(requirement.summary);
    setBase(requirement.summary);
    setRemoteNotice(null);
    submitted.current.clear();
    setEditing(true);
  };
  const cancel = () => setEditing(false);
  const save = async () => {
    if (draft === requirement.summary) {
      setEditing(false);
      return;
    }
    submitted.current.add(draft);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      // 失败提示由数据层统一给出（带重试）；保持编辑态，内容不丢。
    }
  };
  const changedUnderneath = editing && requirement.summary !== base && !submitted.current.has(requirement.summary);

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        {remoteNotice === null ? null : (
          <div className="flex items-center gap-2 rounded-md bg-primary-soft px-3 py-1.5 text-small text-primary-text" role="status">
            <span className="flex-1">{remoteNotice}</span>
            <Button size="sm" variant="ghost" onClick={() => setRemoteNotice(null)}>知道了</Button>
          </div>
        )}
        {requirement.summary.trim() === "" ? (
          <button
            type="button"
            className="rounded-md border border-dashed border-border px-3 py-3 text-left text-body text-subtle-foreground outline-none hover:border-border-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={begin}
          >
            添加描述：背景、目标、验收标准……支持 Markdown
          </button>
        ) : (
          <div className="group/desc relative -mx-3 rounded-md px-3 py-1 hover:bg-muted/60">
            <div className="text-body">
              <Markdown text={requirement.summary} />
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="absolute top-1 right-1 opacity-0 group-hover/desc:opacity-100 focus-visible:opacity-100"
              onClick={begin}
            >
              <PencilIcon />
              编辑
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="description-editor">
      {changedUnderneath ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-small" role="status">
          <AlertTriangleIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="flex-1">
            {requirement.updatedBy.displayName} 刚刚也改了描述。保存会用你的版本覆盖。
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(requirement.summary);
              setBase(requirement.summary);
            }}
          >
            载入最新版本
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setBase(requirement.summary)}>
            保留我的修改
          </Button>
        </div>
      ) : null}
      <label htmlFor="requirement-summary" className="sr-only">描述</label>
      <Textarea
        id="requirement-summary"
        autoFocus
        rows={Math.min(24, Math.max(6, draft.split("\n").length + 1))}
        maxLength={4000}
        className="font-mono text-small"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <span className="text-caption text-subtle-foreground">
          支持 Markdown · <Kbd>⌘⏎</Kbd> 保存 · <Kbd>Esc</Kbd> 放弃
        </span>
        <span className="ml-auto text-caption text-subtle-foreground">{draft.length}/4000</span>
        <Button size="sm" variant="ghost" onClick={cancel}>放弃</Button>
        <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>保存</Button>
      </div>
    </div>
  );
}

// ---------- 活动与评论 ----------

function CommentThread({
  requirementId,
  me,
  filter,
  onShownComments,
}: {
  requirementId: string;
  me: UserSummaryDto | null;
  filter: ActivityFilter;
  onShownComments?(latestCommentAt: string | null): void;
}) {
  const comment = useCreateComment(requirementId);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<Failure | null>(null);
  const tooLong = draft.length > 4000;

  const send = async () => {
    const body = draft.trim();
    if (body === "" || tooLong || comment.isPending) return;
    setError(null);
    setDraft("");
    try {
      await comment.mutateAsync(body);
    } catch (cause) {
      // 发不出去：把内容放回输入框，原地提示，可直接再发。
      setDraft(body);
      setError(classifyFailure(cause));
    }
  };

  const pending =
    comment.isPending && comment.variables !== undefined ? (
      <li className="flex gap-2.5 opacity-60" aria-busy="true">
        <UserAvatar user={me} size="lg" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-small font-semibold">{me?.displayName ?? "我"} <span className="font-normal text-subtle-foreground">· 发送中…</span></span>
          <div className="rounded-md border border-border bg-card px-3 py-2 text-body whitespace-pre-wrap">{comment.variables}</div>
        </div>
      </li>
    ) : null;

  return (
    <>
      <ActivityFeed requirementId={requirementId} mode="timeline" filter={filter} footer={pending} {...(onShownComments === undefined ? {} : { onShownComments })} />
      <div className="flex gap-2.5">
        <UserAvatar user={me} size="lg" className="mt-1" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor="comment-composer" className="sr-only">写评论</label>
          <Textarea
            id="comment-composer"
            rows={draft === "" ? 2 : Math.min(12, draft.split("\n").length + 1)}
            placeholder="写评论，支持 Markdown"
            value={draft}
            aria-invalid={tooLong || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {error === null ? null : <InlineError kind={error.kind}>没能发出：{error.message}</InlineError>}
          {tooLong ? <InlineError kind="validation">评论最多 4000 字</InlineError> : null}
          <div className="flex justify-end">
            <Button size="sm" variant="primary" disabled={draft.trim() === ""} onClick={() => void send()}>
              发表评论
              <Kbd className="ml-1">⌘⏎</Kbd>
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- 右栏属性 ----------

/** 窄屏（右栏收起）时标题下的一行：状态、负责人仍能直接改。 */
function CompactProperties({ requirement, me }: { requirement: RequirementListItemDto; me: UserSummaryDto | null }) {
  const update = useUpdateRequirement();
  return (
    <div className="-ml-2 flex items-center gap-3 text-small lg:hidden">
      <StatusMenu
        status={requirement.status}
        pending={update.isPending && update.variables?.patch.status !== undefined}
        onChange={(status) => update.mutate({ requirement, patch: { status } })}
      />
      <AssigneeMenu
        assignee={requirement.assignee}
        currentUserId={me?.id ?? null}
        onChange={(assignee) => update.mutate({ requirement, patch: { assigneeId: assignee?.id ?? null }, assignee })}
      >
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted"
          aria-label={`负责人：${requirement.assignee?.displayName ?? "未指派"}，点击修改`}
        >
          <UserAvatar user={requirement.assignee} />
          <span className={cn(requirement.assignee === null && "text-subtle-foreground")}>
            {requirement.assignee?.displayName ?? "未指派"}
          </span>
        </button>
      </AssigneeMenu>
    </div>
  );
}

function PropertiesRail({
  projectId,
  requirement,
  me,
}: {
  projectId: string;
  requirement: RequirementListItemDto;
  me: UserSummaryDto | null;
}) {
  const update = useUpdateRequirement();
  return (
    <aside className="hidden w-[280px] shrink-0 flex-col gap-6 lg:flex" aria-label="需求属性">
      <dl className="m-0 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-small">
        <dt className="text-subtle-foreground">状态</dt>
        <dd className="m-0 -ml-2">
          <StatusMenu
            status={requirement.status}
            pending={update.isPending && update.variables?.patch.status !== undefined}
            onChange={(status) => update.mutate({ requirement, patch: { status } })}
          />
        </dd>
        <dt className="text-subtle-foreground">负责人</dt>
        <dd className="m-0">
          <AssigneeMenu
            assignee={requirement.assignee}
            currentUserId={me?.id ?? null}
            onChange={(assignee) => update.mutate({ requirement, patch: { assigneeId: assignee?.id ?? null }, assignee })}
          >
            <button
              type="button"
              className="-mx-2 inline-flex h-7 items-center gap-1.5 rounded-sm px-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted"
              aria-label={`负责人：${requirement.assignee?.displayName ?? "未指派"}，点击修改`}
            >
              <UserAvatar user={requirement.assignee} />
              <span className={cn(requirement.assignee === null && "text-subtle-foreground")}>
                {requirement.assignee?.displayName ?? "未指派"}
              </span>
            </button>
          </AssigneeMenu>
        </dd>
        <dt className="text-subtle-foreground">编号</dt>
        <dd className="m-0 font-mono text-caption">{requirementCode(requirement.number)}</dd>
        <dt className="text-subtle-foreground">创建</dt>
        <dd className="m-0">
          {requirement.createdBy.displayName} ·{" "}
          <time title={formatFullTime(requirement.createdAt)}>{formatRelativeTime(requirement.createdAt)}</time>
        </dd>
        <dt className="text-subtle-foreground">更新</dt>
        <dd className="m-0">
          {requirement.updatedBy.displayName} ·{" "}
          <time title={formatFullTime(requirement.updatedAt)}>{formatRelativeTime(requirement.updatedAt)}</time>
        </dd>
      </dl>
      <LocalDirectory projectId={projectId} />
      <section className="flex flex-col gap-2">
        <h2 className="m-0 flex items-center gap-2 text-small font-semibold">
          本机会话
          {requirement.localSessionCount > 0 ? (
            <span className="font-normal text-subtle-foreground">{requirement.localSessionCount}</span>
          ) : null}
        </h2>
        <LocalSessions projectId={projectId} requirementId={requirement.id} />
      </section>
    </aside>
  );
}

function LocalDirectory({ projectId }: { projectId: string }) {
  const mappings = useQuery({
    queryKey: requirementKeys.mappings,
    queryFn: () => api.listRequirementsMappings(),
    staleTime: 60_000,
  });
  const mapping = mappings.data?.items.find((item) => item.remoteProjectId === projectId);
  const inspection = useQuery({
    queryKey: ["local-dir-inspect", mapping?.rootPath ?? ""],
    queryFn: ({ signal }) => api.inspectLocalDir(mapping?.rootPath ?? "", { signal }),
    enabled: mapping !== undefined,
    staleTime: 30_000,
    retry: false,
  });
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-small font-semibold">本机代码目录</h2>
      {mappings.isPending ? <Skeleton className="h-9 w-full" /> : null}
      {mappings.isSuccess && mapping === undefined ? (
        <p className="m-0 text-caption text-subtle-foreground">
          这个项目还没关联你电脑上的代码目录。开始会话时会请你选择一次。
        </p>
      ) : null}
      {mapping === undefined ? null : (
        <div className="flex flex-col gap-1 rounded-md bg-muted px-2.5 py-2">
          <span className="flex items-center gap-1.5 font-mono text-caption text-foreground" title={mapping.rootPath}>
            <FolderGit2Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
            <span className="truncate">{shortenHome(mapping.rootPath)}</span>
          </span>
          <span className="text-caption text-subtle-foreground">{describeInspection(inspection.data)}</span>
        </div>
      )}
    </section>
  );
}

function describeInspection(
  inspection: Awaited<ReturnType<typeof api.inspectLocalDir>> | undefined,
): string {
  if (inspection === undefined) return "正在检查…";
  if (!inspection.exists) return "目录不存在了，开始会话时会请你重新选择";
  if (!inspection.readable || !inspection.writable) return "SuDuo 读写不了这个目录";
  if (!inspection.isGitRepo) return "可以读写 · 不是 Git 仓库";
  return inspection.branch === null ? "可以读写 · Git 仓库" : `可以读写 · 分支 ${inspection.branch}`;
}

function shortenHome(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+/.exec(path);
  return match === null ? path : `~${path.slice(match[0].length)}`;
}

function DetailSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 flex-col" aria-busy="true" aria-label="正在加载需求">
      <div className="flex h-[52px] items-center border-b border-border px-5">
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="mx-auto flex w-full max-w-[1120px] gap-10 px-8 py-6">
        <div className="flex flex-1 flex-col gap-4">
          <Skeleton className="h-8 w-3/5" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="hidden w-[280px] flex-col gap-3 lg:flex">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      </div>
    </div>
  );
}
