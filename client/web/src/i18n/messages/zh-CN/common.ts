export const common = {
  /** 语言选项的名称：各语言按自己的写法显示，便于看不懂当前语言的人找到自己的语言。 */
  localeOption: {
    system: "跟随系统",
    "zh-CN": "简体中文",
    en: "English",
  },
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
