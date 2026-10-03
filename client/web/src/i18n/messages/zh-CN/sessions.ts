export const sessions = {
  /** 推理强度的用户词表（需求 §5.1）：不显示档位原值。 */
  effort: {
    none: "不推理",
    minimal: "最快",
    low: "快速",
    medium: "均衡",
    high: "深入",
    xhigh: "最深入",
    max: "极致",
    ultra: "极致+",
  },
  checkpoints: {
    turnStart: "回合前自动存档",
    manual: (note: string) => `检查点：${note}`,
  },
};
