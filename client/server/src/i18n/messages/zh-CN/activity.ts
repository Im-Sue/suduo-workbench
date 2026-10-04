/** 会话活动描述（会话列表与「我的工作」里「正在做什么」那一行）与本机 Agent 在线状态。 */
export const activity = {
  /** 会话卡片上「正在做什么」：当前步骤说成一句话（按步骤类型说）。 */
  step: {
    thinking: "正在思考",
    replying: "正在回复",
    /** 步骤已经做完、下一步还没开始。 */
    justFinished: (step: string) => `刚完成：${step}`,
    runCommand: "运行命令",
    /** command 已截短、打码。 */
    runCommandWith: (command: string) => `运行命令：${command}`,
    editFiles: "修改文件",
    editFile: (name: string) => `修改 ${name}`,
    /** count 是改动的文件总数（≥ 2），name 是第一个文件名。 */
    editFilesMany: (name: string, count: number) => `修改 ${name} 等 ${String(count)} 个文件`,
    callTool: "调用工具",
    callToolWith: (tool: string) => `调用工具：${tool}`,
    webSearch: "搜索网页",
  },
  /**
   * 本机 Agent 的登记状态说明（GET /api/v2/agents/self 的 message）；
   * 前端接在「本机的 Codex 还没登记成 Agent：」/「本机的 Codex 暂时不可用：」后面。
   */
  agent: {
    notSignedIn: "还没有登录需求服务",
    registering: "正在登记本机 Agent",
    signInExpired: "需求服务登录已过期，请重新登录",
    /** reason 是需求服务或网络的报错。 */
    registerFailed: (reason: string) => `登记本机 Agent 失败：${reason}`,
    needsReregister: "本机 Agent 需要重新登记",
    heartbeatFailed: (reason: string) => `本机 Agent 心跳失败：${reason}`,
  },
};
