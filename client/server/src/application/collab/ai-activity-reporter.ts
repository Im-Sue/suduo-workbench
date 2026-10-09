import type { AiActivityDto, CloudFeature, RecordAiActivityRequest } from "@suduo/cloud-contracts";
import { ApiError } from "../api-error.js";

/** 一条要上报的协作记录（只含元数据：谁用哪个 Agent 在需求上做了什么类型的协作、状态与分支名，不含对话与代码）。 */
export interface AiActivityEvent {
  /** 发生在哪个会话（用来找需求、看这个会话关没关上报）；试做组这类没有会话的给 requirementId。 */
  sessionId: string | null;
  requirementId?: string | null;
  /** 本机的不透明编号（会话、委派、评审、试做的一版、交接包草稿的编号）。 */
  localRef: string;
  kind: string;
  status: string;
  agentId: string;
  branch?: string | null;
}

/** 团队服务器声明支持协作记录（与共享对象、项目 AI 规范同一项）的功能名。 */
export const AI_COLLAB_FEATURE: CloudFeature = "ai_collab_v1";

/** 团队服务器不支持（健康检查没声明 ai_collab_v1）时，隔这么久再试。 */
const UNSUPPORTED_RETRY_MS = 10 * 60_000;
/**
 * 报失败时的重试间隔。「进行中」不重试（之后的结束状态会盖过它）；会话的「开始」只有这一条、后面没有别的状态，照样重试。
 */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
const OPEN_STATUSES = new Set(["started"]);
/** 防重复用的「已报状态」表的上限：满了清空（最坏多报一次同样的状态，服务端按同一条更新）。 */
const SENT_LIMIT = 2000;
/** 沿发起关系往上找开关的最大层数（关系本身最多两三层，防环）。 */
const LINEAGE_LIMIT = 16;

/**
 * 协作记录上报（多 Agent 协作 S11，需求 P2-D1）：需求会话里开工、委派、评审、试做、交接时报一条元数据到需求。
 * 默认开启，成员可以按会话关掉（接着做、委派、评审出来的会话没单独设过时跟着发起它的会话）。上报失败不影响
 * 本机的事：除了「进行中」都隔一阵重试几次；团队服务器不支持（看健康检查声明的功能，不凭一次 404 判断）时暂停一阵；
 * 同一条同一状态不重复报。
 */
export class AiActivityReporter {
  private readonly sent = new Map<string, string>();
  private unsupportedUntil = 0;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      requirementOf(sessionId: string): string | null;
      settings: { get(sessionId: string): boolean | null; set(sessionId: string, reporting: boolean): void };
      /** 发起这个会话的会话（接着做、委派、评审）；没有为 null。 */
      parentOf(sessionId: string): string | null;
      remote: { recordAiActivity(requirementId: string, input: RecordAiActivityRequest): Promise<AiActivityDto> };
      /** 团队服务器支不支持协作记录（健康检查声明的功能）；查不到为 null。 */
      supportsActivity?: () => Promise<boolean | null>;
      schedule?: (run: () => void, ms: number) => void;
      log?: (line: Record<string, unknown>) => void;
      now?: () => number;
    },
  ) {}

  report(event: AiActivityEvent): void {
    const requirementId = event.requirementId ?? (event.sessionId === null ? null : this.deps.requirementOf(event.sessionId));
    if (requirementId === null || requirementId === undefined) return;
    if (event.sessionId !== null && !this.isReporting(event.sessionId)) return;
    const now = this.now();
    if (now < this.unsupportedUntil) return;
    const key = `${requirementId}:${event.kind}:${event.localRef}`;
    if (this.sent.get(key) === event.status) return;
    if (this.sent.size >= SENT_LIMIT) this.sent.clear();
    this.sent.set(key, event.status);
    const input: RecordAiActivityRequest = {
      localRef: event.localRef,
      agentId: event.agentId,
      kind: event.kind,
      status: event.status,
      ...(event.branch === undefined ? {} : { branch: event.branch }),
      // 本机发生的时间：重试晚到的旧状态不会盖过服务端已有的新状态。
      occurredAt: new Date(now).toISOString(),
    };
    this.send(requirementId, input, key, 0);
  }

  /** 这个会话报不报：自己设过的为准，没设过跟着发起它的会话，一路都没设过就报。 */
  isReporting(sessionId: string): boolean {
    let current: string | null = sessionId;
    for (let depth = 0; current !== null && depth < LINEAGE_LIMIT; depth += 1) {
      const setting = this.deps.settings.get(current);
      if (setting !== null) return setting;
      current = this.deps.parentOf(current);
    }
    return true;
  }

  setReporting(sessionId: string, enabled: boolean): void {
    this.deps.settings.set(sessionId, enabled);
  }

  private send(requirementId: string, input: RecordAiActivityRequest, key: string, attempt: number): void {
    void this.deps.remote.recordAiActivity(requirementId, input).catch((error: unknown) => {
      this.log({ event: "suduo.ai_activity.report_failed", kind: input.kind, status: input.status, attempt, message: error instanceof Error ? error.message : String(error) });
      if (error instanceof ApiError && error.statusCode === 404) {
        // 需求删了 / 看不到了，或服务器还没有这个功能：问一下健康检查再决定要不要整体暂停。
        if (this.sent.get(key) === input.status) this.sent.delete(key);
        void this.checkSupport();
        return;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      // 「进行中」之后会有结束状态，不补；其余的（结束状态、会话的「开始」）补几次。
      if (!OPEN_STATUSES.has(input.status) && delay !== undefined) {
        this.schedule(() => {
          // 期间这一条又报了别的状态：不再补旧的。
          if (this.sent.get(key) !== input.status) return;
          this.send(requirementId, input, key, attempt + 1);
        }, delay);
        return;
      }
      if (this.sent.get(key) === input.status) this.sent.delete(key);
    });
  }

  private checkSupport(): Promise<void> {
    const supports = this.deps.supportsActivity;
    if (supports === undefined || this.checking !== null) return this.checking ?? Promise.resolve();
    this.checking = supports()
      .catch(() => null)
      .then((supported) => {
        if (supported === false) this.unsupportedUntil = this.now() + UNSUPPORTED_RETRY_MS;
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  private schedule(run: () => void, ms: number): void {
    if (this.deps.schedule !== undefined) {
      this.deps.schedule(run, ms);
      return;
    }
    setTimeout(run, ms).unref();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.error(JSON.stringify(value))))(line);
  }
}

/** 委派、评审的状态换成协作记录的状态。 */
export function activityStatusOf(status: string): string {
  switch (status) {
    case "queued":
    case "running":
      return "started";
    case "completed":
    case "submitted":
    case "unstructured":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}
