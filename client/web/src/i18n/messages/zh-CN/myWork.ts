import type { ReactNode } from "react";

/** 我的工作（需求 §4.3）：需要你处理 / 我的需求 / 会话 / 最近动态，以及首启留下的设置提醒。 */
export const myWork = {
  header: {
    title: "我的工作",
    intro: "跨项目汇总需要你处理的事、在跑的会话和你的需求。",
    refresh: "刷新",
  },
  loading: "正在加载",
  /** 某个区块的数据没拿到：label 是区块里的那类数据（下面各区块的 unavailableLabel）。 */
  unavailable: (label: string, message: string) => `${label}暂不可用：${message}`,
  retry: "重试",
  /** 取不到名字时的兜底。 */
  fallback: {
    localProject: "本机项目",
    project: "项目",
    requirement: "需求",
    requirementUnavailable: "需求暂不可用",
    requirementSession: "需求会话",
    untitledSession: "未命名会话",
    someone: "有人",
  },
  attention: {
    title: "需要你处理",
    unavailableLabel: "待我处理的事",
    empty: "都处理完了，暂时没有需要你出手的事。",
    pendingApproval: {
      title: (session: string) => `等你确认 · ${session}`,
      count: (count: number) => `${String(count)} 项等你确认`,
      action: "去确认",
    },
    failedTurn: {
      title: (session: string) => `上一轮没能完成 · ${session}`,
      action: "查看原因",
    },
    drift: {
      title: (requirement: string) => `开工后需求有变化 · ${requirement}`,
      detail: (sessions: number) => `${String(sessions)} 个会话在做它，开工时看到的内容已经过时`,
      action: "看看改了什么",
    },
    newComments: {
      title: (requirement: string) => `有新评论 · ${requirement}`,
      detail: (count: number) => `${String(count)} 条你还没看过的评论`,
      action: "去看看",
    },
    stale: {
      title: (requirement: string) => `停滞较久 · ${requirement}`,
      days: (days: number) => `${String(days)} 天没有变化`,
      action: "推进一下",
    },
    invalidMapping: {
      title: (project: string) => `本机代码目录不可用 · ${project}`,
      detail: "目录可能被移动或删除，重新选一次就好。",
      action: "重新选择",
    },
  },
  requirements: {
    title: "我的需求",
    scopeLabel: "需求范围",
    scopeAll: "全部项目",
    scopeCurrent: "当前项目",
    workingUnavailableLabel: "我在做的需求",
    listUnavailableLabel: "我负责 / 我提的需求",
    empty: "没有你负责、正在做或你提了还没人负责的需求。在需求页把需求指派给自己，或从需求开始会话。",
    statusUnknown: "状态未知",
    drift: "开工后需求有变化",
    waiting: "等你确认",
    running: "运行中",
    sessions: (count: number) => `${String(count)} 个会话`,
    unreadComments: (count: number) => `${String(count)} 条新评论`,
    assignedToMe: "你负责",
    createdUnassigned: "我提的 · 还没人负责",
  },
  sessions: {
    title: "会话",
    activeCount: (count: number) => `进行中 ${String(count)}`,
    unavailableLabel: "本机会话",
    empty: "本机还没有会话。在需求页从某个需求开始会话。",
    /** 会话卡副行开头的状态说明。 */
    card: {
      running: "运行中",
      approval: (count: number) => `等你确认 ${String(count)} 项`,
      failedTurn: "上一轮没能完成",
      error: "会话出错了",
      completed: "已完成",
      idle: "空闲",
    },
    elapsed: (duration: string) => `已用 ${duration}`,
    previewFromYou: "你：",
  },
  recent: {
    title: "最近动态",
    empty: "最近没有别人改动你的需求。",
    /** 「张三 更新了 REQ-12 订单导出」：人名与编号是调用方渲染好的节点。 */
    updated: (who: ReactNode, number: ReactNode, title: string): ReactNode[] => [who, " 更新了 ", number, " ", title],
  },
  /** 首启时跳过、留在顶部的设置提醒（各项的标题与说明在 setup 分区）。 */
  setupChecklist: {
    label: "还没做完的设置",
    remaining: (count: number) => `还有 ${String(count)} 项设置没做完`,
    dismiss: "不再提示",
    link: "去关联",
    recheck: "重新检查",
  },
  fixMapping: {
    title: "重新选择本机代码目录",
    description: (project: string | null) =>
      `${project ?? "这个项目"}的代码目录不可用了。选一个可以读写的目录，之后这个项目的会话都在这里运行。`,
    pathRequired: "先选一个代码目录。",
    pathInvalid: "这个目录现在用不了，换一个可以读写的目录。",
    cancel: "取消",
    save: "使用这个目录",
  },
};
