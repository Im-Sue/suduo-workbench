import type { BrowserContext, Page } from "playwright";
import type { Locale } from "@suduo/client-contracts";
import type { RequirementsServiceFixture } from "../requirements-service-fixture.js";
import type { GateUiText } from "../ui-text.js";
import type { UntranslatedFinding } from "../untranslated-audit.js";

export interface GateCStepContext {
  /** 这一轮按哪种界面语言验收（`SUDUO_GATE_LOCALE`，默认 zh-CN）。 */
  locale: Locale;
  /** 按 `locale` 从前端字典取出的界面文字；步骤定位按钮、标题、标签都用它。 */
  ui: GateUiText;
  /** 英文冒烟里查到漏翻的页面（untranslated-audit.ts）；整轮跑完统一判失败。 */
  untranslated: { page: string; findings: UntranslatedFinding[] }[];
  artifactRoot: string;
  projectRoot: string;
  origin: string;
  page: Page;
  browserContext: BrowserContext;
  screenshots: string[];
  pageErrors: string[];
  completedSteps: Set<string>;
  remoteProjectId: string | null;
  localProjectId: string | null;
  sessionId: string | null;
  runtimePidBeforeCrash: number | null;
  /** workspace 锁定的 codex 二进制路径；步骤需要直接调 CLI 时用它（pr12 起）。 */
  codexBin: string;
  runtimePidAfterCrash: number | null;
  requirementsFixture: RequirementsServiceFixture;
  runCapture(
    command: string,
    args: string[],
    expectedStatus: number,
  ): { stdout: string; stderr: string };
}

export interface GateCStep {
  id: string;
  run(context: GateCStepContext): Promise<void>;
}

export function defineGateCSteps(...steps: GateCStep[]): readonly GateCStep[] {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || ids.has(step.id)) {
      throw new Error(`gate-c step id must be unique and non-empty: ${step.id}`);
    }
    ids.add(step.id);
  }
  return Object.freeze(steps);
}

export async function runGateCSteps(
  context: GateCStepContext,
  steps: readonly GateCStep[],
): Promise<void> {
  for (const step of steps) {
    await step.run(context);
    context.completedSteps.add(step.id);
  }
}
