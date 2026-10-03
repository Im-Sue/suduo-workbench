import { useMyWorkData } from "../../features/my-work/queries.js";
import { attentionCount, flattenSessions, sessionListQuery } from "../../features/sessions/session-list.js";
import { totalUnread } from "../../features/rooms/model.js";
import { projectRoomsQuery } from "../../features/rooms/queries.js";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChartColumnIcon,
  InboxIcon,
  KanbanSquareIcon,
  LogOutIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n/provider.js";
import { applyThemePreference, useThemePreference, type ThemePreference } from "../../ui/theme.js";
import { useCurrentProject } from "../project-context.js";
import { settingsQuery } from "../queries.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { setCommandPaletteOpen } from "./shell-actions.js";
import { useLogout } from "./use-logout.js";

type Section = "my" | "requirements" | "rooms" | "sessions" | "overview" | "settings" | null;

export function sectionOf(pathname: string): Section {
  if (pathname.startsWith("/my")) return "my";
  if (/^\/p\/[^/]+\/requirements/.test(pathname)) return "requirements";
  if (/^\/p\/[^/]+\/overview/.test(pathname)) return "overview";
  if (/^\/p\/[^/]+\/rooms/.test(pathname)) return "rooms";
  if (pathname.startsWith("/sessions")) return "sessions";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
}

const itemClass = (active: boolean, collapsed: boolean) =>
  cn(
    "flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-small font-medium no-underline outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
    active ? "bg-muted-strong text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
    collapsed && "justify-center px-0",
  );

function NavTip({ collapsed, label, children }: { collapsed: boolean; label: string; children: ReactNode }) {
  if (!collapsed) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse(): void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const section = sectionOf(pathname);
  const { project } = useCurrentProject();
  const settings = useQuery(settingsQuery).data;
  const user = settings?.session?.user ?? null;
  const theme = useThemePreference();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const logout = useLogout();
  const t = useT();
  const nav = t.shell.nav;
  const noProjectReason = nav.noProject;
  // 需要你处理的会话数（等你确认或上一轮失败）：只算当前项目，与会话页共用同一条列表查询；
  // 跨项目的「等你确认 / 上一轮失败」由我的工作汇总。
  const sessions = useInfiniteQuery({
    ...sessionListQuery("active", "normal", project?.id),
    enabled: user !== null && project !== null,
  });
  const attention = attentionCount(flattenSessions(sessions.data), null);
  // 与我的工作页同一批查询、同一套判定，数字与「需要你处理」一致；侧栏只放宽刷新间隔。
  const onMyWork = section === "my";
  const todo = useMyWorkData({
    enabled: user !== null,
    // 在我的工作页上由页面自己的观察者刷新；侧栏只在别的页面上慢慢刷。
    workbenchInterval: onMyWork ? false : 30_000,
    listInterval: onMyWork ? false : 60_000,
  }).attention.length;
  // 讨论：当前项目各房间的未读合计（实时事件随时写进同一份列表缓存；这里只放宽兜底刷新）。
  const rooms = useQuery({
    ...projectRoomsQuery(project?.id ?? ""),
    enabled: user !== null && project !== null,
    refetchInterval: section === "rooms" ? false : 60_000,
  });
  const unread = totalUnread(rooms.data?.items);

  const projectLink = (
    to: "/p/$projectId/requirements" | "/p/$projectId/overview" | "/p/$projectId/rooms",
    label: string,
    icon: ReactNode,
    active: boolean,
    /** 只有「讨论」带徽标（未读合计）。 */
    badge?: { count: number; label: string },
  ) =>
    project === null ? (
      <NavTip collapsed={collapsed} label={nav.withNote(label, noProjectReason)}>
        <span
          aria-disabled="true"
          aria-label={nav.withNote(label, noProjectReason)}
          className={cn(itemClass(false, collapsed), "cursor-not-allowed opacity-45")}
          title={collapsed ? undefined : noProjectReason}
        >
          {icon}
          {collapsed ? null : label}
        </span>
      </NavTip>
    ) : (
      <NavTip collapsed={collapsed} label={badge !== undefined && badge.count > 0 ? nav.withNote(label, badge.label) : label}>
        <Link
          to={to}
          params={{ projectId: project.id }}
          aria-label={
            badge !== undefined && badge.count > 0 ? nav.withCount(label, badge.label) : collapsed ? label : undefined
          }
          aria-current={active ? "page" : undefined}
          className={cn(itemClass(active, collapsed), "relative")}
        >
          {icon}
          {collapsed ? null : <span className="flex-1">{label}</span>}
          {badge === undefined || badge.count === 0 ? null : collapsed ? (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-primary" aria-hidden="true" />
          ) : (
            <span
              className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-caption leading-none font-semibold text-primary-foreground"
              aria-hidden="true"
              data-testid="rooms-unread"
            >
              {badge.count > 99 ? "99+" : badge.count}
            </span>
          )}
        </Link>
      </NavTip>
    );

  return (
    <nav
      aria-label={nav.label}
      data-testid="app-nav"
      className={cn(
        "flex h-full shrink-0 flex-col gap-0.5 bg-background px-2 pt-2.5 pb-3 transition-[width] duration-(--dur-slow) ease-(--ease-enter)",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <ProjectSwitcher collapsed={collapsed} />

      <NavTip collapsed={collapsed} label={`${t.shell.commandPalette.title} ⌘K`}>
        <button
          type="button"
          aria-label={collapsed ? t.shell.commandPalette.title : undefined}
          onClick={() => setCommandPaletteOpen(true)}
          className={cn(
            "mt-1.5 mb-2.5 flex h-8 w-full items-center gap-2.5 rounded-sm border border-border bg-card px-2.5 text-small text-subtle-foreground outline-none transition-colors",
            "hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
            collapsed && "justify-center px-0",
          )}
        >
          <SearchIcon />
          {collapsed ? null : (
            <>
              <span className="flex-1 truncate text-left">{t.shell.commandPalette.sidebarLabel}</span>
              <Kbd>⌘K</Kbd>
            </>
          )}
        </button>
      </NavTip>

      <NavTip collapsed={collapsed} label={todo > 0 ? nav.withNote(nav.myWork, nav.myWorkTodo(todo)) : nav.myWork}>
        <Link
          to="/my"
          aria-label={collapsed || todo > 0 ? (todo > 0 ? nav.withCount(nav.myWork, nav.myWorkTodo(todo)) : nav.myWork) : undefined}
          aria-current={section === "my" ? "page" : undefined}
          className={cn(itemClass(section === "my", collapsed), "relative")}
        >
          <InboxIcon />
          {collapsed ? null : <span className="flex-1">{nav.myWork}</span>}
          {todo === 0 ? null : collapsed ? (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-primary" aria-hidden="true" />
          ) : (
            <span
              className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-caption leading-none font-semibold text-primary-foreground"
              aria-hidden="true"
              data-testid="my-work-attention"
            >
              {todo}
            </span>
          )}
        </Link>
      </NavTip>
      {projectLink("/p/$projectId/requirements", nav.requirements, <KanbanSquareIcon />, section === "requirements")}
      {projectLink("/p/$projectId/rooms", nav.rooms, <MessageCircleIcon />, section === "rooms", {
        count: unread,
        label: nav.roomsUnread(unread),
      })}
      <NavTip collapsed={collapsed} label={attention > 0 ? nav.withNote(nav.sessions, nav.sessionsAttention(attention)) : nav.sessions}>
        <Link
          to="/sessions"
          aria-label={collapsed || attention > 0 ? (attention > 0 ? nav.withCount(nav.sessions, nav.sessionsAttention(attention)) : nav.sessions) : undefined}
          aria-current={section === "sessions" ? "page" : undefined}
          className={cn(itemClass(section === "sessions", collapsed), "relative")}
        >
          <MessagesSquareIcon />
          {collapsed ? null : <span className="flex-1">{nav.sessions}</span>}
          {attention === 0 ? null : collapsed ? (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-warning" aria-hidden="true" />
          ) : (
            <span
              className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-warning px-1 text-caption leading-none font-semibold text-background"
              aria-hidden="true"
              data-testid="sessions-attention"
            >
              {attention}
            </span>
          )}
        </Link>
      </NavTip>
      {projectLink("/p/$projectId/overview", nav.overview, <ChartColumnIcon />, section === "overview")}

      <div className="flex-1" />

      <NavTip collapsed={collapsed} label={nav.settings}>
        <Link
          to="/settings"
          aria-label={collapsed ? nav.settings : undefined}
          aria-current={section === "settings" ? "page" : undefined}
          className={itemClass(section === "settings", collapsed)}
        >
          <SettingsIcon />
          {collapsed ? null : nav.settings}
        </Link>
      </NavTip>

      <div className={cn("mt-1 flex items-center gap-1 border-t border-border pt-2.5", collapsed ? "flex-col" : "pl-1")}>
        {/* 非模态：从菜单里打开确认框时不叠两层指针锁，避免路由切换后页面整体无法点击 */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t.shell.sidebar.accountMenu}
              className={cn(
                "flex h-8 min-w-0 items-center gap-2 rounded-sm px-1.5 text-small font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                collapsed ? "justify-center" : "flex-1",
              )}
            >
              <Avatar size="lg">
                <AvatarFallback name={user?.displayName ?? "?"} />
              </Avatar>
              {collapsed ? null : <span className="truncate">{user?.displayName ?? t.shell.sidebar.signedOut}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            {user === null ? null : (
              <DropdownMenuLabel className="flex flex-col gap-0.5 pb-2">
                <span className="text-small font-medium text-foreground">{user.displayName}</span>
                <span>{user.loginName}</span>
              </DropdownMenuLabel>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t.shell.sidebar.theme.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => {
                const next = value as ThemePreference;
                applyThemePreference(next);
              }}
            >
              <DropdownMenuRadioItem value="system"><MonitorIcon />{t.shell.sidebar.theme.system}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light"><SunIcon />{t.shell.sidebar.theme.light}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><MoonIcon />{t.shell.sidebar.theme.dark}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="danger" onSelect={() => setConfirmLogout(true)}>
              <LogOutIcon />
              {t.shell.sidebar.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <NavTip collapsed label={`${collapsed ? t.shell.sidebar.expand : t.shell.sidebar.collapse} ⌘\\`}>
          <button
            type="button"
            aria-label={collapsed ? t.shell.sidebar.expand : t.shell.sidebar.collapse}
            onClick={onToggleCollapse}
            className="flex size-8 shrink-0 items-center justify-center rounded-sm text-subtle-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
          >
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </button>
        </NavTip>
      </div>

      <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <AlertDialogContent>
          <AlertDialogTitle>{t.shell.sidebar.signOutConfirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{t.shell.sidebar.signOutConfirm.description}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.shell.sidebar.signOutConfirm.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // 先关掉确认框、让 Radix 释放焦点与指针锁，再退出并跳转登录页。
                event.preventDefault();
                setConfirmLogout(false);
                window.setTimeout(() => void logout(), 0);
              }}
            >
              {t.shell.sidebar.signOutConfirm.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
