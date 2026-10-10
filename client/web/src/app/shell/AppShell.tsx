import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { registerAuthExpiredHandler, reportFailure } from "../../feedback/report.js";
import { PageFailure } from "../../feedback/components/index.js";
import { usePageFailureProps } from "../../ui/message.js";
import { useCurrentProject, useProjects } from "../project-context.js";
import { RequirementsRealtimeProvider } from "../../features/requirements/realtime.js";
import { RoomLauncher } from "../../features/rooms/window/RoomLauncher.js";
import { RoomWindow } from "../../features/rooms/window/RoomWindow.js";
import { usePersistentState } from "../../ui/use-persistent-state.js";
import { CommandPalette } from "./CommandPalette.js";
import { ConnectionBanner } from "./ConnectionBanner.js";
import { UpdateBanner } from "./UpdateBanner.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js";
import { SessionLauncherProvider } from "./SessionLauncher.js";
import { Sidebar, sectionOf } from "./Sidebar.js";
import { clearProjectAction, setCommandPaletteOpen, setShortcutsOpen, usePendingProjectAction } from "./shell-actions.js";
import { ShortcutsDialog } from "./ShortcutsDialog.js";
import { useLogout } from "./use-logout.js";

/**
 * 应用外壳（技术设计 §4.1）：左侧栏 + 内嵌内容面板，没有全局顶栏。
 * - 侧栏展开 240 / 收起 56，⌘\ 切换并记忆；窗口窄于 1280 时首次进入默认收起。
 * - 进入会话页或讨论页且窗口窄于 1600 时自动收起，把宽度让给三栏；用户手动展开后本次不再干预。
 * - ⌘K 命令面板；断线横幅；新建项目 / 项目设置对话框；发起本机会话的统一入口；需求实时同步（一条 SSE）。
 * - 讨论悬浮入口与悬浮窗口（右下角，任何页面一键进房间；窄屏不显示）。
 */
export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [collapsedPref, setCollapsedPref] = usePersistentState(
    "suduo.sidebar.collapsed",
    typeof window !== "undefined" && window.innerWidth < 1280,
  );
  const [expandedInSessions, setExpandedInSessions] = useState(false);
  // 会话页、讨论页都是三栏：窄屏时把侧栏让出来。
  const section = sectionOf(pathname);
  const inSessions = section === "sessions" || section === "rooms";
  const narrow = useNarrowViewport();
  const collapsed = collapsedPref || (inSessions && narrow && !expandedInSessions);

  useEffect(() => {
    if (!inSessions) setExpandedInSessions(false);
  }, [inSessions]);

  // 一次按键必然生效：展开时同时解除「会话页自动收起」，收起时记为偏好。
  const toggleSidebar = () => {
    if (collapsed) {
      setCollapsedPref(false);
      setExpandedInSessions(true);
    } else {
      setCollapsedPref(true);
    }
  };

  const pendingAction = usePendingProjectAction();
  const [creatingProject, setCreatingProject] = useState(false);
  const [managingProject, setManagingProject] = useState(false);
  const { project } = useCurrentProject();
  useEffect(() => {
    if (pendingAction === "create") setCreatingProject(true);
    if (pendingAction === "manage") setManagingProject(true);
    if (pendingAction !== null) clearProjectAction();
  }, [pendingAction]);

  const logout = useLogout();
  useEffect(() => registerAuthExpiredHandler(() => void logout()), [logout]);

  // 项目列表读不到时不要静默显示「还没有项目」：交给反馈出口（登录失效 → 去登录，其余 → 重试）。
  const projects = useProjects();
  const refetchProjects = projects.refetch;
  useEffect(() => {
    if (!projects.isError || projects.data !== undefined) return;
    reportFailure(projects.error, { surface: "page", retry: () => void refetchProjects() });
  }, [projects.isError, projects.data, projects.error, projects.errorUpdatedAt, refetchProjects]);

  const pageFailure = usePageFailureProps();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      // 「?」快捷键一览：不在输入框里、没有别的弹层开着时才响应（Shift+/ 产生的就是 "?"）。
      if (event.key === "?" && !mod && !event.altKey && !event.defaultPrevented) {
        const target = event.target;
        const typing =
          target instanceof HTMLElement &&
          (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
        if (typing || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (mod && !event.altKey && event.key === "\\") {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
        ) {
          return;
        }
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <RequirementsRealtimeProvider enabled>
    <SessionLauncherProvider>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <Sidebar collapsed={collapsed} onToggleCollapse={toggleSidebar} />
        <main
          id="main-content"
          className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card"
        >
          <ConnectionBanner />
          <UpdateBanner />
          <div className="flex min-h-0 flex-1">
            {pageFailure === null ? (
              <Outlet />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <PageFailure {...pageFailure} />
              </div>
            )}
          </div>
        </main>
      </div>
      {/* 讨论悬浮窗口与悬浮入口：挂在外壳上，切换页面不卸载。 */}
      <RoomWindow />
      <RoomLauncher />
      <CommandPalette onToggleSidebar={toggleSidebar} />
      <ShortcutsDialog />
      <CreateProjectDialog open={creatingProject} onOpenChange={setCreatingProject} />
      <ProjectSettingsDialog
        project={project}
        open={managingProject && project !== null}
        onOpenChange={setManagingProject}
      />
    </SessionLauncherProvider>
    </RequirementsRealtimeProvider>
  );
}

const NARROW_QUERY = "(max-width: 1599px)";

/** 窗口是否窄于 1600：订阅 matchMedia，窗口缩放时实时更新。 */
function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const query = window.matchMedia(NARROW_QUERY);
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : window.innerWidth < 1600),
    () => false,
  );
}
