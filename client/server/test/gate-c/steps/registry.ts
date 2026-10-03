import { a11yAuditStep } from "./a11y-audit.js";
import { assistantApprovalStep } from "./assistant-approval.js";
import { assistantAttachmentStep } from "./assistant-attachment.js";
import { changesAndDiffStep } from "./changes-and-diff.js";
import { attributionBadgeStep } from "./attribution-badge.js";
import { queueAutoDispatchStep } from "./queue-auto-dispatch.js";
import { stopPausesQueueStep } from "./stop-pauses-queue.js";
import { extensionSeamStep } from "./extension-seam.js";
import { requirementsBoardStep } from "./requirements-board.js";
import { sessionsRailStep } from "./sessions-rail.js";
import { mcpSettingsStep } from "./mcp-settings.js";
import { overviewWorkbenchStep } from "./overview-workbench.js";
import { settingsCodexStep } from "./settings-codex.js";
import { settingsShellStep } from "./settings-shell.js";
import { visualCloseoutStep } from "./visual-closeout.js";
import { finalInterruptStep } from "./final-interrupt.js";
import { interruptAndReopenStep } from "./interrupt-and-reopen.js";
import { supervisorRecoveryStep } from "./supervisor-recovery.js";
import { defineGateCSteps, type GateCStep } from "./types.js";
import { v2UserPathStep } from "./v2-user-path.js";

export const gateCSteps = defineGateCSteps(
  v2UserPathStep,
  assistantApprovalStep,
  overviewWorkbenchStep,
  assistantAttachmentStep,
  changesAndDiffStep,
  // 三项各自建立并收口运行窗口，必须在离开 requirement session 之前。
  attributionBadgeStep,
  queueAutoDispatchStep,
  stopPausesQueueStep,
  interruptAndReopenStep,
  supervisorRecoveryStep,
  finalInterruptStep,
  // 看板步骤会离开会话路由，放在会话类断言之后，避免打断它们的上下文。
  requirementsBoardStep,
  sessionsRailStep,
  settingsShellStep,
  settingsCodexStep,
  mcpSettingsStep,
  visualCloseoutStep,
  a11yAuditStep,
  extensionSeamStep,
);

/**
 * 步骤前置映射（PR1）。
 *
 * `GateCStep` 只有 `id` 和 `run` 两个字段，**步骤自己不声明前置**，所以分片回归
 * 想只跑某几步时，前置关系必须由测试侧维护。这张表和 `gateCSteps` 放在一处，
 * 就是为了在增删步骤时同步改；`assertPrerequisiteCoverage()` 会在解析子集时
 * 强制两者一致，漏登记直接报错而不是悄悄少跑前置。
 *
 * 记的是「这一步需要谁先把状态建起来」，不是注册顺序里的前一步：
 * - `v2-user-path` 建登录 / 远程项目 / 本机目录映射 / 会话，并把页面停在会话路由，
 *   所以几乎所有步骤都依赖它；
 * - 自己 `page.goto` 的步骤（看板 / 设置 / MCP / 会话深链）只需要它；
 * - 不自己导航的步骤靠前序收尾停在会话路由；
 * - `changes-and-diff` 等的是 `GATE_C_ACCEPT.md`，那个文件由 `assistant-approval` 建；
 * - `supervisor-recovery` 要杀一个活着的 codex 子进程，必须先有步骤真的跑过回合。
 */
export const gateCStepPrerequisites: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "v2-user-path": [],
    "assistant-approval": ["v2-user-path"],
    "overview-workbench": ["v2-user-path"],
    "assistant-attachment": ["v2-user-path"],
    "changes-and-diff": ["v2-user-path", "assistant-approval"],
    "attribution-badge": ["v2-user-path"],
    "queue-auto-dispatch": ["v2-user-path"],
    "stop-pauses-queue": ["v2-user-path"],
    "interrupt-and-reopen": ["v2-user-path"],
    "supervisor-recovery": ["v2-user-path", "interrupt-and-reopen"],
    "final-interrupt": ["v2-user-path"],
    "requirements-board": ["v2-user-path"],
    "sessions-rail": ["v2-user-path"],
    "settings-shell": ["v2-user-path"],
    "settings-codex": ["v2-user-path"],
    "mcp-settings": ["v2-user-path"],
    "visual-closeout": ["v2-user-path"],
    "a11y-audit": ["v2-user-path"],
    "extension-seam": [],
  });

export interface GateCStepSelection {
  /** 按 registry 数组序排好的待执行步骤。 */
  steps: readonly GateCStep[];
  /** true 表示这次只跑子集，收尾断言要按已跑步骤收窄。 */
  subset: boolean;
  /** 用户点名的步骤（不含算出来的前置）。 */
  requested: readonly string[];
}

function assertPrerequisiteCoverage(steps: readonly GateCStep[]): void {
  const ids = new Set(steps.map((step) => step.id));
  const missing = steps
    .map((step) => step.id)
    .filter((id) => gateCStepPrerequisites[id] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `gateCStepPrerequisites 缺少步骤登记：${missing.join(", ")}（registry 增删步骤时同步这张表）`,
    );
  }
  for (const [id, prerequisites] of Object.entries(gateCStepPrerequisites)) {
    if (!ids.has(id)) {
      throw new Error(`gateCStepPrerequisites 登记了不存在的步骤：${id}`);
    }
    const unknown = prerequisites.filter((item) => !ids.has(item));
    if (unknown.length > 0) {
      throw new Error(`步骤 ${id} 的前置不存在：${unknown.join(", ")}`);
    }
  }
}

/**
 * 解析 `GATE_C_STEPS`（逗号分隔）为「前置闭包 + registry 数组序」的执行序列。
 *
 * 不设该变量时返回全量、`subset=false`，行为与改动前完全一致。
 */
export function resolveGateCStepSelection(
  steps: readonly GateCStep[],
  raw: string | undefined,
): GateCStepSelection {
  assertPrerequisiteCoverage(steps);
  const requested = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (requested.length === 0) {
    return { steps, subset: false, requested: [] };
  }
  const known = new Set(steps.map((step) => step.id));
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `GATE_C_STEPS 含未知步骤：${unknown.join(", ")}；可选：${[...known].join(", ")}`,
    );
  }
  const selected = new Set<string>();
  const expand = (id: string): void => {
    if (selected.has(id)) {
      return;
    }
    selected.add(id);
    for (const prerequisite of gateCStepPrerequisites[id] ?? []) {
      expand(prerequisite);
    }
  };
  for (const id of requested) {
    expand(id);
  }
  // 顺序语义直接复用 registry 数组序——runGateCSteps 本就按数组序执行。
  return {
    steps: steps.filter((step) => selected.has(step.id)),
    subset: true,
    requested,
  };
}
