/**
 * 多 Agent 协作（S8）：委派卡片、运行面板、排队提示、审批来源、停止级联、输入框 @ Agent 委派、并发设置。
 */
export const collab = {
  delegation: {
    /** 卡片标题：「委派 · Claude Code」。 */
    title: (agent: string) => `委派 · ${agent}`,
    status: {
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      interrupted: "已中断",
    },
    waitingApproval: (count: number) => `等你确认 ${count} 个操作`,
    fromUser: "你发起的",
    fromAgent: "Agent 发起的",
    autoHandback: "完成后自动交回",
    stop: "停止",
    open: "打开子会话",
    childDeleted: "子会话已删除",
    handback: "让原 Agent 继续",
    handedBack: "结果已交回",
    finalMessage: "子会话的最终回答",
    noFinalMessage: "子会话没有给出文字回答。",
    changedFiles: (count: number, additions: number, deletions: number) => `改了 ${count} 个文件 · +${additions} −${deletions}`,
    error: (message: string) => `原因：${message}`,
    failures: {
      stop: "没能停止这个委派",
      handback: "没能把结果交回",
      start: "没能委派",
    },
    started: (agent: string) => `已委派给 ${agent}`,
    /** 输入框 @Agent 委派时带了附件或技能。 */
    textOnly: "委派暂时只能带文字。附件和技能可以在委派后打开子会话再发给它。",
    oneAgent: "一次只能委派给一个 Agent。",
  },
  queue: {
    /** 名额满了，这条消息在排队（位置看侧栏「运行」，会随队列变化）。 */
    queued: "这条消息在本机队列里排队（同时运行的回合到了上限，或这个会话前面还有没开始的），轮到了会自动开始。排在第几位可以在侧栏「运行」里看。",
    dequeued: "排队中的消息已取消，没有发给 Agent。",
    dequeuedRestart: "本机服务重启了，这条排队的消息没有发出，需要的话请重发。",
    dequeuedInactive: "会话已归档或删除，这条排队的消息没有发出。",
    dequeuedRequeued: "本机服务重启了，这条排队的委派任务已自动重新排队。",
    startFailed: (message: string) => `这一轮没能开始：${message}`,
    cancel: "取消排队",
    cancelFailed: "没能取消排队",
  },
  approval: {
    /** 审批坞里来自委派子会话的卡片。 */
    origin: (agent: string, task: string) => `来自委派：${agent} · ${task}`,
  },
  cascade: {
    title: "一并停止子任务？",
    description: (count: number) => `这个会话还有 ${count} 个委派没做完。停止这一轮时可以一并停止它们（推荐），也可以让它们继续。`,
    stopAll: "一并停止",
    stopThis: "只停这一轮",
  },
  panel: {
    button: "运行",
    buttonLabel: (running: number, queued: number) => `本机运行中 ${running} 个、排队 ${queued} 个`,
    title: "本机运行",
    summary: (running: number, global: number) => `运行中 ${running}/${global}`,
    agentUsage: (running: number, limit: number) => `${running}/${limit}`,
    queuedTitle: "排队中",
    empty: "现在没有运行中的回合。",
    position: (position: number) => `第 ${position} 位`,
    promote: "先跑这个",
    cancel: "取消",
    stop: "停止",
    open: "打开会话",
    source: { user: "会话", delegate: "委派", room: "房间任务", review: "评审", trial: "试做" },
    loadFailed: (message: string) => `查不到本机运行情况：${message}`,
    settings: "调整并发上限",
  },
  palette: {
    agents: "委派给 Agent",
    agentHint: (agent: string) => `把这条消息作为任务交给 ${agent}`,
  },
  settings: {
    title: "同时运行",
    description: "本机同时运行中的回合上限：超出的排队，不会拒绝。个人订阅有用量限制时可以调低。",
    global: "全部 Agent 合计",
    perAgent: (agent: string) => `${agent} 最多同时`,
  },
};
