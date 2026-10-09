import { AI_COLLAB_FEATURE, AiActivityReporter, activityStatusOf } from "./application/collab/ai-activity-reporter.js";
import { AiActivitySettingRepository } from "./infrastructure/db/repositories/ai-activity-setting-repository.js";
import { ProjectRulesService } from "./application/collab/project-rules-service.js";
import { HandoffTools } from "./application/collab/handoff-tools.js";
import { SharedDraftService } from "./application/collab/shared-draft-service.js";
import { SharedDraftRepository } from "./infrastructure/db/repositories/shared-draft-repository.js";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CODEX_RUNTIME_ID,
  SUDUO_DEFAULTS,
  type CodexTransportFactory,
  type Locale,
  type SessionStartOptions,
  type SuDuoRunMode,
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
import { closeQueuedAfterRestart, MessageService, stableClientTurnId } from "./application/message-service.js";
import { SettingsService } from "./application/settings-service.js";
import { ModelProviderService } from "./application/model-provider-service.js";
import { McpService } from "./application/mcp-service.js";
import { ProxyConnectivityService } from "./application/proxy-connectivity-service.js";
import { agentChildEnv } from "./application/agents/agent-exec.js";
import { AGENT_CATALOG } from "./application/agents/catalog.js";
import { SessionReaderService } from "./application/context/session-reader.js";
import { SchedulerService } from "./application/scheduler/scheduler-service.js";
import { DelegationService, oneLine } from "./application/collab/delegation-service.js";
import { DelegationTools } from "./application/collab/delegation-tools.js";
import { messagesFor } from "./i18n/messages/index.js";
import { delegateChildDropsTool, reviewerDropsTool, reviewSubmitSpec, trialDropsTool } from "./application/session-tools/catalog.js";
import { TrialService } from "./application/collab/trial-service.js";
import { WorktreeManager } from "./application/collab/worktree-manager.js";
import { TrialRepository } from "./infrastructure/db/repositories/trial-repository.js";
import { ReviewService } from "./application/collab/review-service.js";
import { ReviewTools } from "./application/collab/review-tools.js";
import { ReviewRepository } from "./infrastructure/db/repositories/review-repository.js";
import { formatRequirementNumber } from "@suduo/cloud-contracts";
import { DelegationRepository } from "./infrastructure/db/repositories/delegation-repository.js";
import { TurnScheduler } from "./application/scheduler/turn-scheduler.js";
import { applyProxySettings } from "./application/proxy-settings.js";
import { SkillAdminService } from "./application/skill-admin-service.js";
import type { SkillRootsProvider } from "./application/skill-roots.js";
import { ProjectService } from "./application/project-service.js";
import { consumeRuntimeUntilAborted } from "./application/runtime-consumer.js";
import { RuntimeEventIngestor } from "./application/runtime-event-ingestor.js";
import { RuntimeSupervisor } from "./application/runtime-supervisor.js";
import { SessionService, type SessionThreadSetup } from "./application/session-service.js";
import { SessionRunStatusService } from "./application/session-run-status-service.js";
import { SessionListService } from "./application/session-list-service.js";
import { SessionListRepository } from "./infrastructure/db/repositories/session-list-repository.js";
import { WorkspaceContextResolver } from "./application/workspace-context.js";
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
import { AgentCatalogService } from "./application/agents/agent-catalog-service.js";
import { AgentSettingsStore, agentSettingsPathFor } from "./application/agents/agent-settings-store.js";
import { terminalOpener } from "./application/agents/terminal-login.js";
import { MCP_ENDPOINT_PATH } from "./infrastructure/mcp/mcp-endpoint.js";
import { ToolTokenRegistry } from "./infrastructure/mcp/tool-tokens.js";
import { LoopbackGuard } from "./infrastructure/http/loopback-guard.js";
import { AcpRuntime } from "./infrastructure/runtime/acp/acp-runtime.js";
import { ClaudeRuntime, CLAUDE_AGENT_ID } from "./infrastructure/runtime/claude/claude-runtime.js";
import { CodexRuntime } from "./infrastructure/runtime/codex/codex-runtime.js";
import { RuntimeRegistry } from "./infrastructure/runtime/runtime-registry.js";
import { StdioCodexTransport } from "./infrastructure/transport/stdio-codex-transport.js";
import { WorkspaceWatcher } from "./infrastructure/workspace/workspace-watcher.js";
import { runDoctor } from "./infrastructure/doctor/doctor-service.js";
import { adjustThreadSetup, RequirementsV2Service } from "./application/requirements-v2-service.js";
import { retireLegacySessionContext } from "./application/session-tools/legacy-cleanup.js";
import { RequirementTools } from "./application/session-tools/requirement-tools.js";
import { SessionContextService } from "./application/session-tools/session-context.js";
import { SessionToolService } from "./application/session-tools/session-tool-service.js";
import { MyWorkbenchService } from "./application/my-workbench-service.js";
import {
  LocalDirectoryService,
  linkedRemoteProjectIds,
  mappedWorkspaceRoots,
} from "./application/local-directory-service.js";
import { RequirementSessionRefRepository } from "./infrastructure/db/repositories/requirement-session-ref-repository.js";
import { SessionReferenceRepository } from "./infrastructure/db/repositories/session-reference-repository.js";
import { WorkspaceMappingRepository } from "./infrastructure/db/repositories/workspace-mapping-repository.js";
import { ProjectSessionRefRepository } from "./infrastructure/db/repositories/project-session-ref-repository.js";
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
  /** 启动后在后台检测各家 Agent（默认开；测试关掉，免得真去跑本机的 CLI）。 */
  prewarmAgents?: boolean;
  fsWatchDebounceMs?: number;
  fsPollIntervalMs?: number;
  fsForcePolling?: boolean;
  logger?: boolean;
  onBackgroundError?(error: unknown): void;
  webRoot?: string;
  port?: number;
  installed?: boolean;
  /** 运行形态与桌面外壳分配的实例标识，随 /healthz 带出。 */
  runMode?: SuDuoRunMode;
  instanceId?: string;
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
  // 本次启动之前的最后一个事件序号：退出前确认只看这之后开始的回合。
  const startupSeq = events.lastSeq();
  const approvals = new ApprovalRepository(database);
  const idempotencyRecords = new IdempotencyRepository(database);
  const workspaceMappings = new WorkspaceMappingRepository(database);
  const requirementSessionRefs = new RequirementSessionRefRepository(database);
  const projectSessionRefs = new ProjectSessionRefRepository(database);
  const roomTasks = new RoomTaskSessionRepository(database);
  const v2DataDirectory =
    options.v2DataDirectory ?? resolve(dirname(options.databasePath), "requirements-v2");
  const requirementsSettings = new RequirementsSettingsStore(
    v2DataDirectory,
    options.requirementsServiceUrl,
  );
  const requirementsCredentials = new RequirementsCredentialStore(v2DataDirectory);
  /**
   * 当前连着的服务器：目录关联按它区分（迁移 018）。配置文件读不了时当作未配置——
   * 列表类查询为空，不拖垮选目录、我的工作等页面；设置页另有报错。
   */
  const currentServerOrigin = (): string | null => {
    try {
      return requirementsSettings.getBaseUrl();
    } catch {
      return null;
    }
  };
  {
    // 升级前的存量关联没有服务器信息，记为当前服务器（绝大多数人没换过服务器）。
    const origin = currentServerOrigin();
    if (origin !== null) {
      workspaceMappings.adoptUnscoped(origin);
    }
  }
  const currentServerMappings = {
    list: () => workspaceMappings.list(currentServerOrigin()),
    listByLocalProjectId: (localProjectId: string) =>
      workspaceMappings.listByLocalProjectId(currentServerOrigin(), localProjectId),
  };
  const requirementsRemote = new RequirementsRemoteClient(
    requirementsSettings,
    requirementsCredentials,
  );
  const broker = new EventBroker();
  // 协作记录上报（多 Agent 协作 S11，P2-D1）：只含元数据，默认开，可按会话关（接着做、委派、评审跟着发起的会话）。
  const aiActivity = new AiActivityReporter({
    requirementOf: (sessionId) => requirementSessionRefs.getBySessionId(sessionId)?.remoteRequirementId ?? null,
    settings: new AiActivitySettingRepository(database),
    parentOf: (sessionId) => sessions.getById(sessionId)?.parentSessionId ?? null,
    remote: { recordAiActivity: (requirementId, input) => requirementsRemote.recordAiActivity(requirementId, input) },
    supportsActivity: async () => {
      const baseUrl = requirementsSettings.getBaseUrl();
      if (baseUrl === null) return null;
      const health = await requirementsRemote.testConnection(baseUrl, "en").catch(() => null);
      return health === null ? null : health.features.includes(AI_COLLAB_FEATURE);
    },
  });
  // 委派、评审的状态变化（卡片事件）顺带报成协作记录。
  broker.subscribeAll((event) => {
    if (event.type !== "delegation.updated" && event.type !== "review.updated") return;
    const payload = event.payload as Record<string, unknown>;
    const sessionId = event.type === "delegation.updated" ? payload["parentSessionId"] : payload["targetSessionId"];
    if (typeof sessionId !== "string" || typeof payload["id"] !== "string" || typeof payload["agentId"] !== "string" || typeof payload["status"] !== "string") return;
    aiActivity.report({
      sessionId,
      localRef: payload["id"],
      kind: event.type === "delegation.updated" ? "delegate" : "review",
      status: activityStatusOf(payload["status"]),
      agentId: payload["agentId"],
    });
  });
  const ledger = new EventLedger(database, events, approvals, broker);
  const codexGlobalState = new CodexGlobalState();
  const ingestor = new RuntimeEventIngestor(threads, ledger, codexGlobalState);

  const codexHome = prepareCodexHome(options.codexHome ?? process.env["CODEX_HOME"]).path;
  const settingsFile = options.settingsFile ?? resolve(homedir(), ".suduo-settings.json");
  const settingsService = new SettingsService(settingsFile);
  // 多 Agent（ADR-0014）：本机 Agent 的检测与设置；只用各家 CLI 自己的命令，不读凭据（ADR-0016）。
  const agentCatalog = new AgentCatalogService({
    store: new AgentSettingsStore(agentSettingsPathFor(settingsFile)),
    codexBin: options.codexBin,
  });
  // 启动后在后台检测一遍各家 Agent：开工对话框与 AI Agent 设置打开时就有结果（不阻塞启动）。
  const prewarm =
    options.prewarmAgents === false ? null : setTimeout(() => void agentCatalog.list().catch(() => undefined), 2_000);
  prewarm?.unref();
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
  // Claude Code（ADR-0014）：经官方 Agent SDK 驱动用户本机的 claude；环境同 Codex（不带 CODEX_HOME），代理设置同步生效。
  const inheritedAgentEnvironment = runtimeEnvironment(undefined);
  const agentEnvironment = { ...inheritedAgentEnvironment };
  applyProxySettings(agentEnvironment, inheritedAgentEnvironment, settingsService.proxySettings());
  const claudeRuntime = new ClaudeRuntime({
    resolveExecutable: () => agentCatalog.executablePath(CLAUDE_AGENT_ID),
    env: () => agentChildEnv(agentEnvironment) as Record<string, string>,
    onAuthRequired: () => agentCatalog.markAuthRequired(CLAUDE_AGENT_ID),
  });
  registry.register(claudeRuntime);
  // 标准 ACP 的各家 Agent（ADR-0014）：每家一个运行时实例，每个会话一个 Agent 进程。
  const acpRuntimes = AGENT_CATALOG.filter((agent) => agent.channel === "acp" && agent.runtimeAvailable).map((agent) => {
    const acpRuntime = new AcpRuntime({
      agentId: agent.id,
      agentName: agent.displayName,
      launch: () => {
        const file = agentCatalog.executablePath(agent.id);
        return file === null ? null : { file, args: agent.launchArgs };
      },
      env: () => agentChildEnv(agentEnvironment) as Record<string, string>,
      onAuthRequired: () => agentCatalog.markAuthRequired(agent.id),
      onReady: () => agentCatalog.markAuthOk(agent.id),
    });
    registry.register(acpRuntime);
    return acpRuntime;
  });
  // SuDuo 本机 MCP 工具服务（ADR-0015）：令牌只在内存；地址取本机服务实际监听的端口（还没监听时为 null，退回 dynamicTools）。
  const toolTokens = new ToolTokenRegistry();
  let httpServer: FastifyInstance | null = null;
  const toolServerUrl = (): string | null => {
    const address = httpServer?.server.address();
    return address !== null && address !== undefined && typeof address === "object"
      ? `http://127.0.0.1:${String(address.port)}${MCP_ENDPOINT_PATH}`
      : null;
  };
  const supervisor = new RuntimeSupervisor(registry, process.env, { tokens: toolTokens, url: toolServerUrl });
  settingsService.setProxySettingsChangedHandler(async () => {
    // Claude 下次启动查询时生效（已在跑的查询不重启）。
    applyProxySettings(agentEnvironment, inheritedAgentEnvironment, settingsService.proxySettings());
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
    projectRefs: projectSessionRefs,
    refs: requirementSessionRefs,
    remote: requirementsRemote,
    roomTasks,
  });
  // 本机调度在下方组装；会话状态变化的回调运行时它已就绪。
  let cancelQueuedTurns: ((sessionId: string, reason?: string) => void) | null = null;
  // 会话在哪个目录干活：记了工作目录的（并行试做的 worktree，多 Agent 协作 S10）用它，其余在项目目录。
  const workspaces = new WorkspaceContextResolver((sessionId) => sessions.getById(sessionId)?.workspacePath ?? null);
  const sessionService = new SessionService(
    database,
    projects,
    sessions,
    threads,
    supervisor,
    () => settingsService.defaultApprovalMode(),
    workspaces,
    requirementSessionRefs,
    undefined,
    {
      // 会话删除时清掉它在数据目录里的「改动」面板基线（workspace 在下方构造，回调运行时已就绪）。
      onStateChanged: ({ session }) => {
        if (session.state === "deleted") {
          void workspace.forgetSessionBaseline(session.id);
        }
        // 删除或归档的会话不再开回合：撤掉它在本机队列里排着的（多 Agent 协作 S8）。
        if (session.state === "deleted" || session.state === "archived") {
          cancelQueuedTurns?.(session.id, session.state);
        }
      },
    },
    projectSessionRefs,
  );
  // 跨会话读取（多 Agent 协作 S7）：从账本分层读另一个会话；改动用它的工作区基线（WorkspaceService 在下方组装）。
  const sessionReader = new SessionReaderService({
    sessions,
    events,
    references: new SessionReferenceRepository(database),
    requirementRefs: requirementSessionRefs,
    workspace: {
      hasBaseline: (sessionId) => workspace.hasBaseline(sessionId),
      listChanges: (sessionId) => workspace.listChanges(sessionId),
      diff: (sessionId, path) => workspace.diff(sessionId, path),
    },
    agentName: (agentId) => AGENT_CATALOG.find((agent) => agent.id === agentId)?.displayName ?? agentId,
    // 关联的远程项目在别的需求服务上（另一个账号 / 团队）：不列、不读。没关联远程项目的本机会话都算同一个。
    otherAccount: (sessionId) => {
      const remoteProjectId =
        requirementSessionRefs.getBySessionId(sessionId)?.remoteProjectId ?? projectSessionRefs.getBySessionId(sessionId)?.remoteProjectId ?? null;
      if (remoteProjectId === null) return false;
      const mapping = workspaceMappings.getByRemoteProjectId(remoteProjectId);
      const current = currentServerOrigin();
      return mapping !== null && mapping.serverOrigin !== null && current !== null && mapping.serverOrigin !== current;
    },
  });
  const sessionTools = new SessionToolService({
    runtimes: registry,
    threads,
    approvals,
    ledger,
    context: sessionContext,
    tools: new RequirementTools(requirementsRemote),
    roomTools: new RoomTools(requirementsRemote),
    sessionReader,
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
    (sessionId) => {
      void workspace.captureBaselineInBackground(sessionId);
      // 协作记录（S11，P2-D1）：需求会话开工。委派、评审、试做的会话由各自的记录报，不重复。
      const created = sessions.getById(sessionId);
      if (created !== null && (created.relation === null || created.relation === undefined || created.relation === "continue")) {
        aiActivity.report({ sessionId, localRef: sessionId, kind: "session", status: "opened", agentId: created.agentId });
      }
    },
  );
  const myWorkbench = new MyWorkbenchService({
    refs: requirementSessionRefs,
    approvals,
    sessions,
    events,
    projects,
    mappings: currentServerMappings,
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
    workspaces,
  );
  const interruptService = new InterruptService(
    projects,
    sessions,
    threads,
    events,
    registry,
    supervisor,
    ledger,
    workspaces,
  );
  // 本机回合调度（多 Agent 协作 S8，需求 4.11）：每家与合计的上限取 AI Agent 设置；回合终态还名额，另有定时对账。
  const turnScheduler = new TurnScheduler({
    limits: () => ({ global: agentCatalog.globalConcurrency(), perAgent: (agentId) => agentCatalog.concurrency(agentId) }),
  });
  messageService.setScheduler(turnScheduler);
  cancelQueuedTurns = (sessionId, reason) => turnScheduler.cancelSession(sessionId, reason);
  agentCatalog.onSettingsChanged(() => turnScheduler.refresh());
  const releaseOnTurnEnd = broker.subscribeAll((event) => {
    if (event.turnRef === null) return;
    if (event.type === "turn.started") {
      // 运行时自己接着开的回合（Claude、ACP 会话内排队）也占名额。
      const session = sessions.getById(event.sessionId);
      turnScheduler.turnStarted({ sessionId: event.sessionId, agentId: session?.agentId ?? "codex", turnId: event.turnRef.turnId, label: session?.title ?? "" });
    }
    if (event.type === "turn.completed" || event.type === "turn.interrupted") {
      turnScheduler.turnEnded(event.sessionId, event.turnRef.turnId);
    }
  });
  const schedulerReconcile = setInterval(() => {
    turnScheduler.reconcile((sessionId) => events.listRunningTurnRefs(sessionId).map((ref) => ref.turnId), 60_000);
  }, 30_000);
  schedulerReconcile.unref();
  const schedulerService = new SchedulerService({
    scheduler: turnScheduler,
    sessions,
    agentName: (agentId) => AGENT_CATALOG.find((agent) => agent.id === agentId)?.displayName ?? agentId,
    agentIds: () => AGENT_CATALOG.filter((agent) => agent.runtimeAvailable).map((agent) => agent.id),
    interrupt: (sessionId, turnId) => interruptService.interrupt(sessionId, { turnId }),
  });
  // 委派（多 Agent 协作 S8，需求 4.3）：子会话与发起会话同一需求 / 项目、同一目录，带子任务的角色说明、不挂委派工具。
  const agentDisplayName = (agentId: string) => AGENT_CATALOG.find((agent) => agent.id === agentId)?.displayName ?? agentId;
  // 子会话不挂委派、请求评审（深度 1，R2）与对外写工具（技术设计 2.9：评论由发起会话去发），见 delegateChildDropsTool。
  const delegateDropsTool = delegateChildDropsTool;
  const delegateRole = (child: { locale: Locale; parentSessionId?: string | null }) => {
    const parent = child.parentSessionId ? sessions.getById(child.parentSessionId) : null;
    return messagesFor(child.locale).delegation.role(agentDisplayName(parent?.agentId ?? "codex"), child.parentSessionId ?? "");
  };
  // 线程续接失败要重建时，委派的子会话照样带角色说明、不挂这些工具（否则重建后又能看到委派工具）。
  // 评审会话（S9）：只读，只有只读工具与提交评审意见（技术设计 2.9）；结论笔记、对外写、委派、请求评审都不给。
  const reviewerRole = (reviewer: { locale: Locale; parentSessionId?: string | null }) => {
    const target = reviewer.parentSessionId ? sessions.getById(reviewer.parentSessionId) : null;
    return messagesFor(reviewer.locale).review.role(agentDisplayName(target?.agentId ?? "codex"), reviewer.parentSessionId ?? "");
  };
  // 线程续接失败要重建时，委派的子会话、评审会话、试做的版本照样带角色说明与各自的工具（否则重建后又能看到委派工具）。
  sessionContext.setRebuildAdjust((sessionId, setup) => {
    const session = sessions.getById(sessionId);
    const relation = session?.relation;
    if (session === null || session === undefined || (relation !== "delegate" && relation !== "review" && relation !== "trial")) return setup;
    const base = setup ?? { developerInstructions: "", dynamicTools: [] };
    const adjusted =
      relation === "delegate"
        ? adjustThreadSetup(base, { role: delegateRole(session), dropTools: delegateDropsTool })
        : relation === "trial"
          ? adjustThreadSetup(base, { role: messagesFor(session.locale).trial.role([]), dropTools: trialDropsTool })
          : adjustThreadSetup(base, {
              role: reviewerRole(session),
              dropTools: reviewerDropsTool,
              ...(setup === null ? {} : { addTools: [reviewSubmitSpec(session.locale)] }),
            });
    return { developerInstructions: adjusted.developerInstructions ?? "", dynamicTools: adjusted.dynamicTools ?? [] };
  });
  const delegationService = new DelegationService({
    delegations: new DelegationRepository(database),
    sessions,
    threads,
    approvals,
    ledger,
    broker,
    messages: messageService,
    clientTurnId: stableClientTurnId,
    // Codex 把回合进行中再发的消息并入那一轮；Claude、ACP 排在会话内。
    mergesIntoRunningTurn: (sessionId) => sessions.getById(sessionId)?.agentId === "codex",
    interrupt: (sessionId, turnId) => interruptService.interrupt(sessionId, { turnId }),
    scheduler: {
      sessionRunning: (sessionId) => turnScheduler.sessionRunning(sessionId),
      cancel: (itemId) => turnScheduler.cancel(itemId),
      queuePosition: (sessionId) => turnScheduler.sessionPosition(sessionId),
      lend: (sessionId) => turnScheduler.lend(sessionId),
    },
    rounds: (sessionId) => sessionReader.rounds(sessionId),
    createChild: ({ parent, agentId, approvalMode, locale, task }) =>
      requirementsV2.createRelatedSession(parent, locale, { agentId, approvalMode }, "delegate", {
        title: oneLine(task, 60),
        role: delegateRole({ locale, parentSessionId: parent.id }),
        dropTools: delegateDropsTool,
      }),
    agentProblem: (agentId) => agentCatalog.delegationProblem(agentId),
    agentName: agentDisplayName,
  });
  // 重启前还在排队的消息：队列只在内存里，记为「重启没发出」；排队中的委派的那几条随后重新排队（开始监听之后再发）。
  delegationService.recoverAfterRestart(
    closeQueuedAfterRestart(events, ledger, (message) => message.source === "delegate" && delegationService.willRequeue(message.sessionId)),
  );
  // 交叉评审（多 Agent 协作 S9，需求 4.4）：评审会话与被评会话同一需求 / 项目、同一目录，固定只读。
  const reviewRepository = new ReviewRepository(database);
  const reviewService = new ReviewService({
    reviews: reviewRepository,
    sessions,
    threads,
    ledger,
    broker,
    messages: messageService,
    clientTurnId: stableClientTurnId,
    interrupt: (sessionId, turnId) => interruptService.interrupt(sessionId, { turnId }),
    scheduler: { cancel: (itemId) => turnScheduler.cancel(itemId) },
    rounds: (sessionId) => sessionReader.rounds(sessionId),
    createReviewer: ({ target, agentId, locale }) =>
      requirementsV2.createRelatedSession(target, locale, { agentId, approvalMode: "readonly" }, "review", {
        title: messagesFor(locale).review.title(target.title),
        role: reviewerRole({ locale, parentSessionId: target.id }),
        dropTools: reviewerDropsTool,
        addTools: [reviewSubmitSpec(locale)],
      }),
    agentProblem: (agentId) => agentCatalog.reviewProblem(agentId),
    agentName: agentDisplayName,
    requirementOf: (sessionId) => {
      const ref = requirementSessionRefs.getBySessionId(sessionId);
      if (ref === null) return null;
      return [ref.requirementNumber === null ? null : formatRequirementNumber(ref.requirementNumber), ref.requirementTitle].filter((part) => part !== null && part !== "").join(" ") || null;
    },
  });
  reviewService.recoverAfterRestart();
  // 并行试做（多 Agent 协作 S10，需求 4.5）：各版在 SuDuo 数据目录下的 git worktree 里，会话按 workspace_path 干活。
  const trialService = new TrialService({
    trials: new TrialRepository(database),
    worktrees: new WorktreeManager(),
    worktreeRoot: resolve(dirname(options.databasePath), "worktrees"),
    resolveTarget: (target) => requirementsV2.localProjectFor(target),
    localProject: (projectId) => projects.getById(projectId),
    createSession: ({ target, agentId, start, locale, workspacePath, title, role }) => {
      const graph = { parentSessionId: null, rootSessionId: null, relation: "trial" as const };
      const adjustSetup = (setup: SessionThreadSetup) => adjustThreadSetup(setup, { role, dropTools: trialDropsTool });
      const options = { agentId, ...start } as SessionStartOptions;
      return "remoteRequirementId" in target
        ? requirementsV2.createRequirementSession(target.remoteRequirementId, locale, options, graph, adjustSetup, title, workspacePath)
        : requirementsV2.createProjectSession(target.remoteProjectId, locale, options, { title, graph, adjustSetup, workspacePath });
    },
    messages: messageService,
    rounds: (sessionId) => sessionReader.rounds(sessionId),
    sessionActivity: (sessionId) =>
      turnScheduler.sessionRunning(sessionId) || events.listRunningTurnRefs(sessionId).length > 0 ? "running" : turnScheduler.sessionQueued(sessionId) ? "queued" : "idle",
    turnSpan: (sessionId) => events.turnSpan(sessionId),
    pendingApprovals: (sessionId) => approvals.countPendingBySession(sessionId),
    sessionsInWorkspace: (path) => sessions.listActiveIdsByWorkspacePath(path),
    archiveSession: async (sessionId) => {
      await sessionService.update(sessionId, null, { state: "archived" });
    },
    agentProblem: (agentId) => agentCatalog.delegationProblem(agentId),
    agentName: agentDisplayName,
    activity: (event) => aiActivity.report(event),
  });
  trialService.recoverAfterRestart();
  sessionTools.setReviewTools(new ReviewTools({ service: reviewService }));
  // 共享对象草稿与交接包（多 Agent 协作 S11，需求 4.7 / 4.13）：本机起草、编辑，本人确认后发布到需求。
  const sharedDraftService = new SharedDraftService({
    drafts: new SharedDraftRepository(database),
    sessions,
    requirementOf: (sessionId) => requirementSessionRefs.getBySessionId(sessionId)?.remoteRequirementId ?? null,
    sessionRoot: (sessionId) => {
      const session = sessions.getById(sessionId);
      return session === null ? null : (session.workspacePath ?? projects.getById(session.projectId)?.rootPath ?? null);
    },
    reviews: reviewRepository,
    rounds: (sessionId) => sessionReader.rounds(sessionId),
    remote: requirementsRemote,
    ledger,
    threads,
    activity: (event) => aiActivity.report(event),
  });
  sessionTools.setHandoffTools(new HandoffTools({ drafts: sharedDraftService, remote: requirementsRemote, agentName: agentDisplayName }));
  // 项目 AI 规范的新版本提示与一键应用（S11，需求 4.8）。
  const projectRulesService = new ProjectRulesService({
    sessions,
    remoteProjectOf: (sessionId) => requirementSessionRefs.getBySessionId(sessionId)?.remoteProjectId ?? projectSessionRefs.getBySessionId(sessionId)?.remoteProjectId ?? null,
    remote: requirementsRemote,
    messages: messageService,
  });
  sessionTools.setDelegationTools(
    new DelegationTools({
      service: delegationService,
      agents: () => agentCatalog.listNow().agents,
      usage: (agentId) => {
        const snapshot = turnScheduler.snapshot();
        return {
          running: snapshot.running.filter((item) => item.agentId === agentId).length,
          queued: snapshot.queued.filter((item) => item.agentId === agentId).length,
          limit: agentCatalog.concurrency(agentId),
        };
      },
    }),
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
    serverKey: () => currentServerOrigin(),
    kindProblem: (kind) => agentCatalog.roomAgentProblem(kind),
  });
  const presence = agentPresence;
  roomRunner = new RoomAgentRunner({
    remote: requirementsRemote,
    presence,
    agentProblem: (kind) => agentCatalog.roomAgentProblem(kind),
    hub: remoteEvents,
    mappings: workspaceMappings,
    projects,
    roomTasks,
    sessionRecords: sessions,
    sessions: sessionService,
    messages: messageService,
    interrupts: interruptService,
    cancelQueued: (sessionId) => cancelQueuedTurns?.(sessionId),
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
  const restore = (runtimeId?: string) =>
    restoreAttachedThreads({
      projects,
      sessions,
      threads,
      supervisor,
      workspaces,
      signal: consumerAbort.signal,
      ...(runtimeId === undefined ? {} : { runtimeId }),
      ...(options.onBackgroundError === undefined
        ? {}
        : { onError: options.onBackgroundError }),
    });
  // 每个已注册的运行时一条消费循环（多 Agent，ADR-0014）；断开与恢复按运行时隔离（ADR-0017）。
  const consumers = registry.list().map((registered) => consumeRuntimeUntilAborted({
    runtime: registered,
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
  }));
  // 启动时恢复线程要等本机服务开始监听：用 MCP 工具服务的线程续接时要注入它的地址（ADR-0015）。
  let restoration: Promise<void> = Promise.resolve();
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
    toolMcp: { tokens: toolTokens, host: sessionTools, serverVersion: process.env["npm_package_version"] ?? "0" },
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
    agents: agentCatalog,
    scheduler: schedulerService,
    delegations: delegationService,
    reviews: reviewService,
    trials: trialService,
    sharedDrafts: sharedDraftService,
    sessionAiRules: projectRulesService,
    aiActivity,
    aiCollabRemote: requirementsRemote,
    openTerminal: terminalOpener(),
    modelProvider: modelProviderService,
    mcp: mcpService,
    proxyConnectivity,
    requirementsV2,
    myWorkbench,
    rooms: {
      remote: requirementsRemote,
      agentState: () => presence.state(),
      // 共享到讨论的 Agent 固定只读（ADR-0009 / 需求 R6）：只收接上了、做得到只读的。
      // 只读红线（ADR-0009）由 AgentPresence 按配置表把关（kindProblem）。
      addAgentKind: (kind) => presence.addKind(kind),
      removeAgentKind: (kind) => presence.removeKind(kind),
    },
    remoteEvents,
    systemActivity: { runningSessions: () => events.countRunningSessionsAfter(startupSeq) },
    ...(options.runMode === undefined ? {} : { runMode: options.runMode }),
    ...(options.instanceId === undefined ? {} : { instanceId: options.instanceId }),
    localDirectories: new LocalDirectoryService({
      recentRoots: () => mappedWorkspaceRoots(currentServerMappings, projects),
      linkedRemoteProjectIds: (path) => linkedRemoteProjectIds(currentServerMappings, projects, path),
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
  httpServer = server;
  server.addHook("onListen", (done) => {
    restoration = restore();
    // 重启前排着的委派消息：等已挂线程续接完再发（MCP 通道的续接在监听之后才有地址）。
    void restoration
      .catch(() => undefined)
      .then(() => delegationService.requeueAfterRestart())
      .catch((error: unknown) => options.onBackgroundError?.(error));
    done();
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
      if (prewarm !== null) clearTimeout(prewarm);
      clearInterval(schedulerReconcile);
      releaseOnTurnEnd();
      claudeRuntime.close();
      for (const acpRuntime of acpRuntimes) acpRuntime.close();
      await Promise.allSettled([
        runtime.close(),
        ...consumers,
        restoration,
      ]);
      database.close();
    },
  };
}

/**
 * 交给 Codex 的环境：Codex 在使用者项目里执行的命令都继承它。本机服务自己的 SUDUO_*（端口、数据目录、运行形态、
 * pid 文件……）不能漏进去：否则在 Codex 会话里跑 `pnpm start` 或联调脚本，会探测到、甚至打开本机服务正在用的数据。
 * 只留命令行语言 SUDUO_LOCALE（客户端桌面应用 D0 独立审查第 1 条）。
 */
export function runtimeEnvironment(
  codexHome: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (!/^SUDUO_/i.test(entry[0]) || entry[0].toUpperCase() === "SUDUO_LOCALE"),
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
  workspaces: WorkspaceContextResolver;
  signal: AbortSignal;
  onError?: (error: unknown) => void;
  /** 只恢复这个运行时的线程；不传为全部（启动时）。 */
  runtimeId?: string;
}): Promise<void> {
  for (const binding of input.threads.listAttached()) {
    if (input.signal.aborted) {
      return;
    }
    if (input.runtimeId !== undefined && binding.threadRef.runtimeId !== input.runtimeId) {
      continue;
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
        workspace: input.workspaces.forSession(project, session.id),
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
