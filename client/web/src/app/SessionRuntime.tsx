import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SetStateAction,
} from "react";
import { BACKFILL_OMITTED_EVENT_TYPES } from "@suduo/client-contracts";
import type {
  GitCheckpointDto,
  ApprovalMode,
  ApprovalDto,
  EventEnvelope,
  FileEntryDto,
  JsonValue,
  ModelProviderSettingsDto,
  SessionContextDto,
  SessionDto,
  SessionRoomTaskDto,
  SkillDto,
  SystemOpenTarget,
} from "@suduo/client-contracts";
import {
  api,
  getInflightCount,
  subscribeInflight,
  type WorkspaceChange,
} from "../api/client.js";
import { projectEvents, type ConversationProjection } from "../event-projection/reducer.js";
import {
  loadEventCache,
  loadEventCacheStart,
  saveEventCache,
} from "../event-projection/cache.js";
import { formatClock, messageOf } from "../ui/format.js";
import { checkpointLabel } from "../ui/checkpoint-label.js";
import { afterLocaleRebuild, isLocaleRebuilding } from "../i18n/carry.js";
import { currentLocale, withLocaleParam } from "../i18n/locale.js";
import { messagesFor } from "../i18n/messages/index.js";
import { useCarried, useCarrySource, useLossCheck, useT } from "../i18n/provider.js";
import { ChevronRightIcon, FileIcon as FileLucideIcon, FolderIcon as FolderLucideIcon, LockIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Group as PanelGroup, Panel, Separator as PanelSeparator, useDefaultLayout } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SessionHeader } from "../features/sessions/SessionHeader.js";
import { useAttentionSignals } from "../features/sessions/attention.js";
import { ApprovalDock, type ApprovalDecisionInput } from "../features/sessions/ApprovalDock.js";
import { ConversationStream } from "../features/sessions/stream/ConversationStream.js";
import type { FileChangeEntry, TurnTimeline } from "../event-projection/timeline.js";
import { displayProjectPath, toProjectPath } from "../features/sessions/paths.js";
import { ApprovalModeSwitcher } from "../components/ApprovalModeSwitcher.js";
import { Composer } from "../components/Composer.js";
import {
  RequirementMaterials,
  requirementPageHref,
  type LinkedRequirement,
  type SessionContextState,
} from "../components/RequirementMaterials.js";
import { type SidePanelTab } from "../components/ChangesPanel.js";
import { Banner } from "@/components/ui/banner";
import { FileExistenceStore } from "../ui/file-existence.js";
import { MarkdownLinkContext, type MarkdownLinkHandlers } from "../ui/markdown-link-context.js";
import {
  INITIAL_TIMING,
  elapsedFor,
  lastTurnOutcomeOf,
  onLiveEvent,
  onStreamLive,
  onStreamReset,
  reconcileStopping,
  resolveStopIntent,
  stepText,
  type StoppingState,
  type TimingState,
} from "../session/run-state.js";
import { sessionUiStatus, type SessionLiveRunState } from "../ui/session-status.js";
import {
  beginDispatch,
  buildMessageContent,
  canDispatch,
  classifySendFailure,
  enqueue as enqueueItem,
  loadQueue,
  onSendAccepted,
  onSendRejected,
  onSendUncertain,
  pause as pauseQueue,
  reconcile as reconcileQueue,
  removeItem as removeQueueItem,
  resume as resumeQueue,
  saveQueue,
  takeItem as takeQueueItem,
  updateItem as updateQueueItem,
  type QueueState,
} from "../session/queue.js";
import { SessionModelSwitcher } from "../features/sessions/SessionModelSwitcher.js";
import { ChangesPanel } from "../components/ChangesPanel.js";
import { usePersistentState } from "../ui/use-persistent-state.js";
import { INSPECTOR_SIDE_BY_SIDE_QUERY, useMediaQuery } from "../ui/use-breakpoint.js";
import { Drawer, type DrawerState } from "../components/Drawer.js";
import { ConfirmDialog, RegionError } from "../feedback/components/index.js";
import { showMessage } from "../ui/message.js";
import { classifyFailure } from "../feedback/classify.js";
import { reportFailure } from "../feedback/report.js";
import { routeFeedback } from "../feedback/routes.js";
import type { FailureKind, FeedbackSurface } from "../feedback/types.js";

const EVENT_TYPES = [
  "thread.attached",
  "thread.started",
  "thread.status-changed",
  "message.submitted",
  "item.started",
  "item.completed",
  "file.patch-updated",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "turn.start-failed",
  "turn.interrupt-requested",
  "approval.requested",
  "approval.resolved",
  "approval.orphaned",
  "approval.delivery-failed",
  "workspace.changed",
  "runtime.warning",
  "runtime.error",
  "runtime.recovery-required",
  "runtime.unknown",
  // P3a：计划、推理摘要、上下文用量、工具进度（服务端 normalizer 映射，见技术设计 §10.1）。
  "plan.updated",
  "usage.updated",
  "thread.settings-updated",
  "model.rerouted",
  ...BACKFILL_OMITTED_EVENT_TYPES,
] as const;

const HISTORY_BACKFILL_PAGE_SIZE = 500;
const RECOVERY_BANNER_FRESH_MS = 30_000;

/** 回放边界：服务端回放结束切实时前发的传输控制帧；不入账本、不进缓存、不进 EVENT_TYPES。 */
const STREAM_LIVE_CONTROL = "stream.live";
/** 时长每秒刷新一次；只在有锚点的回合运行时才起 interval。 */
const ELAPSED_TICK_MS = 1_000;

interface RuntimeError {
  kind: FailureKind;
  message: string;
}

/**
 * 切换语言时整页按新语言重建（i18n/carry.ts），这些状态带过去，重建后接着用：
 * 排队的消息（含已发出、等结果的那一条，不暂停、不丢）、已收到的事件（接着从最后一条往后收，
 * 第一帧就和重建前一样，不会误以为没有回合在跑而提前出队）、会话与待审批（状态不经过「空闲」，
 * 后台标签页不会重复提醒「等你确认」）、选中的 skill、计时、停止中、检查面板标签、打开的文件或 diff。
 */
interface SessionRuntimeCarry {
  session: SessionDto | null;
  approvals: ApprovalDto[];
  queue: QueueState;
  events: EventEnvelope<string, JsonValue>[];
  skillPath: string;
  timing: TimingState;
  stopping: StoppingState | null;
  sideTab: SidePanelTab;
  /** 只带文件预览与 diff（内容是文件本身）；说明类的抽屉文字按旧语言生成，不带。 */
  drawer: DrawerState | null;
}

/**
 * 读回快照里的队列。正常情况下别的标签页切语言时会等出队与发送告一段落再切（见下面的 useLossCheck），
 * 这里是兜底，拿不准的一律停下等人（queue.ts「不确定就停」），绝不重发：
 * - 那一条已出队、发送结果没等到：按「结果不确定」放回待核对并暂停；
 * - 正要出队还没出：重建后不自动发，暂停等人继续（重建前那一份在重建期间不出队，见出队 effect）。
 */
function carriedQueue(carried: SessionRuntimeCarry): QueueState {
  const queue = carried.queue;
  if (queue.inflight !== null && queue.inflight.acceptedAt === null) return onSendUncertain(queue);
  if (canDispatch(queue, projectEvents(carried.events))) return pauseQueue(queue, "locale_switched");
  return queue;
}

/** 正在出队、发送请求还没回来，或马上就要出队：这时重建，结果可能落空或发两次。 */
function queueBusy(queue: QueueState, projection: ConversationProjection): boolean {
  return canDispatch(queue, projection) || (queue.inflight !== null && queue.inflight.acceptedAt === null);
}

/**
 * 供 Requirements V2 内嵌的纯会话画布。
 *
 * 它只接收已经创建好的本地项目和会话，不负责旧工作台的项目、需求或远程同步入口。
 */
export function SessionRuntime(props: {
  projectId: string;
  sessionId: string;
  /** PR4 实时通道：把本会话的运行态回传给外壳，侧栏选中行据此不等 10s 轮询。 */
  onRunStateChange?(state: SessionLiveRunState): void;
  /** 外壳（会话列表）知道的关联需求；缺时会话头与「需求」标签用会话上下文接口兜底。 */
  linkedRequirement?: LinkedRequirement | null;
  /** 会话列表里的标题：在列表里重命名后，会话头跟着变。 */
  listTitle?: string;
  /** 房间任务会话对应的房间话题（外壳的会话列表知道时给出）：只读说明里「在讨论里查看」的入口用。 */
  roomTask?: SessionRoomTaskDto | null;
  /** 会话本身改了（改名、审批档、模型）：通知列表刷新。 */
  onSessionChanged?(session: SessionDto): void;
}) {
  const t = useT();
  const text = t.conversation.runtime;
  const carryKey = `session-runtime:${props.sessionId}`;
  const carried = useCarried<SessionRuntimeCarry>(carryKey);
  /** 读回快照时的会话：只有同一个会话才沿用快照，不在挂载时清掉（见下面加载会话的 effect）。 */
  const carriedSessionId = useRef(carried === undefined ? null : props.sessionId);
  const [session, setSession] = useState<SessionDto | null>(carried?.session ?? null);
  const [events, setEvents] = useState<EventEnvelope<string, JsonValue>[]>(() => carried?.events ?? []);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalDto[]>(carried?.approvals ?? []);
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [skillPath, setSkillPath] = useState(carried?.skillPath ?? "");
  const [files, setFiles] = useState<Record<string, FileEntryDto[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [changes, setChanges] = useState<WorkspaceChange[]>([]);
  const [changeStats, setChangeStats] = useState({ additions: 0, deletions: 0 });
  const [drawer, setDrawer] = useState<DrawerState | null>(() =>
    carried?.drawer?.mode === "preview" || carried?.drawer?.mode === "diff" ? carried.drawer : null,
  );
  /** 检查面板开合偏好持久化；宽于 1280px 与对话并排、可拖宽度，更窄时浮在对话上方（需求 §4.5）。 */
  const [sideOpen, setSideOpen] = usePersistentState("suduo.session.sideOpen", true);
  const sideBySide = useMediaQuery(INSPECTOR_SIDE_BY_SIDE_QUERY);
  const drawerOpen = drawer !== null;
  const toggleInspector = useCallback(() => {
    // 文件查看器开着时，开关的意思是「收起」。
    if (drawerOpen) {
      setDrawer(null);
      setSideOpen(false);
      return;
    }
    setSideOpen((current) => !current);
  }, [drawerOpen, setSideOpen]);
  // ⌘J 开合检查面板（输入框里也可用：它不是文本编辑快捷键）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "j" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      toggleInspector();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleInspector]);
  const [projectRoot, setProjectRoot] = useState("");
  const [openTargets, setOpenTargets] = useState<SystemOpenTarget[]>([
    "open",
    "reveal",
  ]);
  const [modelProvider, setModelProvider] =
    useState<ModelProviderSettingsDto | null>(null);
  /**
   * pr8：会话内不再内嵌一份设置面板。
   *
   * 设置有了独立页面（pr9／pr10 重建六组），会话内再放一份就会出现两套真相。
   * 这里改为跳设置页，保持单一入口。
   */
  /** 审批档部署上限（pr6 契约字段）；仅用于会话头置灰与说明，强制在服务端。 */
  const [approvalLock, setApprovalLock] = useState<{
    locked: boolean;
    max?: ApprovalMode;
  }>({ locked: false });

  useEffect(() => {
    void (async () => {
      try {
        const settings = await api.getSettings();
        setApprovalLock({
          locked: settings.approvalModeLocked,
          ...(settings.maxApprovalMode === undefined
            ? {}
            : { max: settings.maxApprovalMode }),
        });
      } catch {
        // 拉不到就按未锁定处理：服务端仍会 clamp，UI 不因此误锁死用户。
      }
    })();
  }, []);

  const openSettingsPage = useCallback(() => navigateInApp("/settings/model"), []);
  const [error, setError] = useState<RuntimeError | null>(null);
  /**
   * PR1：原来的 `busy` 被发送 / 上传 / 预览 / diff / 审批五件互不相干的事共用，
   * 而它又直接禁掉 textarea——一处忙碌整个对话栏变灰。这里收窄成「抽屉内容
   * 正在取」这一件事，且只作用于右侧抽屉区域，不再向输入框传播。
   */
  const [drawerLoading, setDrawerLoading] = useState(false);
  /** 会话关联的 SuDuo 上下文（需求 / 项目、新版或旧版需求会话）：「需求」标签与旧版提示用。 */
  const [context, setContext] = useState<SessionContextState>({ status: "loading" });
  const [contextAttempt, setContextAttempt] = useState(0);
  /**
   * PR3 运行态：计时锚点只认 stream.live 之后实时到达的 turn.started；停止是本地中间态，
   * 收到目标回合任一终态才收口。两者都是本页内存态，随 key=sessionId 重挂自然清空。
   */
  // 事件流会重连并重新回放：回放边界作废，已建的锚点保留（同 onStreamReset）。
  const [timing, setTiming] = useState(() => (carried === undefined ? INITIAL_TIMING : onStreamReset(carried.timing)));
  const [stopping, setStopping] = useState<StoppingState | null>(carried?.stopping ?? null);
  const [stopMismatch, setStopMismatch] = useState<{ endedTurnId: string; runningTurnId: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /**
   * PR5 队列：宿主在这里（key=sessionId 重挂即卸载），按 sessionId 从 sessionStorage 重建——
   * 切回必为 paused、不清空。出队单飞：beginDispatch 置 inflight 挡住重入，请求在 effect 体内发。
   */
  const [queue, setQueueState] = useState(() => (carried === undefined ? loadQueue(props.sessionId) : carriedQueue(carried)));
  /**
   * 队列的最新值，含已经排上、还没提交渲染的更新（出队、发送结果）。语言切换拍快照、判断要不要等，
   * 都看它而不是上一次渲染的值。队列的更新一律经 setQueue（算出新值记下再交给 React，次序与原来相同）。
   */
  const queueLatest = useRef(queue);
  const setQueue = useCallback((update: SetStateAction<QueueState>) => {
    queueLatest.current = typeof update === "function" ? update(queueLatest.current) : update;
    setQueueState(queueLatest.current);
  }, []);
  const dispatchingRef = useRef(false);
  /** 在途的停止请求数：请求失败时要解除「停止中」，重建会让这个回调落空。 */
  const interruptingRef = useRef(0);
  /** 重建期间暂不出队、等重建结束再看一次（见出队 effect）。 */
  const [dispatchRetry, setDispatchRetry] = useState(0);
  const requestsActive =
    useSyncExternalStore(subscribeInflight, getInflightCount) > 0;

  const setPersistentError = useCallback((message: string, kind: FailureKind = "runtime_failed") => {
    setError({ kind, message });
  }, []);

  const reportError = useCallback((cause: unknown, surface: FeedbackSurface) => {
    const failure = classifyFailure(cause);
    const route = routeFeedback(failure, { surface });
    if (route.outlet === "silent") return;
    if (route.outlet === "region") {
      setPersistentError(failure.message, failure.kind);
      return;
    }
    reportFailure(cause, { surface });
  }, [setPersistentError]);

  const projection = useMemo(() => projectEvents(events), [events]);
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  // 出队与发送正告一段落之前、停止请求还没回来时，重建会让结果落空或发两次：别的标签页切语言时等这些过去再切。
  useLossCheck(
    () => dispatchingRef.current || interruptingRef.current > 0 || queueBusy(queueLatest.current, projectionRef.current),
  );
  const running = projection.runningTurnIds.length;
  const contextRequirement = context.status === "ready" ? context.value.requirement : null;
  // 会话头的需求入口：优先用外壳给的（标题随列表更新），没有时用会话上下文兜底。
  const linkedRequirement: LinkedRequirement | null =
    props.linkedRequirement ??
    (contextRequirement === null
      ? null
      : { id: contextRequirement.remoteRequirementId, number: contextRequirement.number, title: contextRequirement.title });
  const [sideTab, setSideTab] = useState<SidePanelTab>(carried?.sideTab ?? "changes");
  useCarrySource(
    carryKey,
    (): SessionRuntimeCarry => ({ session, approvals, queue: queueLatest.current, events, skillPath, timing, stopping, sideTab, drawer }),
  );
  const lastTurnOutcome = lastTurnOutcomeOf(projection);
  const pendingApprovals = approvals.length;
  // 顶栏徽章与状态行走同一个判定（技术设计 §四.5：删掉本地那份不看 lastTurnOutcome 的实现）。
  const headStatus = session
    ? sessionUiStatus(session, running, pendingApprovals, { lastTurnOutcome })
    : "idle";
  useAttentionSignals(headStatus, session?.title ?? null);
  const activeTurnId = projection.runningTurnIds.at(-1) ?? null;
  const activeMeta = activeTurnId === null ? undefined : projection.turnMeta.get(activeTurnId);
  const elapsedMs = elapsedFor(timing, activeTurnId, now);
  const { onRunStateChange } = props;
  useEffect(() => {
    onRunStateChange?.({ sessionId: props.sessionId, running, pendingApprovals, lastTurnOutcome });
  }, [onRunStateChange, props.sessionId, running, pendingApprovals, lastTurnOutcome]);

  useEffect(() => {
    setStopping((current) => reconcileStopping(current, projection));
  }, [projection]);

  const queueInflight = queue.inflight !== null;
  useEffect(() => {
    // 时长要每秒走字（消息流里步骤计时也用它）；队列在途项要按秒核对归属期限。两者都没有时不起 interval。
    if (activeTurnId === null && !queueInflight) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [activeTurnId, timing, queueInflight]);

  useEffect(() => {
    saveQueue(props.sessionId, queue);
  }, [props.sessionId, queue]);

  useEffect(() => {
    setQueue((current) => reconcileQueue(current, projection, Date.now()));
  }, [projection, now]);

  const sendQueued = useCallback(async (item: { text: string; skill?: { name: string; path: string }; attachmentIds: string[] }) => {
    // skill 连 name 一起存在队列项里：出队不依赖 skills 列表是否已加载，内容与入队时等价。
    const content = buildMessageContent({ text: item.text, skill: item.skill, attachmentIds: item.attachmentIds });
    if (content.length === 0) {
      // 不该发生（入队时已校验非空）；真发生了也不发空消息，放回队首等人看。
      setQueue((current) => onSendRejected(current));
      dispatchingRef.current = false;
      return;
    }
    try {
      const accepted = await api.sendMessage(props.sessionId, { content });
      // 立刻用当前投影对账：SSE 先于 HTTP 响应时，归属可能已经在投影里了。
      setQueue((current) => reconcileQueue(onSendAccepted(current, accepted.clientTurnId, Date.now()), projectionRef.current, Date.now()));
    } catch (cause) {
      setQueue((current) => (classifySendFailure(cause) === "rejected" ? onSendRejected(current) : onSendUncertain(current)));
      reportError(cause, "action");
    } finally {
      dispatchingRef.current = false;
    }
  }, [props.sessionId, reportError]);

  const shouldDispatch = canDispatch(queue, projection);
  useEffect(() => {
    if (!shouldDispatch || dispatchingRef.current) {
      return;
    }
    // 正在按新语言重建：这一份马上要被换掉，不在这时出队，免得新旧两份各发一次（新的那份读回快照时已暂停，
    // 见 carriedQueue）。万一没换掉（语言来回切、最后没变），重建结束后再看一次。
    if (isLocaleRebuilding()) {
      return afterLocaleRebuild(() => setDispatchRetry((count) => count + 1));
    }
    const next = beginDispatch(queue, projection.lastSeq);
    if (next.inflight === null) {
      return;
    }
    dispatchingRef.current = true;
    setQueue(next);
    void sendQueued(next.inflight.item);
    // 依赖只认「可以出队」这个布尔：queue / projection 的其它变化不该重跑出队（dispatchRetry 只在上面重建期间等过时才变）。
  }, [shouldDispatch, dispatchRetry]);

  const stopTurn = useCallback((targetTurnId: string) => {
    const intent = resolveStopIntent(targetTurnId, projectionRef.current);
    if (intent.kind === "noop") {
      return;
    }
    if (intent.kind === "mismatch") {
      // 用户的意图是「停」：队列同样在这一刻暂停，等人决定。
      setQueue((current) => pauseQueue(current, "user_stop"));
      setStopMismatch({ endedTurnId: intent.endedTurnId, runningTurnId: intent.runningTurnId });
      return;
    }
    setStopMismatch(null);
    // 本地反馈按既有契约 FEEDBACK_TIMING_MS.actionBusy（0ms）：同步置位、控件禁用，不等远程返回。
    setStopping({ turnId: intent.turnId });
    // 队列从点击这一刻起暂停（不等完成事件），避免终态先到而自动发下一条。
    setQueue((current) => pauseQueue(current, "user_stop"));
    interruptingRef.current += 1;
    void api
      .interrupt(props.sessionId, { turnId: intent.turnId })
      .catch((cause: unknown) => {
        // 请求本身失败：解除中间态并如实报错，绝不无限等终态。目标已非活跃（F5/F6）服务端按幂等返回，不会走到这里。
        setStopping((current) => (current?.turnId === intent.turnId ? null : current));
        reportError(cause, "action");
      })
      .finally(() => {
        interruptingRef.current -= 1;
      });
  }, [props.sessionId, reportError]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // 语言切换重建后，同一个会话的这几项刚从快照读回，不清（会话照样重取，拿到后替换）。
    if (carriedSessionId.current !== props.sessionId) {
      setDrawer(null);
      setSession(null);
      setSkillPath("");
      setTiming(INITIAL_TIMING);
      setStopping(null);
    }
    setStopMismatch(null);

    void api
      .getSession(props.sessionId)
      .then((value) => {
        if (!cancelled) {
          setSession(value);
        }
      })
      .catch((cause) => reportError(cause, "region"));
    void api
      .listProjects()
      .then((response) => {
        if (!cancelled) {
          setProjectRoot(
            response.items.find((item) => item.id === props.projectId)?.rootPath ?? "",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectRoot("");
        }
      });
    void api
      .listSkills(props.projectId)
      .then((response) => {
        if (!cancelled) {
          setSkills(response.items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([]);
        }
      });
    void api
      .openTargets()
      .then((response) => {
        if (!cancelled) {
          setOpenTargets(response.targets);
        }
      })
      .catch(() => undefined);
    void api
      .modelProvider()
      .then((response) => {
        if (!cancelled) {
          setModelProvider(response);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelProvider(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.sessionId, reportError]);

  // 会话上下文：查不到时如实显示原因并可重试，不当成「没有关联需求」（需求 R2）。
  useEffect(() => {
    let cancelled = false;
    setContext((current) => (current.status === "ready" && current.value.sessionId === props.sessionId ? current : { status: "loading" }));
    void api
      .getSessionContext(props.sessionId)
      .then((value) => {
        if (!cancelled) setContext({ status: "ready", value });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setContext({ status: "error", message: classifyFailure(cause).message });
      });
    return () => {
      cancelled = true;
    };
  }, [props.sessionId, contextAttempt]);
  const retryContext = useCallback(() => setContextAttempt((attempt) => attempt + 1), []);


  useEffect(() => {
    let cancelled = false;
    const refreshFiles = () => {
      void api
        .listFiles(props.projectId)
        .then((response) => {
          if (!cancelled) {
            setFiles((current) => ({ ...current, "": response.entries }));
          }
        })
        .catch(() => undefined);
    };
    refreshFiles();

    // EventSource 带不了请求头：界面语言放在地址上（语言切换后整页重建，按新语言重连）。
    const watcher = new EventSource(
      withLocaleParam(`/api/v1/projects/${encodeURIComponent(props.projectId)}/files/watch`),
    );
    const refresh = () => {
      refreshFiles();
      void refreshChanges(props.sessionId, setChanges, setChangeStats).catch(
        () => undefined,
      );
    };
    watcher.addEventListener("workspace.changed", refresh);
    return () => {
      cancelled = true;
      watcher.close();
    };
  }, [props.projectId, props.sessionId]);

  useEffect(() => {
    if (carriedSessionId.current !== props.sessionId) setApprovals([]);
    setChanges([]);
    setEvents([]);
    // 语言切换重建：从重建前收到的事件接着来（本地缓存晚 300ms 才写，可能缺最后几条）。
    const cached =
      carriedSessionId.current === props.sessionId && carried !== undefined && carried.events.length > 0
        ? carried.events
        : loadEventCache(props.sessionId);
    const cachedStart = cached.at(0)?.seq ?? loadEventCacheStart(props.sessionId) ?? 0;
    setEvents(cached);
    setHistoryLoading(cachedStart > 1);
    void refreshApprovals(props.sessionId, setApprovals).catch(() => undefined);
    void refreshChanges(props.sessionId, setChanges, setChangeStats).catch(
      () => undefined,
    );

    let source: EventSource | null = null;
    let cancelled = false;
    const accept = (raw: Event) => {
      let event: EventEnvelope<string, JsonValue>;
      try {
        event = JSON.parse(
          (raw as MessageEvent<string>).data,
        ) as EventEnvelope<string, JsonValue>;
      } catch {
        return;
      }
      setEvents((current) => mergeSessionEvents(current, [event]));
      // 只有经这条实时入口、且已过回放边界收到的 turn.started 才建本地计时锚点。
      setTiming((current) => onLiveEvent(current, event, Date.now()));
      if (event.type.startsWith("approval.")) {
        void refreshApprovals(props.sessionId, setApprovals);
      }
      if (
        event.type === "runtime.recovery-required" &&
        Date.now() - event.ts < RECOVERY_BANNER_FRESH_MS
      ) {
        setPersistentError(messagesFor(currentLocale()).conversation.runtime.recovered);
      }
      if (
        event.type === "file.patch-updated" ||
        event.type === "workspace.changed"
      ) {
        void refreshChanges(props.sessionId, setChanges, setChangeStats);
      }
    };

    const openStream = async () => {
      const cachedTail = cached.at(-1)?.seq ?? 0;
      let streamAfter = cachedTail;
      if (cachedStart > 1) {
        setHistoryLoading(true);
        try {
          const until = cachedStart - 1;
          let after = 0;
          while (!cancelled && after < until) {
            const page = await api.backfillSessionEvents(props.sessionId, {
              after,
              until,
              limit: HISTORY_BACKFILL_PAGE_SIZE,
            });
            if (cancelled || page.length === 0) {
              break;
            }
            setEvents((current) => mergeSessionEvents(current, page));
            after = page.at(-1)?.seq ?? until;
          }
        } catch {
          streamAfter = 0;
        } finally {
          if (!cancelled) {
            setHistoryLoading(false);
          }
        }
      }
      if (cancelled) {
        return;
      }
      source = new EventSource(
        withLocaleParam(`/api/v1/sessions/${encodeURIComponent(props.sessionId)}/events?after=${String(streamAfter)}`),
      );
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, accept);
      }
      // 回放边界控制帧：不合并进事件、不进缓存；之后实时到达的 turn.started 才计时。
      source.addEventListener(STREAM_LIVE_CONTROL, () => setTiming(onStreamLive));
      // 连接出错后浏览器会自动重连并从头回放：边界作废，等下一个 stream.live。
      source.onerror = () => setTiming(onStreamReset);
    };
    void openStream();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [props.sessionId]);

  useEffect(() => {
    if (events.length === 0) {
      return;
    }
    const timer = window.setTimeout(
      () => saveEventCache(props.sessionId, events),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [events, props.sessionId]);

  const toggleDirectory = async (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
      setExpanded(next);
      return;
    }
    next.add(path);
    setExpanded(next);
    if (!files[path]) {
      try {
        const response = await api.listFiles(props.projectId, path);
        setFiles((current) => ({ ...current, [path]: response.entries }));
      } catch (cause) {
        reportError(cause, "region");
      }
    }
  };

  const openPreview = async (path: string, line: number | null = null) => {
    setDrawerLoading(true);
    try {
      setDrawer({
        mode: "preview",
        content: await api.readFile(props.projectId, path),
        line,
      });
    } catch (cause) {
      setDrawer({ mode: "fallback", path, message: messageOf(cause) });
    } finally {
      setDrawerLoading(false);
    }
  };

  const openDiff = async (path: string) => {
    setDrawerLoading(true);
    try {
      setDrawer({
        mode: "diff",
        diff: await api.diff(props.sessionId, path),
      });
    } catch (cause) {
        reportError(cause, "region");
    } finally {
      setDrawerLoading(false);
    }
  };

  const systemOpen = (path: string, mode: SystemOpenTarget) => {
    void api.openFile(props.projectId, path, mode).catch((cause) => reportError(cause, "action"));
  };

  const decideApproval = async (
    approval: ApprovalDto,
    decision: ApprovalDecisionInput,
  ) => {
    try {
      // 审批记录由事件（approval.resolved）进时间线，这里只刷新待处理列表。
      await api.decideApproval(approval.id, decision);
      await refreshApprovals(props.sessionId, setApprovals);
    } catch (cause) {
      reportError(cause, "action");
    }
  };

  /**
   * 「回到开始前」：取这一轮开始时最近的检查点（回合前自动存档通常就在开始前一刻）。
   * 不是这一轮的自动存档时照实说明它是哪一个、什么时候的，由人决定（ADR-0004：告知而不是拦）。
   */
  const [restoreTarget, setRestoreTarget] = useState<{ checkpoint: GitCheckpointDto; ownAuto: boolean } | null>(null);
  const restoreBefore = async (turn: TurnTimeline) => {
    try {
      const { items } = await api.gitCheckpoints(props.projectId);
      const candidate = items
        .filter((checkpoint) => checkpoint.ts <= turn.startedTs + 2_000)
        .sort((left, right) => right.ts - left.ts)[0];
      if (candidate === undefined) {
        setPersistentError(text.noCheckpoint, "stale_state");
        return;
      }
      const ownAuto = candidate.auto && turn.startedTs - candidate.ts <= 120_000;
      setRestoreTarget({ checkpoint: candidate, ownAuto });
    } catch (cause) {
      reportError(cause, "action");
    }
  };
  const confirmRestore = async () => {
    const target = restoreTarget;
    setRestoreTarget(null);
    if (target === null) return;
    try {
      await api.gitRestore(props.projectId, target.checkpoint.hash);
      await refreshChanges(props.sessionId, setChanges, setChangeStats);
      showMessage(text.restored, "success");
    } catch (cause) {
      reportError(cause, "action");
    }
  };

  /** Codex 报回的是绝对路径：换成项目内相对路径再查改动；不在项目里的说清楚。 */
  const openChange = (path: string) => {
    const relative = toProjectPath(path, projectRoot);
    if (relative === null) {
      setPersistentError(text.outsideProject(path), "stale_state");
      return;
    }
    void openDiff(relative);
  };
  const displayPath = (path: string) => displayProjectPath(path, projectRoot);
  /**
   * 回答里的项目文件链接（需求 4.6；会话回答里的文件路径可点击）：单击在右侧文件面板打开并定位到行；
   * ⌘ / Ctrl 单击用本机编辑器打开（有 VS Code 时跳到行，没有就用系统默认应用）。
   * 行内代码与正文里的路径先经本机确认文件存在再变成链接，确认结果按项目缓存。
   */
  const openPreviewRef = useRef(openPreview);
  openPreviewRef.current = openPreview;
  const openTargetsRef = useRef(openTargets);
  openTargetsRef.current = openTargets;
  const fileExistence = useMemo(
    () => new FileExistenceStore(async (paths) => (await api.existingFiles(props.projectId, paths)).files),
    [props.projectId],
  );
  const markdownLinks = useMemo<MarkdownLinkHandlers>(
    () => ({
      projectRoot,
      files: fileExistence,
      onOpenPath: (path, line, options) => {
        if (options?.external === true) {
          const mode = openTargetsRef.current.includes("vscode") ? "vscode" : "open";
          void api.openFile(props.projectId, path, mode, line).catch((cause: unknown) => reportError(cause, "action"));
          return;
        }
        void openPreviewRef.current(path, line);
      },
    }),
    [projectRoot, fileExistence, props.projectId],
  );
  /** 文件改动审批要改的文件：v2 审批只带 itemId，从时间线里同一 item 的改动卡取。 */
  const changesForApproval = (approval: ApprovalDto): FileChangeEntry[] => {
    const payload = approval.request;
    const request =
      payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload["request"] : null;
    const itemId =
      request !== null && request !== undefined && typeof request === "object" && !Array.isArray(request) ? request["itemId"] : null;
    if (typeof itemId !== "string") return [];
    for (const entry of projection.timeline) {
      if (entry.kind !== "turn") continue;
      for (const block of entry.turn.blocks) {
        if (block.kind === "file-change" && block.id === `files:${itemId}`) return block.changes;
      }
    }
    return [];
  };

  /** 失败回合的「重试」：把开启这一轮的那句话重新排进队列并恢复队列（失败时队列会暂停）。 */
  const retryTurn = (turn: TurnTimeline) => {
    const message = projection.messages.find(
      (candidate) => candidate.role === "user" && candidate.turnId !== null && candidate.turnId === turn.turnId && candidate.attribution !== "merged",
    );
    if (message === undefined || message.text.trim() === "") {
      setPersistentError(text.retryMissing, "stale_state");
      return;
    }
    const skillName = message.skills[0];
    const skill = skillName === undefined ? undefined : skills.find((candidate) => candidate.name === skillName);
    setQueue((current) =>
      resumeQueue(
        enqueueItem(current, {
          id: crypto.randomUUID(),
          text: message.text,
          ...(skill === undefined ? {} : { skill: { name: skill.name, path: skill.path } }),
          attachmentIds: message.attachments,
        }),
      ),
    );
  };

  const renameSession = async (title: string) => {
    if (!session || !title || title === session.title) {
      return;
    }
    try {
      const saved = await api.updateSession(session.id, { title });
      setSession(saved);
      props.onSessionChanged?.(saved);
    } catch (cause) {
      reportError(cause, "action");
    }
  };

  // 在会话列表里改了名：会话头跟着变（只在列表标题变化时同步，不会把刚在头部改的名改回去）。
  const listTitle = props.listTitle;
  useEffect(() => {
    if (listTitle === undefined) return;
    setSession((current) => (current === null || current.title === listTitle ? current : { ...current, title: listTitle }));
  }, [listTitle]);

  const inspectorContent =
    drawer === null && drawerLoading ? (
      <div className="flex items-center gap-2 p-4 text-small text-subtle-foreground" data-testid="drawer-loading" aria-busy="true" role="status">
        <Spinner size="sm" />
        {text.opening}
      </div>
    ) : drawer !== null ? (
      <Drawer
        state={drawer}
        projectId={props.projectId}
        targets={openTargets}
        onClose={() => setDrawer(null)}
        onSystemOpen={systemOpen}
      />
    ) : session ? (
      <ChangesPanel
        tab={sideTab}
        onTabChange={setSideTab}
        requirementPanel={
          <RequirementMaterials
            context={context}
            onRetryContext={retryContext}
            onNavigate={navigateInApp}
          />
        }
        fileTree={
          <RuntimeFileTree
            entries={files[""] ?? []}
            files={files}
            expanded={expanded}
            onToggleDirectory={(path) => void toggleDirectory(path)}
            onPreview={(path) => void openPreview(path)}
          />
        }
        changes={changes}
        additions={changeStats.additions}
        deletions={changeStats.deletions}
        projectId={props.projectId}
        projectRoot={projectRoot}
        running={running > 0}
        openTargets={openTargets}
        onOpen={(path) => void openDiff(path)}
        onCollapse={() => setSideOpen(false)}
        onSystemOpen={systemOpen}
        onError={setPersistentError}
      />
    ) : null;
  const inspectorVisible = drawer !== null || drawerLoading || (sideOpen && session !== null);
  // 并排时记住对话 / 检查面板的宽度（按实际渲染的面板组合分别记）。
  const layout = useDefaultLayout({
    id: "suduo.session.layout",
    panelIds: inspectorVisible && sideBySide ? ["conversation", "inspector"] : ["conversation"],
    storage: safeLocalStorage,
  });
  // 运行时自带的提示（多为模型配置类）收进会话头的提示图标，不进对话流（需求 §4.5）。
  const infoNotices = projection.notices.filter((notice) => notice.level === "info");
  const streamTimeline = useMemo(
    () => projection.timeline.filter((entry) => entry.kind !== "notice" || entry.notice.level !== "info"),
    [projection.timeline],
  );
  const lastUserText = [...projection.messages].reverse().find((message) => message.role === "user")?.text ?? null;
  // 房间任务会话（ADR-0009）：由房间里的 @ 触发、回答发回房间，会话页只读（只是不给输入入口，服务端不拒绝）。
  const roomTaskSession = session?.kind === "room_task";

  return (
    <>
      {requestsActive ? (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden" aria-hidden="true">
          <div className="h-full w-1/3 animate-progress bg-primary motion-reduce:animate-none" />
        </div>
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="session-runtime">
        {session ? (
          <SessionHeader
            session={session}
            status={headStatus}
            requirement={linkedRequirement === null ? null : { title: linkedRequirement.title }}
            projectRoot={projectRoot}
            notices={infoNotices}
            inspectorOpen={inspectorVisible}
            onRename={(title) => void renameSession(title)}
            onOpenRequirement={() => {
              setDrawer(null);
              setSideOpen(true);
              setSideTab("requirement");
            }}
            onToggleInspector={toggleInspector}
          />
        ) : null}
        <PanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
          <Panel id="conversation" minSize={420}>
            <section className="flex h-full min-w-0 flex-col" aria-label={text.conversationLabel}>
              {/* 回答里的项目文件链接点开在右侧文件面板（需求 4.6）。 */}
              <MarkdownLinkContext.Provider value={markdownLinks}>
                <ConversationStream
                  key={props.sessionId}
                  timeline={streamTimeline}
                  historyLoading={historyLoading}
                  now={now}
                  actions={{
                    onOpenChange: openChange,
                    displayPath,
                    onViewChanges: () => {
                      setDrawer(null);
                      setSideOpen(true);
                      setSideTab("changes");
                    },
                    // 房间任务会话只读：在这里重试等于私下追问，回答回不到房间；重试在房间消息上做。
                    ...(roomTaskSession ? {} : { onRetry: retryTurn }),
                    // ADR-0004 红线：还原会覆盖 Codex 正在写的文件，有回合在跑时不提供（与环境页的还原一致）。
                    ...(running > 0 ? {} : { onRestoreBefore: (turn: TurnTimeline) => void restoreBefore(turn) }),
                  }}
                  empty={<EmptyConversation />}
                />
              </MarkdownLinkContext.Provider>
              <ConfirmDialog
                open={restoreTarget !== null}
                onOpenChange={(open) => !open && setRestoreTarget(null)}
                title={text.restore.title}
                description={
                  restoreTarget === null
                    ? ""
                    : text.restore.description(
                        restoreTarget.ownAuto
                          ? text.restore.ownAuto(formatClock(restoreTarget.checkpoint.ts))
                          : text.restore.nearest(checkpointLabel(restoreTarget.checkpoint, t), formatClock(restoreTarget.checkpoint.ts)),
                      )
                }
                confirmLabel={text.restore.confirm}
                onConfirm={() => void confirmRestore()}
              />
              <div className="shrink-0 px-6 pb-4">
                <ApprovalDock
                  approvals={approvals}
                  onDecide={decideApproval}
                  changesFor={changesForApproval}
                  displayPath={displayPath}
                  onViewPatch={(change) => {
                    setDrawer({ mode: "patch", path: displayPath(change.path), diff: change.diff, label: text.pendingPatch });
                    setSideOpen(true);
                  }}
                />
                {stopMismatch !== null && (
                  <div
                    className="mx-auto mb-2 flex w-full max-w-[760px] items-center gap-2 rounded-md bg-muted px-3 py-2 text-small text-foreground"
                    data-testid="stop-mismatch-notice"
                    role="status"
                  >
                    <span className="flex-1">{text.stopMismatch.text}</span>
                    {projection.runningTurnIds.includes(stopMismatch.runningTurnId) && (
                      <Button size="sm" variant="danger-ghost" data-testid="stop-current-turn" onClick={() => stopTurn(stopMismatch.runningTurnId)}>
                        {text.stopMismatch.stopCurrent}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setStopMismatch(null)}>{text.stopMismatch.dismiss}</Button>
                  </div>
                )}
                {context.status === "ready" && context.value.contextMode === "legacy" ? (
                  <LegacySessionBanner context={context.value} onNavigate={navigateInApp} />
                ) : null}
                {error && (
                  <div className="mx-auto mb-2 flex w-full max-w-[760px] items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <RegionError kind={error.kind} message={error.message} />
                    </div>
                    <Button size="icon-sm" variant="ghost" aria-label={text.dismissError} onClick={() => setError(null)}>
                      <XIcon />
                    </Button>
                  </div>
                )}
                {roomTaskSession ? (
                  <RoomTaskReadonlyNotice roomTask={props.roomTask ?? null} onNavigate={navigateInApp} />
                ) : (
                  <Composer
                    disabled={!session}
                    projectId={props.projectId}
                    projectRoot={projectRoot}
                    sessionId={props.sessionId}
                    skills={skills}
                    skillPath={skillPath}
                    usage={projection.usage}
                    lastUserText={lastUserText}
                    runState={{
                      status: headStatus,
                      stepText: stepText(activeMeta?.currentStep ?? null, t),
                      elapsedMs,
                      pendingApprovals: approvals.length,
                      stopping: stopping !== null && activeTurnId === stopping.turnId,
                      onStop: () => {
                        if (activeTurnId !== null) stopTurn(activeTurnId);
                      },
                      onJumpToApproval: () => {
                        document.querySelector('[data-testid="approval-card"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
                      },
                    }}
                    queue={{
                      items: queue.items,
                      status: queue.status,
                      pausedReason: queue.pausedReason,
                      onEnqueue: (draft) =>
                        setQueue((current) =>
                          enqueueItem(current, {
                            id: crypto.randomUUID(),
                            text: draft.text,
                            ...(draft.skill === undefined ? {} : { skill: draft.skill }),
                            attachmentIds: draft.attachmentIds,
                          })),
                      onRemove: (id) => setQueue((current) => removeQueueItem(current, id)),
                      onUpdate: (id, text) => setQueue((current) => updateQueueItem(current, id, text)),
                      onTake: (id) => {
                        const taken = takeQueueItem(queue, id);
                        if (taken.item !== null) {
                          setQueue(taken.state);
                        }
                        return taken.item;
                      },
                      onResume: () => setQueue((current) => resumeQueue(current)),
                    }}
                    settingsSlot={
                      session ? (
                        <ApprovalModeSwitcher
                          approvalModeLocked={approvalLock.locked}
                          {...(approvalLock.max === undefined ? {} : { maxApprovalMode: approvalLock.max })}
                          session={session}
                          onChange={async (approvalMode) => {
                            try {
                              setSession(await api.updateSession(session.id, { approvalMode }));
                            } catch (cause) {
                              reportError(cause, "action");
                            }
                          }}
                        />
                      ) : null
                    }
                    modelSlot={
                      session ? (
                        <SessionModelSwitcher
                          session={session}
                          provider={modelProvider}
                          onChanged={setSession}
                          onOpenSettings={openSettingsPage}
                          onError={(cause) => reportError(cause, "action")}
                        />
                      ) : null
                    }
                    onSkillPath={setSkillPath}
                    onError={setPersistentError}
                  />
                )}
              </div>
            </section>
          </Panel>
          {inspectorVisible && sideBySide ? (
            <>
              <PanelSeparator className="w-px bg-border outline-none transition-colors hover:bg-primary data-[separator=active]:bg-primary focus-visible:bg-primary" />
              <Panel id="inspector" defaultSize={400} minSize={320} maxSize={720}>
                <div className="flex h-full min-w-0 flex-col overflow-hidden bg-card" aria-label={text.inspectorLabel} data-testid="session-inspector">
                  {inspectorContent}
                </div>
              </Panel>
            </>
          ) : null}
        </PanelGroup>
        {inspectorVisible && !sideBySide ? (
          <InspectorOverlay onClose={() => setSideOpen(false)} viewerOpen={drawer !== null}>
            {inspectorContent}
          </InspectorOverlay>
        ) : null}
      </div>
    </>
  );
}

function RuntimeFileTree(props: {
  entries: FileEntryDto[];
  files: Record<string, FileEntryDto[]>;
  expanded: Set<string>;
  onToggleDirectory(path: string): void;
  onPreview(path: string): void;
  depth?: number;
}) {
  const text = useT().conversation.runtime.fileTree;
  const depth = props.depth ?? 0;
  if (props.entries.length === 0) {
    return depth === 0 ? (
      <p className="m-0 px-3 py-4 text-small text-subtle-foreground">{text.empty}</p>
    ) : (
      <p className="m-0 py-1 text-caption text-subtle-foreground" style={{ paddingLeft: 12 + (depth + 1) * 14 }}>{text.emptyDirectory}</p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col p-0" role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? text.label : undefined}>
      {props.entries.map((entry) => {
        const directory = entry.type === "directory";
        const open = directory && props.expanded.has(entry.path);
        return (
          <li key={entry.path} role="treeitem" aria-expanded={directory ? open : undefined} aria-selected={false}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-1.5 rounded-sm pr-2 text-left text-small text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              style={{ paddingLeft: 8 + depth * 14 }}
              title={entry.path}
              onClick={() => (directory ? props.onToggleDirectory(entry.path) : props.onPreview(entry.path))}
            >
              {directory ? (
                <ChevronRightIcon className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
              ) : (
                <span className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              {directory ? (
                <FolderLucideIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
              ) : (
                <FileLucideIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
            {open && (
              <RuntimeFileTree
                entries={props.files[entry.path] ?? []}
                files={props.files}
                expanded={props.expanded}
                onToggleDirectory={props.onToggleDirectory}
                onPreview={props.onPreview}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

async function refreshApprovals(
  sessionId: string,
  setter: (items: ApprovalDto[]) => void,
) {
  setter((await api.listApprovals(sessionId)).items);
}

async function refreshChanges(
  sessionId: string,
  setter: (items: WorkspaceChange[]) => void,
  setStats: (stats: { additions: number; deletions: number }) => void,
) {
  const response = await api.listChanges(sessionId);
  setter(response.items);
  setStats({ additions: response.additions, deletions: response.deletions });
}

function mergeSessionEvents(
  current: EventEnvelope<string, JsonValue>[],
  incoming: readonly EventEnvelope<string, JsonValue>[],
): EventEnvelope<string, JsonValue>[] {
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) {
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** 站内跳转：会话画布不依赖路由上下文（测试与内嵌场景），用 history + popstate 通知路由。 */
function navigateInApp(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * 旧版需求会话（创建时没有挂 suduo 工具）：输入框上方一行提示，不打断对话（需求 七 · 已有的需求会话）。
 */
function LegacySessionBanner({ context, onNavigate }: { context: SessionContextDto; onNavigate(path: string): void }) {
  const text = useT().conversation.runtime.legacy;
  const href = requirementPageHref(context);
  return (
    <Banner
      tone="info"
      className="mx-auto mb-2 w-full max-w-[760px]"
      data-testid="legacy-session-banner"
      actions={
        href === null ? undefined : (
          <a
            href={href}
            className="rounded-xs font-medium whitespace-nowrap text-primary-text underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="legacy-session-back"
            onClick={(event) => {
              // 新标签 / 新窗口打开交给浏览器；普通点击站内跳转。
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              onNavigate(href);
            }}
          >
            {text.back}
          </a>
        )
      }
    >
      {text.text}
    </Banner>
  );
}

/** 房间任务会话「在讨论里查看」：打开对应房间并展开这个话题。 */
function roomThreadHref(task: SessionRoomTaskDto): string {
  return `/p/${encodeURIComponent(task.remoteProjectId)}/rooms/${encodeURIComponent(task.roomId)}?thread=${encodeURIComponent(task.threadRootId)}`;
}

/** 房间任务会话的输入区：换成一行只读说明；知道对应的房间话题时给「在讨论里查看」（同会话列表菜单）。 */
function RoomTaskReadonlyNotice({ roomTask, onNavigate }: { roomTask: SessionRoomTaskDto | null; onNavigate(path: string): void }) {
  const text = useT().conversation.runtime.roomTask;
  const href = roomTask === null ? null : roomThreadHref(roomTask);
  return (
    <div
      className="mx-auto flex w-full max-w-[760px] items-center gap-2 rounded-lg border border-dashed border-border px-3.5 py-3 text-small text-subtle-foreground"
      data-testid="room-task-readonly"
    >
      <LockIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text.text}</span>
      {href === null ? null : (
        <a
          href={href}
          className="shrink-0 rounded-xs font-medium whitespace-nowrap text-primary-text underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            // 新标签 / 新窗口打开交给浏览器；普通点击站内跳转。
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            event.preventDefault();
            onNavigate(href);
          }}
        >
          {text.openInRoom}
        </a>
      )}
    </div>
  );
}

function EmptyConversation() {
  const text = useT().conversation.runtime.empty;
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <h2 className="m-0 text-section font-semibold text-foreground">{text.title}</h2>
      <p className="m-0 max-w-[420px] text-small text-muted-foreground">
        {text.description({
          skill: <kbd key="skill" className="font-mono">/</kbd>,
          file: <kbd key="file" className="font-mono">@</kbd>,
        })}
      </p>
    </div>
  );
}

/** 本地存储不可用（隐私模式、被禁用）时静默退化为不记忆。 */
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

/**
 * 窄屏（<1280）时的检查面板：浮在对话上方、会话头之下（不挡会话头的开关）。
 * 打开时焦点移进面板，Esc 收起并把焦点还给之前的位置（技术设计 §6.5）；文件查看器开着时 Esc 先交给它。
 */
function InspectorOverlay({ children, viewerOpen, onClose }: { children: ReactNode; viewerOpen: boolean; onClose(): void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="absolute top-[53px] right-0 bottom-0 z-30 flex w-[min(420px,100%)] flex-col overflow-hidden border-l border-border bg-card shadow-3 outline-none"
      role="region"
      aria-label={t.conversation.runtime.inspectorLabel}
      data-testid="session-inspector"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || viewerOpen) return;
        const target = event.target;
        if (target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </div>
  );
}
