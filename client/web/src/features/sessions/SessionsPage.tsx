import type { SessionDto, SessionListItemDto } from "@suduo/client-contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Group as PanelGroup, Panel, Separator as PanelSeparator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { api } from "../../api/client.js";
import { rememberProjectId, useCurrentProject } from "../../app/project-context.js";
import { SessionRuntime } from "../../app/SessionRuntime.js";
import { useSessionLauncher } from "../../app/shell/SessionLauncher.js";
import type { LinkedRequirement } from "../../components/RequirementMaterials.js";
import { classifyFailure } from "../../feedback/classify.js";
import { ConfirmDialog, RegionError } from "../../feedback/components/index.js";
import { reportFailure } from "../../feedback/report.js";
import { showMessage } from "../../ui/message.js";
import { requirementKeys } from "../requirements/keys.js";
import type { SessionLiveRunState } from "../../ui/session-status.js";
import { SessionList } from "./SessionList.js";
import { flattenSessions, sessionKeys, sessionListQuery, type SessionFilter, type SessionListData } from "./session-list.js";

/**
 * 会话页（需求 §4.5）：会话列表（默认 280px）｜会话（对话 + 检查面板），列表可拖宽、⌘B 收起。
 * 列表只列当前项目的会话（用户 2026-10-01 改口径）；打开别的项目的会话（从我的工作、需求页等处跳来）时，
 * 当前项目跟到会话所属项目。列表栏常驻，右侧会话按 key=sessionId 重挂，切会话时列表的搜索与筛选不丢。
 */
export function SessionsPage({ session }: { session: SessionDto | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const launcher = useSessionLauncher();
  const { project, isLoading: projectLoading } = useCurrentProject();
  const projectId = project?.id;
  // 筛选写在 URL 的 filter 参数里（技术设计 §9.1）：可分享、可回退，打开会话时保留。
  const search = useSearch({ strict: false }) as { filter?: "running" | "needs-me" | "room-tasks" };
  const filter: SessionFilter = search.filter ?? "all";
  // 普通会话与房间任务是服务端按 kind 分开的两份列表：普通筛选里没有房间任务。
  // 打开的是房间任务会话时也取一份房间任务列表：只读说明里「在讨论里查看」要用它对应的房间话题。
  const normalList = useInfiniteQuery({ ...sessionListQuery("active", "normal", projectId), enabled: projectId !== undefined });
  const roomTaskList = useInfiniteQuery({
    ...sessionListQuery("active", "room_task", projectId),
    enabled: projectId !== undefined && (filter === "room-tasks" || session?.kind === "room_task"),
  });
  const list = filter === "room-tasks" ? roomTaskList : normalList;
  const items = flattenSessions(list.data);
  const normalItems = flattenSessions(normalList.data);
  const setFilter = (next: SessionFilter) => {
    const nextSearch = next === "all" ? {} : { filter: next };
    if (activeId === null) void navigate({ to: "/sessions", search: nextSearch, replace: true });
    else void navigate({ to: "/sessions/$sessionId", params: { sessionId: activeId }, search: nextSearch, replace: true });
  };
  const [keyword, setKeyword] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SessionListItemDto | null>(null);
  const activeId = session?.id ?? null;

  // 当前项目跟到打开的会话所属项目（本机目录映射是一对一的）；每个会话只跟一次，
  // 之后在左上角换项目由切换器收起会话，不会被这里拉回去。
  const mappings = useQuery({
    queryKey: requirementKeys.mappings,
    queryFn: () => api.listRequirementsMappings(),
    staleTime: 60_000,
  });
  const followedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (session === null) {
      followedSessionRef.current = null;
      return;
    }
    if (mappings.data === undefined || followedSessionRef.current === session.id) return;
    followedSessionRef.current = session.id;
    const owner = mappings.data.items.find((item) => item.localProjectId === session.projectId)?.remoteProjectId;
    if (owner !== undefined && owner !== projectId) rememberProjectId(owner);
  }, [mappings.data, projectId, session]);
  const activeItem =
    activeId === null
      ? undefined
      : (items.find((item) => item.id === activeId) ??
        flattenSessions(normalList.data).find((item) => item.id === activeId) ??
        flattenSessions(roomTaskList.data).find((item) => item.id === activeId));

  /**
   * 选中会话的实时运行态：SessionRuntime 经 SSE 得到后回传。会话激活一变就清零（绘制前），
   * 新 Runtime 首次回传之前不拿上一次激活残留的值冒充实时值；字段相等时复用旧对象。
   */
  const [live, setLive] = useState<SessionLiveRunState | null>(null);
  useLayoutEffect(() => setLive(null), [activeId]);
  const onRunStateChange = useCallback((next: SessionLiveRunState) => {
    setLive((current) =>
      current !== null &&
      current.sessionId === next.sessionId &&
      current.running === next.running &&
      current.pendingApprovals === next.pendingApprovals &&
      current.lastTurnOutcome === next.lastTurnOutcome
        ? current
        : next,
    );
  }, []);
  // 选中会话的运行态变了（开始 / 结束 / 等审批），列表的摘要、排序、最后一句随之刷新。
  const liveKey = live === null ? null : `${live.sessionId}:${live.running}:${live.pendingApprovals}:${live.lastTurnOutcome ?? ""}`;
  useEffect(() => {
    if (liveKey !== null) void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
  }, [liveKey, queryClient]);

  // 关联需求（会话头的入口用）：开工版本、新版 / 旧版会话等由会话页自己读会话上下文接口。
  const linkedRequirement: LinkedRequirement | null =
    activeItem?.requirement == null
      ? null
      : {
          id: activeItem.requirement.remoteRequirementId,
          number: activeItem.requirement.number,
          title: activeItem.requirement.title,
        };

  // 列表栏：可拖宽、记住宽度；⌘B 收起 / 展开（输入框里不拦截）。
  const listPanel = usePanelRef();
  const layout = useDefaultLayout({ id: "suduo.sessions.layout", panelIds: ["session-list", "session-main"], storage: safeLocalStorage });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      event.preventDefault();
      const panel = listPanel.current;
      if (panel === null) return;
      if (panel.isCollapsed()) panel.expand();
      else panel.collapse();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listPanel]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: sessionKeys.all });

  /** 在列表缓存里原地改一条（乐观更新 / 会话头改名后的同步）；返回改之前的缓存，失败时用来回滚。 */
  const patchListItem = (id: string, patch: Partial<SessionListItemDto>) => {
    const before = queryClient.getQueriesData<SessionListData>({ queryKey: sessionKeys.all });
    for (const [key, data] of before) {
      if (data === undefined) continue;
      queryClient.setQueryData<SessionListData>(key, {
        ...data,
        pages: data.pages.map((page) => ({ ...page, items: page.items.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) })),
      });
    }
    return before;
  };

  // 改名先改界面，失败回滚并提示（技术设计 §6.3）。
  const rename = async (item: SessionListItemDto, title: string) => {
    const before = patchListItem(item.id, { title });
    try {
      await api.updateSession(item.id, { title });
      refresh();
    } catch (cause) {
      for (const [key, data] of before) queryClient.setQueryData(key, data);
      reportFailure(cause, { surface: "action", title: "没能重命名" });
    }
  };

  // 归档可逆：不弹确认，给「撤销」（技术设计 §6）。
  const archive = async (item: SessionListItemDto) => {
    try {
      await api.updateSession(item.id, { state: "archived" });
      if (item.id === activeId) void navigate({ to: "/sessions" });
      refresh();
      showMessage(`已归档「${item.title || "未命名会话"}」`, "success", {
        action: {
          label: "撤销",
          onClick: () =>
            void api
              .updateSession(item.id, { state: "active" })
              .then(refresh)
              .catch((cause: unknown) => reportFailure(cause, { surface: "action", title: "没能撤销归档" })),
        },
      });
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: "没能归档" });
    }
  };

  // 删除不可逆：二次确认，默认焦点在「取消」。
  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (target === null) return;
    try {
      await api.deleteSession(target.id);
      if (target.id === activeId) void navigate({ to: "/sessions" });
      refresh();
      showMessage(`已删除「${target.title || "未命名会话"}」`, "success");
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: "没能删除" });
    }
  };

  const listError =
    list.isError && list.data === undefined ? (
      <div className="p-2">
        <RegionError
          kind={classifyFailure(list.error).kind}
          message={`没能读取会话列表：${classifyFailure(list.error).message}`}
          busy={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      </div>
    ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="sessions-workbench">
      <PanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
        <Panel id="session-list" panelRef={listPanel} defaultSize={280} minSize={220} maxSize={420} collapsible collapsedSize={0}>
          <div className="h-full min-w-0 overflow-hidden border-r border-border bg-background">
            <SessionList
              items={items}
              loading={projectLoading || (projectId !== undefined && list.isPending)}
              error={listError}
              hasMore={list.hasNextPage}
              loadingMore={list.isFetchingNextPage}
              activeSessionId={activeId}
              live={live}
              filter={filter}
              keyword={keyword}
              canCreate={project !== null && !project.isArchived}
              createDisabledReason={project === null ? "还没有项目：先在左上角新建一个项目" : "当前项目已归档，不能新建会话"}
              onFilterChange={setFilter}
              onKeywordChange={setKeyword}
              onLoadMore={() => void list.fetchNextPage()}
              onOpen={(item) =>
                void navigate({ to: "/sessions/$sessionId", params: { sessionId: item.id }, search: filter === "all" ? {} : { filter } })
              }
              onCreate={() => {
                if (project !== null) launcher.launch({ kind: "project", remoteProjectId: project.id });
              }}
              onRename={(item, title) => void rename(item, title)}
              onArchive={(item) => void archive(item)}
              onDelete={setPendingDelete}
              countItems={normalItems}
              onOpenRoom={(item) => {
                const task = item.roomTask;
                if (task == null) return;
                void navigate({
                  to: "/p/$projectId/rooms/$roomId",
                  params: { projectId: task.remoteProjectId, roomId: task.roomId },
                  search: { thread: task.threadRootId },
                });
              }}
            />
          </div>
        </Panel>
        <PanelSeparator className="w-px bg-border outline-none transition-colors hover:bg-primary focus-visible:bg-primary data-[separator=active]:bg-primary" />
        <Panel id="session-main" minSize={480}>
          <section className="flex h-full min-w-0 flex-col" aria-label="会话区">
            {session !== null ? (
              <SessionRuntime
                key={session.id}
                projectId={session.projectId}
                sessionId={session.id}
                onRunStateChange={onRunStateChange}
                linkedRequirement={linkedRequirement}
                roomTask={activeItem?.roomTask ?? null}
                {...(activeItem === undefined ? {} : { listTitle: activeItem.title })}
                onSessionChanged={(saved) => patchListItem(saved.id, { title: saved.title })}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-9 text-center">
                <MessagesSquareIcon className="size-6 text-subtle-foreground" aria-hidden="true" />
                <h2 className="m-0 text-section font-semibold text-foreground">选一个会话继续</h2>
                <p className="m-0 max-w-[380px] text-small text-muted-foreground">
                  从左侧列表打开会话；也可以在需求页从某个需求开始会话，或者新建一个项目会话。按 ⌘B 收起或展开列表。
                </p>
              </div>
            )}
          </section>
        </Panel>
      </PanelGroup>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`删除会话「${pendingDelete?.title || "未命名会话"}」？`}
        description="删除后对话记录不能恢复；项目文件和检查点不受影响。"
        confirmLabel="删除"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

/** 本地存储不可用时静默退化为不记忆宽度。 */
const safeLocalStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // 记不住宽度不影响使用。
    }
  },
};
