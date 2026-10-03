import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { GATE_C_FIXTURE_NUMBERS } from "../requirements-service-fixture.js";
import { applyTheme, keyPageTargets, openKeyPage, rememberTheme, VISUAL_THEMES } from "../visual-baseline.js";
import type { GateCStep } from "./types.js";

/**
 * 无障碍检查（技术设计 §十一）：关键页 × 亮 / 暗跑 axe（WCAG 2.1 A / AA），
 * serious / critical 一条都不能有。完整结果写到 artifacts/a11y.json 供排查。
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);

interface Finding {
  page: string;
  theme: string;
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

export const a11yAuditStep: GateCStep = {
  id: "a11y-audit",
  async run(context) {
    if (context.remoteProjectId === null || context.sessionId === null) {
      throw new Error("a11y-audit 需要前序步骤建立的远程项目与会话");
    }
    const targets = keyPageTargets({
      origin: context.origin,
      remoteProjectId: context.remoteProjectId,
      sessionId: context.sessionId,
      requirementNumber: GATE_C_FIXTURE_NUMBERS.reqDraft1,
    });
    const findings: Finding[] = [];
    const report: Record<string, unknown>[] = [];
    const restoreTheme = await rememberTheme(context.page);
    try {
      for (const theme of VISUAL_THEMES) {
        await applyTheme(context.page, theme);
        for (const target of targets) {
          await openKeyPage(context.page, target);
          const result = await new AxeBuilder({ page: context.page }).withTags(TAGS).analyze();
          report.push({ page: target.name, theme, violations: result.violations });
          for (const violation of result.violations) {
            if (!BLOCKING.has(violation.impact ?? "")) continue;
            findings.push({
              page: target.name,
              theme,
              rule: violation.id,
              impact: violation.impact ?? "",
              help: violation.help,
              nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(" ")} · ${node.failureSummary ?? ""}`.slice(0, 300)),
            });
          }
        }
      }
    } finally {
      await restoreTheme();
    }
    writeFileSync(resolve(context.artifactRoot, "a11y.json"), JSON.stringify(report, null, 2) + "\n");
    if (findings.length > 0) {
      throw new Error(`无障碍检查有 ${String(findings.length)} 项 serious / critical：\n${JSON.stringify(findings, null, 2)}`);
    }
  },
};
