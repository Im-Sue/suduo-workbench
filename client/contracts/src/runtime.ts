import type { RuntimeApprovalMode } from "./config.js";
import type {
  JsonValue,
  RuntimeEventDraft,
  ThreadRef,
  TurnRef,
} from "./events.js";

export interface RuntimeSecurityPolicy {
  approvalPolicy: "untrusted" | "on-request" | "never";
  approvalsReviewer: "user";
  sandbox: {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    networkAccess: boolean;
  };
}

export type RuntimeInput =
  | { type: "text"; text: string }
  | { type: "local-image"; path: string; detail?: "low" | "high" }
  | { type: "image-url"; url: string; detail?: "low" | "high" }
  | { type: "skill"; name: string; path: string };

export interface StartThreadBase {
  sessionId: string;
  projectRoot: string;
  workspaceRoots: string[];
  /** 会话的审批档；各适配器换算成自己的机制（Codex 见 `RUNTIME_APPROVAL_MODE_POLICIES`）。 */
  approvalMode: RuntimeApprovalMode;
  /** 附加给模型的系统级指令（如需求会话的需求卡）；runtime 负责与自身指令合并。 */
  developerInstructions?: string;
  /**
   * 挂到线程上的客户端自定义工具（Codex `dynamicTools`，ADR-0008）。只在新建线程时下发；
   * 续接线程时 Codex 从线程记录里恢复，runtime 忽略此字段。
   */
  dynamicTools?: RuntimeToolSpec[];
}

/** 客户端自定义工具的声明（对应 Codex `DynamicToolSpec` 的 function 形态）。 */
export interface RuntimeToolSpec {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

/** 工具调用的回包内容（对应 Codex `DynamicToolCallOutputContentItem`）。 */
export type RuntimeToolOutputItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export interface RespondToolCallInput {
  /** runtime 在 `tool.call-requested` 事件里给出的调用引用。 */
  callRef: string;
  success: boolean;
  contentItems: RuntimeToolOutputItem[];
}

/** `tool.call-requested` 事件的载荷。 */
export interface RuntimeToolCallRequest {
  callRef: string;
  connectionId: string;
  requestId: string;
  callId: string;
  turnId: string | null;
  tool: string;
  arguments: JsonValue;
}

export type StartThreadInput =
  | (StartThreadBase & {
      mode: "create";
    })
  | (StartThreadBase & {
      mode: "resume";
      threadRef: ThreadRef;
    });

export interface RuntimeThread {
  threadRef: ThreadRef;
  role: string;
  metadata: JsonValue;
}

export interface StartThreadResult {
  primaryThread: RuntimeThread;
  threads: RuntimeThread[];
}

export interface StartTurnInput {
  sessionId: string;
  threadRef: ThreadRef;
  clientTurnId: string;
  input: RuntimeInput[];
  projectRoot: string;
  workspaceRoots: string[];
  /** 每回合显式下发的审批档。 */
  approvalMode: RuntimeApprovalMode;
  /**
   * 会话级模型。undefined = 调用方不管理（不下发，保持旧行为）；null = 跟随全局默认；
   * 字符串 = 显式指定。Codex 的回合覆盖对「本回合及后续回合」粘性生效，
   * runtime 负责记住每个线程上次下发的值，改回跟随默认时显式下发默认值。
   */
  model?: string | null;
  /** 会话级推理强度，语义同 model。 */
  reasoningEffort?: string | null;
}

export interface StartTurnResult {
  turnRef: TurnRef;
  acceptedAt: number;
}

export type ApprovalDecision =
  | "accept"
  /** 批准，且本会话同类请求不再询问（codex 会话级审批缓存）。 */
  | "acceptForSession"
  | "decline"
  /** 拒绝并立即中断回合。 */
  | "cancel";

export interface ApproveInput {
  sessionId: string;
  threadRef: ThreadRef;
  approvalRef: string;
  decision: ApprovalDecision;
}

export interface ApproveResult {
  acknowledged: boolean;
}

export interface InterruptInput {
  sessionId: string;
  threadRef: ThreadRef;
  turnId: string;
}

export interface RuntimeSubscribeOptions {
  signal: AbortSignal;
}

export interface RuntimeSkill {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
}

export interface AgentRuntime {
  readonly runtimeId: string;
  readonly runtimeKind: string;
  /** 驱动的是哪家 Agent（配置表的 id）；不写时 Codex 运行时视为 codex（ADR-0014）。 */
  readonly agentId?: string;

  startThread(input: StartThreadInput): Promise<StartThreadResult>;
  startTurn(input: StartTurnInput): Promise<StartTurnResult>;
  approve(input: ApproveInput): Promise<ApproveResult>;
  interrupt(input: InterruptInput): Promise<void>;
  subscribe(options: RuntimeSubscribeOptions): AsyncIterable<RuntimeEventDraft>;
  /**
   * 回复一次客户端自定义工具调用。调用引用已失效（连接换代、Codex 已撤回）时返回
   * `{ delivered: false }`，不抛错：调用方只需记日志。
   */
  respondToolCall?(input: RespondToolCallInput): Promise<{ delivered: boolean }>;
  /** 这次工具调用还在等回包吗（没被 Codex 撤回、连接没换代）。 */
  isToolCallPending?(callRef: string): boolean;

  /**
   * 把额外的 skills 根目录登记进 runtime 自身的注册表。
   * 不登记的话，runtime 不认识这些 skill，消息里的 skill 引用会被静默忽略。
   */
  setExtraSkillRoots?(roots: readonly string[]): Promise<void>;
  /** runtime 注册表里对该工作目录可见的 skills（UI 的真相源）。 */
  listSkills?(cwd: string): Promise<RuntimeSkill[]>;
  /** 启用/停用 skill（停用可为其余 skill 让出描述预算）。 */
  setSkillEnabled?(name: string, enabled: boolean): Promise<void>;
}
