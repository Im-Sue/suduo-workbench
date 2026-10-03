import type { Messages } from "../zh-CN/index.js";

export const common = {
  localeOption: {
    system: "Follow system",
    "zh-CN": "简体中文",
    en: "English",
  },
  time: {
    justNow: "just now",
    minutesAgo: (minutes: number) => `${String(minutes)} min ago`,
    yesterdayAt: (clock: string) => `Yesterday ${clock}`,
    today: "Today",
    yesterday: "Yesterday",
  },
  duration: {
    seconds: (seconds: number) => `${String(seconds)}s`,
    minutes: (minutes: number) => `${String(minutes)} min`,
    minutesSeconds: (minutes: number, seconds: number) => `${String(minutes)} min ${String(seconds)}s`,
  },
} satisfies Messages["common"];
