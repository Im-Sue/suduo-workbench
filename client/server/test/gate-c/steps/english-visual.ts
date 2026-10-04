import { resolve } from "node:path";
import { GATE_C_FIXTURE_IDS, GATE_C_FIXTURE_NUMBERS } from "../requirements-service-fixture.js";
import { captureVisualSet, ENGLISH_VISUAL_MATRIX, englishVisualTargets } from "../visual-baseline.js";
import type { GateCStep } from "./types.js";

/**
 * 英文视觉基线（中英双语技术设计 §五）：关键页 × 亮色 × 1440×900，按语言分目录存放。
 *
 * 与中文的 `visual-closeout` 同一套采集：只截图、记 sha256，不在单次运行里判定；判定靠跨两次运行比对
 * （`visual-compare.ts`）。中文基线的文件名与路径不变（`visual/<标签>-<页面>-<主题>-<视口>.png`），
 * 英文放在 `visual/en/` 下，文件名规则相同。基线图片要在 gate-c 主机（Linux 字体）上生成。
 *
 * `SUDUO_VISUAL_LABEL` 给这一组起名（缺省 current），例如先跑一次 `baseline`，改动后再跑 `current` 比对。
 */
export const englishVisualStep: GateCStep = {
  id: "en-visual",
  async run(context) {
    if (context.remoteProjectId === null || context.sessionId === null) {
      throw new Error("en-visual 需要前序步骤建立的远程项目与会话");
    }
    const label = process.env["SUDUO_VISUAL_LABEL"] ?? "current";
    const targets = englishVisualTargets({
      origin: context.origin,
      remoteProjectId: context.remoteProjectId,
      sessionId: context.sessionId,
      requirementNumber: GATE_C_FIXTURE_NUMBERS.reqDraft1,
      roomId: GATE_C_FIXTURE_IDS.projectRoom,
    });
    const shots = await captureVisualSet({
      page: context.page,
      outDir: resolve(context.artifactRoot, "visual", context.locale),
      label,
      targets,
      matrix: ENGLISH_VISUAL_MATRIX,
    });
    const expected =
      targets.length * ENGLISH_VISUAL_MATRIX.themes.length * ENGLISH_VISUAL_MATRIX.viewports.length;
    if (shots.length !== expected) {
      throw new Error(`应采集 ${String(expected)} 张（英文关键页 × 亮色 × 宽视口），实际 ${String(shots.length)} 张`);
    }
    for (const shot of shots) {
      if (shot.bytes < 1024) {
        throw new Error(`${shot.name} 截图过小（${String(shot.bytes)} 字节），疑似白屏`);
      }
    }
    context.screenshots.push(...shots.map((shot) => `visual/${context.locale}/${label}-${shot.name}.png`));
  },
};
