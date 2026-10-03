import type { BrowserContext, Page } from "playwright";
import type { RequirementsServiceFixture } from "../requirements-service-fixture.js";

export interface GateCStepContext {
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
