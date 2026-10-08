export const common = {
  /** 语言选项的名称：各语言按自己的写法显示，便于看不懂当前语言的人找到自己的语言。 */
  localeOption: {
    system: "跟随系统",
    "zh-CN": "简体中文",
    en: "English",
  },
  /** 需求状态名（契约里的状态值不变，显示名按语言）。 */
  requirementStatus: {
    draft: "草稿",
    in_refinement: "梳理中",
    ready_for_development: "待开发",
    in_development: "开发中",
    in_testing: "测试中",
    completed: "已完成",
    on_hold: "暂缓",
  },
  /** 需求优先级名（从急到缓）；没有优先级时显示 noPriority。 */
  requirementPriority: {
    urgent: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  },
  noPriority: "无优先级",
  time: {
    justNow: "刚刚",
    minutesAgo: (minutes: number) => `${String(minutes)} 分钟前`,
    yesterdayAt: (clock: string) => `昨天 ${clock}`,
    today: "今天",
    yesterday: "昨天",
  },
  duration: {
    seconds: (seconds: number) => `${String(seconds)} 秒`,
    minutes: (minutes: number) => `${String(minutes)} 分钟`,
    minutesSeconds: (minutes: number, seconds: number) => `${String(minutes)} 分 ${String(seconds)} 秒`,
  },
};
