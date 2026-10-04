import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_RUNTIME_ID,
  SUDUO_DEFAULTS,
  type CodexTransportFactory,
} from "@suduo/client-contracts";
import { ApprovalService } from "./application/approval-service.js";
import { EventBroker } from "./application/event-broker.js";
import { CodexGlobalState } from "./application/codex-global-state.js";
import { EventLedger } from "./application/event-ledger.js";
import { IdleMonitor } from "./application/idle-monitor.js";
import { SessionEventStream } from "./application/event-stream.js";
import { IdempotencyService } from "./application/idempotency-service.js";
import { InterruptService } from "./application/interrupt-service.js";
import { GitService } from "./application/git-service.js";
import { MessageService } from "./application/message-service.js";
import { SettingsService } from "./application/settings-service.js";
import { ModelProviderService } from "./application/model-provider-service.js";
import { McpService } from "./application/mcp-service.js";
import { ProxyConnectivityService } from "./application/proxy-connectivity-service.js";
import { applyProxySettings } from "./application/proxy-settings.js";
import { SkillAdminService } from "./application/skill-admin-service.js";
import type { SkillRootsProvider } from "./application/skill-roots.js";
import { ProjectService } from "./application/project-service.js";
import { consumeRuntimeUntilAborted } from "./application/runtime-consumer.js";
import { RuntimeEventIngestor } from "./application/runtime-event-ingestor.js";
import { RuntimeSupervisor } from "./application/runtime-supervisor.js";
import { SessionService } from "./application/session-service.js";
import { SessionRunStatusService } from "./application/session-run-status-service.js";
import { SessionListService } from "./application/session-list-service.js";
import { SessionListRepository } from "./infrastructure/db/repositories/session-list-repository.js";
import { sharedWorkspace } from "./application/workspace-context.js";
import { WorkspaceService } from "./application/workspace-service.js";
import { openBetterSqlite3Database } from "./infrastructure/db/better-sqlite3-database.js";
import type { DatabasePort } from "./infrastructure/db/database-port.js";
import { runMigrations } from "./infrastructure/db/migration-runner.js";
import { prepareCodexHome } from "./infrastructure/platform/host-platform.js";
import { ApprovalRepository } from "./infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "./infrastructure/db/repositories/event-repository.js";
import { IdempotencyRepository } from "./infrastructure/db/repositories/idempotency-repository.js";
import { ProjectRepository } from "./infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "./infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "./infrastructure/db/repositories/session-thread-repository.js";
import { buildHttpServer } from "./infrastructure/http/http-server.js";
import { LoopbackGuard } from "./infrastructure/http/loopback-guard.js";
import { CodexRuntime } from "./infrastructure/runtime/codex/codex-runtime.js";
import { RuntimeRegistry } from "./infrastructure/runtime/runtime-registry.js";
import { StdioCodexTransport } from "./infrastructure/transport/stdio-codex-transport.js";
import { WorkspaceWatcher } from "./infrastructure/workspace/workspace-watcher.js";
import { runDoctor } from "./infrastructure/doctor/doctor-service.js";
import { RequirementsV2Service } from "./application/requirements-v2-service.js";
import { retireLegacySessionContext } from "./application/session-tools/legacy-cleanup.js";
import { RequirementTools } from "./application/session-tools/requirement-tools.js";
import { SessionContextService } from "./application/session-tools/session-context.js";
import { SessionToolService } from "./application/session-tools/session-tool-service.js";
import { MyWorkbenchService } from "./application/my-workbench-service.js";
import {
  LocalDirectoryService,
  mappedWorkspaceRoots,
} from "./application/local-directory-service.js";
import { RequirementSessionRefRepository } from "./infrastructure/db/repositories/requirement-session-ref-repository.js";
import { WorkspaceMappingRepository } from "./infrastructure/db/repositories/workspace-mapping-repository.js";
import { RequirementsCredentialStore } from "./infrastructure/requirements-v2/credential-store.js";
import { RequirementsRemoteClient } from "./infrastructure/requirements-v2/remote-client.js";
import { RequirementsSettingsStore } from "./infrastructure/requirements-v2/settings-store.js";
import { ApiError } from "./application/api-error.js";
import { AgentPresence } from "./application/agent-presence.js";
import { RemoteEventsHub } from "./application/remote-events-hub.js";
import { RoomAgentRunner } from "./application/room-agent/runner.js";
import { RoomTools } from "./application/session-tools/room-tools.js";
import { TokenRefresher } from "./application/token-refresher.js";
import { RoomTaskSessionRepository } from "./infrastructure/db/repositories/room-task-session-repository.js";

export interface SuDuoApplicationOptions {
  databasePath: string;
  codexBin: string;
  /** 测试可替换 stdio transport；生产始终使用 Codex app-server stdio。 */
  runtimeTransport?: CodexTransportFactory;
  codexHome?: string;
  /** 是否把 CODEX_HOME/skills 作为全局 skills 目录加载（默认 true；SUDUO_GLOBAL_SKILLS=0 关闭）。 */
  globalSkills?: boolean;
  /** 运行时设置文件（data/settings.json）。 */
  settingsFile?: string;
  /** 远程需求服务初始地址（用户可在 V2 设置中覆盖）。 */
  requirementsServiceUrl?: string;
  /** V2 专属本机数据目录：token / config。 */
  v2DataDirectory?: string;
  sseHeartbeatMs?: number;
  sseReplayPageSize?: number;
  runtimeRestartMaxMs?: number;
  fsWatchDebounceMs?: number;
  fsPollIntervalMs?: number;
  fsForcePolling?: boolean;
  logger?: boolean;
  onBackgroundError?(error: unknown): void;
  webRoot?: string;
  port?: number;
  installed?: boolean;
  idleExitMs?: number;
  onExitRequested?(reason: string): void;
}

export interface SuDuoApplication {
  server: FastifyInstance;
  database: DatabasePort;
  runtime: CodexRuntime;
  close(): Promise<void>;
}

export function createSuDuoApplication(
  options: SuDuoApplicationOptions,
): SuDuoApplication {
  const database = openBetterSqlite3Database(options.databasePath);
  runMigrations(database);

  const projects = new ProjectRepository(database);
  const sessions = new SessionRepository(database);
  const threads = new SessionThreadRepository(database);
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const idempotencyRecords = new IdempotencyRepository(database);
  const workspaceMappings = new WorkspaceMappingRepository(database);
  const requirementSessionRefs = new RequirementSessionRefRepository(database);
  const roomTasks = new RoomTaskSessionRepository(database);
  const v2DataDirectory =
    options.v2DataDirectory ?? resolve(dirname(options.databasePath), "requirements-v2");
  const requirementsSettings = new RequirementsSettingsStore(
    v2DataDirectory,
    options.requirementsServiceUrl,
  );
  const requirementsCredentials = new RequirementsCredentialStore(v2DataDirectory);
  const requirementsRemote = new RequirementsRemoteClient(
    requirementsSettings,
    requirementsCredentials,
  );
  const broker = new EventBroker();
  const ledger = new EventLedger(database, events, approvals, broker);
  const codexGlobalState = new CodexGlobalState();
  const ingestor = new RuntimeEventIngestor(threads, ledger, codexGlobalState);

  const codexHome = prepareCodexHome(options.codexHome ?? process.env["CODEX_HOME"]).path;
  const settingsService = new SettingsService(
    options.settingsFile ?? resolve(homedir(), ".suduo-settings.json"),
  );
  const inheritedCodexEnvironment = runtimeEnvironment(codexHome);
  const codexEnvironment = { ...inheritedCodexEnvironment };
  applyProxySettings(
    codexEnvironment,
    inheritedCodexEnvironment,
    settingsService.proxySettings(),
  );
  const runtime = new CodexRuntime({
    transport: options.runtimeTransport ?? new StdioCodexTransport(),
    codexBin: options.codexBin,
    env: codexEnvironment,
    runtimeId: DEFAULT_CODEX_RUNTIME_ID,
    // 回给 Codex 的说明（Windows 编码说明、「不支持」的报错）按会话的语言（中英双语 S7）。
    sessionLocale: (sessionId) => sessions.getById(sessionId)?.locale ?? null,
  });
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const supervisor = new RuntimeSupervisor(registry);
  settingsService.setProxySettingsChangedHandler(async () => {
    applyProxySettings(
      codexEnvironment,
      inheritedCodexEnvironment,
      settingsService.proxySettings(),
    );
    await runtime.restartConnection("egress proxy settings changed");
  });
  const modelProviderService = new ModelProviderService({
    controlPlane: runtime,
    codexBin: options.codexBin,
    codexHome,
  });
  const mcpService = new McpService({
    controlPlane: runtime,
    codexBin: options.codexBin,
    codexHome,
  });
  const proxyConnectivity = new ProxyConnectivityService(
    settingsService,
    modelProviderService,
  );
  const projectService = new ProjectService(projects, sessions);
  const runStatusService = new SessionRunStatusService(
    projects,
    sessions,
    events,
    approvals,
  );
  const sessionListService = new SessionListService({
    list: new SessionListRepository(database),
    threads,
    events,
    approvals,
  });
  const sessionContext = new SessionContextService({
    sessions,
    projects,
    mappings: workspaceMappings,
    refs: requirementSessionRefs,
    remote: requirementsRemote,
    roomTasks,
  });
  const sessionService = new SessionService(
    database,
    projects,
    sessions,
    threads,
    supervisor,
    () => settingsService.defaultApprovalMode(),
    undefined,
    requirementSessionRefs,
    undefined,
    {
      // 会话删除时清掉它在数据目录里的「改动」面板基线（workspace 在下方构造，回调运行时已就绪）。
      onStateChanged: ({ session }) => {
        if (session.state === "deleted") {
          void workspace.forgetSessionBaseline(session.id);
        }
      },
    },
  );
  const sessionTools = new SessionToolService({
    runtimes: registry,
    threads,
    approvals,
    ledger,
    context: sessionContext,
    tools: new RequirementTools(requirementsRemote),
    roomTools: new RoomTools(requirementsRemote),
    sessions,
  });
  // 登录 / 退出 / 改服务地址后：上游推送重连、本机 Agent 重新登记、续期重新排期（下方组装后绑定）。
  let remoteConnectionChanged: () => void = () => undefined;
  const requirementsV2 = new RequirementsV2Service(
    requirementsSettings,
    requirementsCredentials,
    requirementsRemote,
    workspaceMappings,
    projects,
    sessionService,
    requirementSessionRefs,
    database,
    sessionContext,
    () => remoteConnectionChanged(),
    (sessionId) => void workspace.captureBaselineInBackground(sessionId),
  );
  const myWorkbench = new MyWorkbenchService({
    refs: requirementSessionRefs,
    approvals,
    sessions,
    events,
    projects,
    mappings: workspaceMappings,
    remote: requirementsRemote,
  });
  const approvalService = new ApprovalService(
    approvals,
    threads,
    registry,
    ledger,
  );
  // 工具确认卡的决定由会话工具服务执行（ADR-0008）。
  approvalService.setToolConfirmationHandler(sessionTools);
  // 全局 skills：SuDuo 自带 CODEX_HOME 下的 skills + 用户目录 .codex/skills
  //（Windows 安装版 CODEX_HOME 与用户个人 codex 隔离，个人 skills 靠后者可见）。
  // provider 化：设置页切换开关后无须重启即可生效。
  const skillRoots: SkillRootsProvider = {
    roots: () =>
      settingsService.globalSkillsEnabled() && options.globalSkills !== false
        ? dedupePaths([
            ...(options.codexHome ? [resolve(options.codexHome, "skills")] : []),
            resolve(homedir(), ".codex", "skills"),
          ])
        : [],
  };
  const skillAdmin = new SkillAdminService();
  const gitService = new GitService(
    projects,
    () => settingsService.gitAutoCheckpointDefault(),
    // 回合前自动存档没有拿到请求语言时，用前端最近一次用过的界面语言（发消息的请求已先把它记下）。
    () => settingsService.locale() ?? "zh-CN",
  );
  /**
   * 把额外 skills 根目录登记进 codex 自身注册表——否则 codex 不认识这些 skill，
   * 消息里的 skill 引用会被静默忽略（UI 能选但模型收不到）。
   */
  const syncSkillRoots = async (projectRoot: string): Promise<void> => {
    const roots = [
      ...skillRoots.roots(),
      resolve(projectRoot, ".agents", "skills"),
    ].filter((root) => existsSync(root));
    await runtime.setExtraSkillRoots(roots);
  };
  const messageService = new MessageService(
    projects,
    sessions,
    threads,
    registry,
    supervisor,
    ledger,
    sessionContext,
    skillRoots,
    gitService,
    syncSkillRoots,
  );
  const interruptService = new InterruptService(
    projects,
    sessions,
    threads,
    events,
    registry,
    supervisor,
    ledger,
  );
  const eventStream = new SessionEventStream(
    events,
    broker,
    options.sseReplayPageSize ?? SUDUO_DEFAULTS.sseReplayPageSize,
  );
  const workspace = new WorkspaceService(
    projects,
    sessions,
    skillRoots,
    async (projectRoot) => {
      try {
        await syncSkillRoots(projectRoot);
        return await runtime.listSkills(projectRoot);
      } catch {
        return null;
      }
    },
    // 「改动」面板基线放数据目录、按内容去重，不再写进项目目录（需求会话上下文重做 4.7）。
    { baselineRoot: resolve(dirname(options.databasePath), "baselines") },
  );
  const workspaceWatcher = new WorkspaceWatcher({
    ...(options.fsWatchDebounceMs === undefined
      ? {}
      : { debounceMs: options.fsWatchDebounceMs }),
    ...(options.fsPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.fsPollIntervalMs }),
    ...(options.fsForcePolling === undefined
      ? {}
      : { forcePolling: options.fsForcePolling }),
  });

  approvalService.orphanPersistedPending("app-server restarted");

  const idleMonitor = new IdleMonitor({
    idleMs: options.idleExitMs ?? 0,
    onIdle: (idleMs) =>
      options.onExitRequested?.("idle for " + String(idleMs) + "ms"),
  });

  // ───────────── 项目聊天房间与共享 Agent（技术设计二）─────────────
  const remoteSession = () => {
    const baseUrl = requirementsSettings.getBaseUrl();
    return baseUrl === null ? null : { baseUrl, session: requirementsCredentials.getForBaseUrl(baseUrl) };
  };
  let agentPresence: AgentPresence | null = null;
  const remoteEvents = new RemoteEventsHub({
    openEvents: (signal, eventOptions) => requirementsRemote.openEvents(signal, eventOptions),
    connectionState: () => {
      const current = remoteSession();
      if (current === null) {
        return {
          state: "none",
          error: new ApiError(409, "REMOTE_SERVICE_NOT_CONFIGURED", (t) => t.remote.notConfigured),
        };
      }
      if (current.session === null) {
        return { state: "none", error: new ApiError(401, "AUTH_INVALID", (t) => t.remote.signInRequired) };
      }
      return { state: "ready", identity: current.baseUrl };
    },
    activity: idleMonitor,
    heartbeatMs: options.sseHeartbeatMs ?? SUDUO_DEFAULTS.sseHeartbeatMs,
    onBrowserPresenceChanged: () => agentPresence?.nudge(),
  });
  let roomRunner: RoomAgentRunner | null = null;
  agentPresence = new AgentPresence({
    dataDirectory: v2DataDirectory,
    remote: requirementsRemote,
    currentUserId: () => remoteSession()?.session?.user.id ?? null,
    browserActive: () => remoteEvents.browserClientCount() > 0,
    activity: idleMonitor,
    runs: () => roomRunner?.status() ?? { activeRun: null, queuedRuns: 0 },
    onRegistered: () => void roomRunner?.sync(),
  });
  const presence = agentPresence;
  roomRunner = new RoomAgentRunner({
    remote: requirementsRemote,
    presence,
    hub: remoteEvents,
    mappings: workspaceMappings,
    projects,
    roomTasks,
    sessionRecords: sessions,
    sessions: sessionService,
    messages: messageService,
    interrupts: interruptService,
    events,
    broker,
    context: sessionContext,
    // 所有者的界面语言：替 Agent 写进房间的固定文字与原因里的报错原文按它写（前端最近一次用过的界面语言）。
    ownerLocale: () => settingsService.locale() ?? "zh-CN",
  });
  const runner = roomRunner;
  sessionContext.setRoomRebuilder((record) => runner.rebuildSetup(record));
  const tokenRefresher = new TokenRefresher({
    settings: requirementsSettings,
    credentials: requirementsCredentials,
    remote: requirementsRemote,
    // 新令牌：上游推送按新令牌重连（远程在旧令牌过期时会断开旧连接）。
    onRefreshed: () => remoteEvents.restart(),
  });
  remoteConnectionChanged = () => {
    remoteEvents.restart();
    presence.restart();
    tokenRefresher.reschedule();
  };

  const consumerAbort = new AbortController();
  const restore = () =>
    restoreAttachedThreads({
      projects,
      sessions,
      threads,
      supervisor,
      signal: consumerAbort.signal,
      ...(options.onBackgroundError === undefined
        ? {}
        : { onError: options.onBackgroundError }),
    });
  const consumer = consumeRuntimeUntilAborted({
    runtime,
    ingestor,
    approvals: approvalService,
    supervisor,
    toolCalls: sessionTools,
    signal: consumerAbort.signal,
    recover: restore,
    onActivity: () => idleMonitor.touch(),
    restartMaxMs:
      options.runtimeRestartMaxMs ?? SUDUO_DEFAULTS.runtimeRestartMaxMs,
    ...(options.onBackgroundError === undefined
      ? {}
      : { onError: options.onBackgroundError }),
  });
  const restoration = restore();
  // 新版需求会话（ADR-0008）启动时的一次性清理与基线回收；尽力而为，不阻塞启动。
  void retireLegacySessionContext({
    v2DataDirectory,
    legacyMaterialPaths: requirementSessionRefs
      .listAll()
      .map((ref) => ref.materialPath)
      .filter((path): path is string => path !== null),
    sessionIds: sessions.listAllIds(),
    projectRoots: projects.list().map((project) => project.rootPath),
    codexHome: options.codexHome,
    retiredSkillsRoot: resolve(dirname(options.databasePath), "retired-skills"),
  }).catch((error: unknown) => options.onBackgroundError?.(error));
  void workspace.collectBaselineGarbage();
  const server = buildHttpServer({
    requestGuard: new LoopbackGuard(),
    idempotency: new IdempotencyService(idempotencyRecords),
    projects: projectService,
    sessions: sessionService,
    runStatus: runStatusService,
    sessionList: sessionListService,
    sessionContext,
    messages: messageService,
    approvals: approvalService,
    interrupts: interruptService,
    eventStream,
    codexGlobalState,
    workspace,
    workspaceWatcher,
    git: gitService,
    settings: settingsService,
    modelProvider: modelProviderService,
    mcp: mcpService,
    proxyConnectivity,
    requirementsV2,
    myWorkbench,
    rooms: {
      remote: requirementsRemote,
      agentState: () => presence.state(),
    },
    remoteEvents,
    localDirectories: new LocalDirectoryService({
      recentRoots: () => mappedWorkspaceRoots(workspaceMappings, projects),
    }),
    codexHome,
    skillAdmin,
    setSkillEnabled: (name, enabled) => runtime.setSkillEnabled(name, enabled),
    doctor: (locale) =>
      runDoctor({
        installed: options.installed ?? false,
        allowPortInUse: true,
        port: options.port ?? SUDUO_DEFAULTS.port,
        codexHome,
        codexBin: options.codexBin,
        checkPnpm: !(options.installed ?? false),
      }, locale),
    webRoot:
      options.webRoot ??
      fileURLToPath(new URL("../../web/dist/", import.meta.url)),
    sseHeartbeatMs:
      options.sseHeartbeatMs ?? SUDUO_DEFAULTS.sseHeartbeatMs,
    logger: options.logger ?? false,
    activity: idleMonitor,
    ...(options.onExitRequested === undefined
      ? {}
      : { requestShutdown: options.onExitRequested }),
  });
  idleMonitor.start();
  runner.start();
  remoteConnectionChanged();

  let closed = false;
  return {
    server,
    database,
    runtime,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      idleMonitor.stop();
      runner.stop();
      presence.stop();
      tokenRefresher.stop();
      remoteEvents.stop();
      consumerAbort.abort();
      workspaceWatcher.close();
      await Promise.allSettled([server.close()]);
      await Promise.allSettled([
        runtime.close(),
        consumer,
        restoration,
      ]);
      database.close();
    },
  };
}

function runtimeEnvironment(codexHome: string | undefined): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (codexHome) {
    env["CODEX_HOME"] = codexHome;
  }
  // Windows 上 Python 默认按 ANSI 代码页读写，中文文件会乱码；
  // PYTHONUTF8/PYTHONIOENCODING 强制 UTF-8（用户已设置的值优先）。
  env["PYTHONUTF8"] ??= "1";
  env["PYTHONIOENCODING"] ??= "utf-8";
  return env;
}

async function restoreAttachedThreads(input: {
  projects: ProjectRepository;
  sessions: SessionRepository;
  threads: SessionThreadRepository;
  supervisor: RuntimeSupervisor;
  signal: AbortSignal;
  onError?: (error: unknown) => void;
}): Promise<void> {
  for (const binding of input.threads.listAttached()) {
    if (input.signal.aborted) {
      return;
    }
    const session = input.sessions.getById(binding.sessionId);
    if (!session || session.state !== "active") {
      continue;
    }
    const project = input.projects.getById(session.projectId);
    if (!project || project.state !== "active") {
      continue;
    }
    try {
      await input.supervisor.ensureReady({
        session,
        workspace: sharedWorkspace(project, session.id),
        binding,
      });
    } catch (error) {
      input.onError?.(error);
    }
  }
}

/** 路径去重（大小写与分隔符不敏感，保序）。 */
function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(path);
    }
  }
  return result;
}
