/**
 * 会话之间的关系（多 Agent 协作 S7，需求 4.1 / 4.2）：引用别的会话、Agent 读取会话的标签、交给另一个 Agent 接着做。
 */
export const sessionLinks = {
  /** 时间线上 Agent 读取另一个会话的步骤：「读取了 Claude Code ·「导出接口」· 最近 3 轮」。 */
  read: {
    title: (agent: string, title: string, view: string) => `读取了 ${agent} ·「${title}」· ${view}`,
    /** 会话信息还没取到（或已删除）时。 */
    pending: (view: string) => `读取了一个会话 · ${view}`,
    views: {
      summary: "概要",
      conversation: (rounds: number) => `最近 ${rounds} 轮`,
      turns: "回合列表",
      turn: (turn: number) => `第 ${turn} 回合`,
      changes: "累计改动",
    },
  },
  /** 消息里的会话标签。 */
  chip: {
    open: (title: string) => `打开会话「${title}」`,
  },
  /** 输入框 @ 面板。 */
  palette: {
    sessions: "会话",
    files: "文件",
    sessionMeta: (agent: string, project: string) => `${agent} · ${project}`,
  },
  continue: {
    button: "交给另一个 Agent 接着做",
    title: "交给另一个 Agent 接着做",
    description: (title: string) =>
      `开一个新会话接着「${title}」做：新会话会引用这个会话，首条消息已预填好，你确认后再发出。工作目录与关联的需求不变。`,
    start: "开始",
    failed: (message: string) => `没能开新会话：${message}`,
    /** 新会话输入框里预填的首条消息；link 是插好的会话标签。 */
    prefill: (link: string) => `接着 ${link} 继续：`,
  },
  banner: {
    continuedFrom: "接续自",
    continuedBy: "已由这些会话接着做",
    deleted: "（已删除）",
    session: (agent: string, title: string) => `${agent} ·「${title}」`,
  },
  list: {
    continuedFrom: (title: string) => `接续自「${title}」`,
  },
};
