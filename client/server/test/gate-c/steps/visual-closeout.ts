import { resolve } from "node:path";
import { GATE_C_FIXTURE_NUMBERS } from "../requirements-service-fixture.js";
import {
  captureVisualSet,
  keyPageTargets,
  VISUAL_THEMES,
  VISUAL_VIEWPORTS,
  type VisualShot,
} from "../visual-baseline.js";
import type { GateCStep } from "./types.js";

/**
 * 视觉基线采集步骤（pr13 建立，UI/UX 重设计 P5 扩到关键页 × 亮暗 × 两个视口）。
 *
 * 它只**采集**，不判定——判定要跨「删除 `v2-*` 段前」与「删除后」两次运行，
 * 而单次 gate-c 只能看到当前代码。所以本步骤把关键页截图与 sha256 落到
 * `artifacts/gate-c/visual/`，由 pr13 的收口流程跑两轮并比对。
 *
 * 这样做的理由：spec 要求「删除前后像素比对，差异逐处解释」，而不是让某一次
 * 运行自己宣称「看着没问题」。
 */
export const visualCloseoutStep: GateCStep = {
  id: "visual-closeout",
  async run(context) {
    if (context.remoteProjectId === null || context.sessionId === null) {
      throw new Error("visual-closeout 需要前序步骤建立的远程项目与会话");
    }
    const label = process.env["SUDUO_VISUAL_LABEL"] ?? "current";
    const targets = keyPageTargets({
      origin: context.origin,
      remoteProjectId: context.remoteProjectId,
      sessionId: context.sessionId,
      requirementNumber: GATE_C_FIXTURE_NUMBERS.reqDraft1,
    });
    // UI/UX 重设计 P5：关键页 × 亮 / 暗 × 1440×900 与 1280×800（技术设计 §十一）。
    const shots: VisualShot[] = await captureVisualSet({
      page: context.page,
      outDir: resolve(context.artifactRoot, "visual"),
      label,
      targets,
      matrix: { themes: VISUAL_THEMES, viewports: VISUAL_VIEWPORTS },
    });
    const expected = targets.length * VISUAL_THEMES.length * VISUAL_VIEWPORTS.length;
    if (shots.length !== expected) {
      throw new Error(`应采集 ${String(expected)} 张（关键页 × 亮暗 × 两个视口），实际 ${String(shots.length)} 张`);
    }
    for (const shot of shots) {
      if (shot.bytes < 1024) {
        throw new Error(`${shot.name} 截图过小（${String(shot.bytes)} 字节），疑似白屏`);
      }
    }
    context.screenshots.push(...shots.map((shot) => `visual/${label}-${shot.name}.png`));
  },
};
