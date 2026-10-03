import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { RequirementDetailPage } from "../features/requirements/RequirementDetailPage.js";
import { RequirementsPage, validateRequirementsSearch } from "../features/requirements/RequirementsPage.js";
import { resetUploadQueues } from "../features/requirements/upload-queue.js";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageHost, showMessage } from "../ui/message.js";
import { MyWorkPage, validateMyWorkSearch } from "../features/my-work/MyWorkPage.js";
import { OverviewPage, validateOverviewSearch } from "../features/overview/OverviewPage.js";
import { RoomsPage, validateRoomsSearch, type RoomsSearch } from "../features/rooms/RoomsPage.js";
import { SessionsPage } from "../features/sessions/SessionsPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSection,
  readLastSection,
  sectionFromLegacyHash,
} from "../features/settings/sections.js";
import { BootFailure, BootSplash, RouteLoading } from "./pages/BootScreens.js";
import { LoginPage } from "./pages/LoginPage.js";
import { SetupPage } from "./pages/SetupPage.js";
import { pickProject, readLastProjectId, rememberProjectId, useProjects } from "./project-context.js";
import { queryKeys, settingsQuery } from "./queries.js";
import { AppShell } from "./shell/AppShell.js";

/**
 * 路由表（技术设计 §9.1）。URL 是项目上下文与筛选条件的唯一真相。
 * 旧路径（/requirements、/requirements/:id、/overview、/sessions?sessionId=、/）全部重定向到新路径。
 */

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** 从需求看板 / 列表打开的详情：关闭时回退即可回到原看板位置。 */
    fromList?: boolean;
  }
}

// ---------- 根：服务配置与登录拦截 ----------

function RootLayout() {
  const settings = useQuery(settingsQuery);
  const queryClient = useQueryClient();
  // 按「已完成」的地址判断：导航进行中 <Outlet> 渲染的仍是旧地址的页面，拿新地址判断会让旧页面
  // （如首页跳转）在未登录时挂上一帧，与登录跳转互相踩踏，来回跳转到更新深度超限（React #185）。
  const location = useRouterState({ select: (state) => state.resolvedLocation ?? state.location });
  const pathname = location.pathname;

  // 登录身份或服务地址变化（登录、过期、换人、换服务）时丢掉上一身份的缓存，避免把旧数据展示给新用户。
  const identity = useRef<string | undefined>(undefined);
  // 上一个真正登录过的身份：登录过期再由同一人登回时，不清空他进行中 / 失败待重试的上传。
  const signedIn = useRef<string | undefined>(undefined);
  const data = settings.data;
  const identityKey = data === undefined ? undefined : `${data.baseUrl ?? ""}|${data.session?.user.id ?? ""}`;
  useEffect(() => {
    if (identityKey === undefined || data === undefined) return;
    if (identity.current !== undefined && identity.current !== identityKey) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.settings[0] });
    }
    identity.current = identityKey;
    if (data.session !== null) {
      if (signedIn.current !== undefined && signedIn.current !== identityKey) resetUploadQueues();
      signedIn.current = identityKey;
    }
  }, [data, identityKey, queryClient]);

  let content;
  if (data === undefined) {
    // 只有首次读取失败才整页报错；后台刷新失败保留已有数据，由断线横幅提示。
    content = settings.isError ? (
      <BootFailure error={settings.error} onRetry={() => void settings.refetch()} />
    ) : (
      <BootSplash />
    );
  } else if (!data.configured && pathname !== "/setup") {
    content = <Navigate to="/setup" replace />;
  } else if (data.configured && data.session === null && pathname !== "/login" && pathname !== "/setup") {
    content = <Navigate to="/login" search={{ redirect: location.href }} replace />;
  } else if (data.session !== null && pathname === "/login") {
    const redirect = (location.search as { redirect?: string }).redirect;
    content = <Navigate to={redirect !== undefined && redirect.startsWith("/") ? redirect : "/my"} replace />;
  } else {
    content = <Outlet />;
  }
  return (
    <TooltipProvider delayDuration={300}>
      {content}
      <MessageHost pageFailure={false} />
    </TooltipProvider>
  );
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
});

// ---------- 无外壳页面 ----------

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  validateSearch: (search: Record<string, unknown>): { step?: number } => {
    const step = Number(search["step"]);
    return Number.isInteger(step) && step >= 1 && step <= 5 ? { step } : {};
  },
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search["redirect"] === "string" ? { redirect: search["redirect"] } : {},
  component: LoginPage,
});

// ---------- 外壳 ----------

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

function MyRoute() {
  return <MyWorkPage />;
}

const myRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/my",
  validateSearch: validateMyWorkSearch,
  component: MyRoute,
});

/** 根路径：旧版 /?sessionId= 深链接转到会话，其余落在「我的工作」。 */
function IndexRedirect() {
  const search = useSearch({ strict: false }) as { sessionId?: string };
  if (typeof search.sessionId === "string" && search.sessionId !== "") {
    return <Navigate to="/sessions/$sessionId" params={{ sessionId: search.sessionId }} replace />;
  }
  return <Navigate to="/my" replace />;
}

const indexRoute = createRoute({ getParentRoute: () => shellRoute, path: "/", component: IndexRedirect });

// ---------- 项目分区 /p/$projectId ----------

function ProjectLayout() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const projects = useProjects();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const found = projects.data?.some((project) => project.id === projectId) ?? false;
  // 缓存里找不到时先刷新一次再判定：可能是刚被别人新建的项目。
  const [recheckedFor, setRecheckedFor] = useState<string | null>(null);
  const refetch = projects.refetch;

  useEffect(() => {
    if (found) rememberProjectId(projectId);
  }, [found, projectId]);
  useEffect(() => {
    if (projects.data !== undefined && !found && recheckedFor !== projectId) {
      void refetch().finally(() => setRecheckedFor(projectId));
    }
  }, [found, projectId, projects.data, recheckedFor, refetch]);

  if (projects.isPending) return <RouteLoading />;
  if (projects.isError && projects.data === undefined) return <Outlet />;
  if (!found) {
    if (recheckedFor !== projectId) return <RouteLoading />;
    // 项目不存在或已无权访问：换到可用项目的同一分区，而不是空白页。
    const fallback = pickProject(projects.data ?? [], null);
    if (fallback === null) return <Navigate to="/my" replace />;
    const rest = pathname.replace(/^\/p\/[^/]+/, "");
    if (rest.startsWith("/overview")) return <Navigate to="/p/$projectId/overview" params={{ projectId: fallback.id }} replace />;
    // 讨论：房间 id 只在原项目里有意义，换项目后进它的项目默认房间。
    if (rest.startsWith("/rooms")) return <Navigate to="/p/$projectId/rooms" params={{ projectId: fallback.id }} replace />;
    return <Navigate to="/p/$projectId/requirements" params={{ projectId: fallback.id }} replace />;
  }
  return <Outlet />;
}

const projectRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/p/$projectId",
  component: ProjectLayout,
});

function ProjectIndexRedirect() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  return <Navigate to="/p/$projectId/requirements" params={{ projectId }} replace />;
}

const projectIndexRoute = createRoute({ getParentRoute: () => projectRoute, path: "/", component: ProjectIndexRedirect });

function RequirementsRoute() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  return <RequirementsPage key={projectId} projectId={projectId} />;
}

const requirementsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/requirements",
  validateSearch: validateRequirementsSearch,
  component: RequirementsRoute,
});

function RequirementDetailRoute() {
  const { projectId, number } = useParams({ strict: false }) as { projectId: string; number: string };
  return <RequirementDetailPage key={`${projectId}/${number}`} projectId={projectId} numberRef={number} />;
}

/** `$number` 是需求编号；旧链接里的需求 id（UUID）同样可用，打开后换成编号地址。 */
const requirementDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/requirements/$number",
  component: RequirementDetailRoute,
});

function OverviewRoute() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  return <OverviewPage key={projectId} projectId={projectId} />;
}

const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/overview",
  validateSearch: validateOverviewSearch,
  component: OverviewRoute,
});

// ---------- 讨论（项目聊天房间） ----------

function RoomsRoute() {
  const { projectId, roomId } = useParams({ strict: false }) as { projectId: string; roomId?: string };
  const search = useSearch({ strict: false }) as RoomsSearch;
  return <RoomsPage key={projectId} projectId={projectId} roomId={roomId ?? null} search={search} />;
}

const roomsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/rooms",
  validateSearch: validateRoomsSearch,
  component: RoomsRoute,
});

const roomRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/rooms/$roomId",
  validateSearch: validateRoomsSearch,
  component: RoomsRoute,
});

// ---------- 旧项目路径重定向 ----------

function LegacyProjectRedirect({ section }: { section: "requirements" | "overview" }) {
  const projects = useProjects();
  const params = useParams({ strict: false }) as { requirementId?: string };
  const search = useSearch({ strict: false }) as { status?: string; remoteProjectId?: string };
  if (projects.isPending) return <RouteLoading />;
  const project = pickProject(projects.data ?? [], search.remoteProjectId ?? readLastProjectId());
  if (project === null) return <Navigate to="/my" replace />;
  if (section === "overview") {
    return <Navigate to="/p/$projectId/overview" params={{ projectId: project.id }} replace />;
  }
  if (params.requirementId !== undefined) {
    // 旧链接只有需求 id：先落到当前项目下，详情页读到需求后会换成它所在项目的编号地址。
    return (
      <Navigate
        to="/p/$projectId/requirements/$number"
        params={{ projectId: project.id, number: params.requirementId }}
        replace
      />
    );
  }
  return (
    <Navigate
      to="/p/$projectId/requirements"
      params={{ projectId: project.id }}
      search={validateRequirementsSearch(search)}
      replace
    />
  );
}

const legacyRequirementsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/requirements",
  component: () => <LegacyProjectRedirect section="requirements" />,
});

const legacyRequirementDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/requirements/$requirementId",
  component: () => <LegacyProjectRedirect section="requirements" />,
});

const legacyOverviewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/overview",
  component: () => <LegacyProjectRedirect section="overview" />,
});

// ---------- 会话 ----------

type SessionsSearch = { sessionId?: string; remoteProjectId?: string; filter?: "running" | "needs-me" | "room-tasks" };

/** 会话列表筛选写在 URL 里（技术设计 §9.1），可分享、可回退；「全部」不写。 */
function sessionFilterSearch(search: Record<string, unknown>): Pick<SessionsSearch, "filter"> {
  const filter = search["filter"];
  return filter === "running" || filter === "needs-me" || filter === "room-tasks" ? { filter } : {};
}

function SessionsRoute() {
  const params = useParams({ strict: false }) as { sessionId?: string };
  const search = useSearch({ strict: false }) as SessionsSearch;
  const navigate = useNavigate();
  const sessionId = params.sessionId ?? null;
  const session = useQuery({
    queryKey: queryKeys.session(sessionId ?? ""),
    queryFn: () => api.getSession(sessionId ?? ""),
    enabled: sessionId !== null,
    staleTime: 60_000,
    retry: false,
    // 切换会话时保留上一个会话，列表栏不卸载、搜索与筛选不丢。
    placeholderData: keepPreviousData,
  });
  const sessionMissing = sessionId !== null && session.isError;

  useEffect(() => {
    if (!sessionMissing) return;
    showMessage("这个会话已不存在或已被删除", "warning", { id: "session-missing" });
    void navigate({ to: "/sessions", replace: true });
  }, [navigate, sessionMissing]);

  const legacySessionId = sessionId === null && typeof search.sessionId === "string" && search.sessionId !== ""
    ? search.sessionId
    : null;
  useEffect(() => {
    if (typeof search.remoteProjectId === "string" && search.remoteProjectId !== "") {
      rememberProjectId(search.remoteProjectId);
    }
  }, [search.remoteProjectId]);

  // 旧深链接 /sessions?sessionId=&projectId=&remoteProjectId= → /sessions/$sessionId
  if (legacySessionId !== null) {
    return <Navigate to="/sessions/$sessionId" params={{ sessionId: legacySessionId }} replace />;
  }
  if (sessionId !== null && session.data === undefined && session.isPending) return <RouteLoading />;

  // 会话页跨项目：不依赖「当前项目」，直接按会话自己的项目打开。
  return <SessionsPage session={sessionId === null || sessionMissing ? null : (session.data ?? null)} />;
}

const sessionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/sessions",
  validateSearch: (search: Record<string, unknown>): SessionsSearch => ({
    ...(typeof search["sessionId"] === "string" ? { sessionId: search["sessionId"] } : {}),
    ...(typeof search["remoteProjectId"] === "string" ? { remoteProjectId: search["remoteProjectId"] } : {}),
    ...sessionFilterSearch(search),
  }),
  component: SessionsRoute,
});

const sessionDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/sessions/$sessionId",
  validateSearch: (search: Record<string, unknown>): Pick<SessionsSearch, "filter"> => sessionFilterSearch(search),
  component: SessionsRoute,
});

// ---------- 设置 ----------

/** `/settings` 与旧版 `/settings#组`：落到对应分组（没有锚点时回到上次看的分组）。 */
function SettingsIndexRedirect() {
  // 取正在进入的地址（state.location）的锚点，只算一次：本组件首次渲染时 resolvedLocation 还是上一页，
  // 用它会在应用内跳转（从 /my 到 /settings#mcp）时丢掉锚点；下面的跳转发出后地址会变，所以只读首次。
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [section] = useState(() => sectionFromLegacyHash(hash) ?? readLastSection() ?? DEFAULT_SETTINGS_SECTION);
  return <Navigate to="/settings/$section" params={{ section }} replace />;
}

const settingsRoute = createRoute({ getParentRoute: () => shellRoute, path: "/settings", component: SettingsIndexRedirect });

function SettingsSectionRoute() {
  const { section } = useParams({ strict: false }) as { section: string };
  if (!isSettingsSection(section)) {
    return <Navigate to="/settings/$section" params={{ section: DEFAULT_SETTINGS_SECTION }} replace />;
  }
  return <SettingsPage section={section} />;
}

const settingsSectionRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/settings/$section",
  component: SettingsSectionRoute,
});

// ---------- 组装 ----------

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  shellRoute.addChildren([
    indexRoute,
    myRoute,
    projectRoute.addChildren([projectIndexRoute, requirementsRoute, requirementDetailRoute, overviewRoute, roomsRoute, roomRoute]),
    legacyRequirementsRoute,
    legacyRequirementDetailRoute,
    legacyOverviewRoute,
    sessionsRoute,
    sessionDetailRoute,
    settingsRoute,
    settingsSectionRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultNotFoundComponent: () => <Navigate to="/my" replace />,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
