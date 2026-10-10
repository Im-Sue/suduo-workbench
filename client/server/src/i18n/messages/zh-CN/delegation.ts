/**
 * 委派（多 Agent 协作 S8，技术设计 2.10、需求 4.3）：委派工具的说明与回包、子会话的角色说明、
 * 交给子会话的任务消息与交回发起会话的结果消息。按发起会话（工具回包、交回消息）或子会话（角色、任务）的语言。
 */
export const delegation = {
  spec: {
    agentList: "只读：列出这台电脑上可以委派的 Agent（id、名字、状态、正在运行 / 排队的回合数与并发上限）。委派前先看一下。",
    start: {
      description:
        "把一个子任务交给本机另一个 Agent（开一个子会话）去做，立即返回委派 ID，不等它完成。" +
        "子会话在同一个代码目录工作，权限不高于当前会话；它看不到你的对话，任务说明要写清楚要做什么、做到什么程度、相关文件。" +
        "之后用 suduo_delegate_wait 等结果，可以先做别的。子会话的审批会出现在用户的界面上。",
      agentId: "要委派给哪个 Agent（suduo_agent_list 返回的 id，如 claude-code、codex）。",
      task: "任务说明：要做什么、验收标准、注意事项。",
      files: "相关文件（项目内相对路径），可选。",
      autoHandback: "子任务完成时如果你已经结束了这一轮，是否自动开新一轮把结果交给你（默认否：用户在界面上决定）。",
      approvalMode: "子会话的权限：readonly / ask / auto / full，不能高于当前会话；默认与当前会话相同。",
    },
    wait: {
      description:
        "等委派的子任务：完成了返回结果（最终回答、改动的文件、子会话 ID），没完成就在 maxSeconds 秒后返回进度，可以再等或先做别的。",
      delegationId: "suduo_delegate_start 返回的委派 ID。",
      maxSeconds: "最多等几秒，默认 240（不能超过工具超时）。",
    },
    send: {
      description: "给子会话补充一条消息（追加要求、回答它的问题）；它会作为子会话的下一轮开始。",
      delegationId: "委派 ID。",
      message: "要补充的话。",
    },
    cancel: {
      description: "取消委派：排队中的不再开始，正在运行的中断。",
      delegationId: "委派 ID。",
    },
  },

  reply: {
    agentsHeader: "可以委派的 Agent：",
    agentLine: (id: string, name: string, status: string, running: number, queued: number, limit: number) =>
      `- ${id}（${name}）· ${status} · 运行中 ${running}/${limit}${queued > 0 ? ` · 排队 ${queued}` : ""}`,
    noAgents: "这台电脑上没有可以委派的 Agent（可能都没装、没登录或在设置里停用了）。",
    agentStatus: { ready: "就绪", installed: "已安装", unknown: "未确认" } as Record<string, string>,
    started: (id: string, agent: string, status: string) => `已委派给 ${agent}，委派 ID：${id}（${status}）。用 suduo_delegate_wait 等结果。`,
    status: {
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      interrupted: "已中断",
    } as Record<string, string>,
    header: (agent: string, task: string, status: string) => `委派给 ${agent}：「${task}」· ${status}`,
    childSession: (id: string) => `子会话：suduo://session/${id}（需要细节时用 suduo_session_read 读）`,
    pendingApprovals: (count: number) => `子会话里有 ${count} 个操作在等用户确认。`,
    queuePosition: (position: number) => `在本机队列里第 ${position} 位。`,
    progress: (steps: number, last: string | null) => `进度：已做 ${steps} 步${last === null ? "" : `，最近：${last}`}`,
    stillRunning: "还没完成，可以再等，或先做别的。",
    finalMessage: "[子会话的最终回答]",
    noFinalMessage: "（子会话没有给出文字回答）",
    changedFiles: (count: number, additions: number, deletions: number) => `[改动的文件：${count} 个，+${additions} −${deletions}]`,
    fileLine: (path: string, kind: string) => `- ${path}（${kind}）`,
    fileKind: { add: "新增", delete: "删除", update: "修改" } as Record<string, string>,
    error: (message: string) => `原因：${message}`,
    delegationIdMissing: "缺少参数 delegationId。",
    agentIdMissing: "缺少参数 agentId（suduo_agent_list 返回的 id）。",
    taskMissing: "缺少参数 task（任务说明）。",
    messageMissing: "缺少参数 message。",
    notFound: (id: string) => `没有 ID 为 ${id} 的委派（或不是当前会话发起的）。`,
    notMain: "子会话不能再委派（只有用户开的主会话能委派）。",
    childGone: "子会话已删除，不能再补充消息。",
    cancelled: "已取消。",
    unknownAgent: (agentId: string) => `没有叫 ${agentId} 的 Agent（用 suduo_agent_list 看可以委派的）。`,
    agentUnavailable: (agentId: string) => `这个版本的 SuDuo 还不能委派给 ${agentId}。`,
    agentDisabled: (name: string) => `${name} 在 AI Agent 设置里停用了，不能委派给它。`,
  },

  /** 子会话的角色说明（建线程时进开场说明）。 */
  role: (parentAgent: string, parentSessionId: string) =>
    [
      "# 委派的子任务",
      `你是被 ${parentAgent} 委派的子任务执行者（发起会话：suduo://session/${parentSessionId}，需要背景时可以用 suduo_session_read 读它）。`,
      "- 只做任务说明里的事；做完用一段话说明结果、改了哪些文件、还有什么没做。",
      "- 你不能再把任务委派给别的 Agent。",
    ].join("\n"),
  /** 交给子会话的第一条消息。 */
  firstMessage: (task: string, files: readonly string[]) =>
    files.length === 0 ? task : `${task}\n\n相关文件：\n${files.map((file) => `- ${file}`).join("\n")}`,
  /** 把结果交回发起会话的消息（自动交回或用户点「让原 Agent 继续」）。 */
  handback: (agent: string, task: string, status: string, body: string, childSessionId: string | null) =>
    [
      `委派结果（${agent}：「${task}」· ${status}）：`,
      "",
      body,
      ...(childSessionId === null ? [] : ["", `子会话：suduo://session/${childSessionId}`]),
      "",
      "请根据这个结果继续。",
    ].join("\n"),
  /** 本机服务重启前没做完的委派。 */
  restartInterrupted: "本机服务重启前没完成",
};
