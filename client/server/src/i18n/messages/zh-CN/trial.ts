/**
 * 并行试做（多 Agent 协作 S10，技术设计 2.12、需求 4.5）：试做会话的角色说明与标题、采用时的提交信息、报错。
 */
export const trial = {
  /** 试做会话的角色说明（建线程时进开场说明）。 */
  role: (others: readonly string[]) =>
    [
      "# 并行试做",
      `这是并行试做的一版：同一个任务也交给了 ${others.length === 0 ? "别的 Agent" : others.join("、")}，各自在独立的工作目录与分支里做，用户会并排比较后选一版。`,
      "- 只在当前工作目录里改；不要切换分支、不要 push，提交由 SuDuo 在采用时做。",
      "- 做完用一段话说明做法、改了哪些文件、跑了哪些测试与结果、还有什么没做。",
      "- 你不能委派、不能请别人评审。",
    ].join("\n"),
  title: (agent: string, task: string) => `试做 · ${agent}：${task}`,
  /** 采用时 SuDuo 在这一版的分支上提交。 */
  commitMessage: (label: string | null, agent: string, task: string) => `SuDuo 试做：${label === null ? "" : `${label} · `}${agent}\n\n${task}`,
  mergeMessage: (label: string | null, agent: string, branch: string) => `合并 SuDuo 试做（${label === null ? "" : `${label} · `}${agent}）：${branch}`,
  notGitRepo: "这个项目目录不是 git 仓库，没法建独立的工作目录。先在项目设置里初始化版本管理。",
  agentCount: (min: number, max: number) => `并行试做要选 ${String(min)}–${String(max)} 个 Agent。`,
  taskMissing: "缺少任务说明。",
  agentIdMissing: "每一版都要指定 Agent。",
  entryNotFound: "没有这一版试做。",
  notFound: "没有这个试做。",
  worktreeFailed: (message: string) => `没能建工作目录：${message}`,
  setupFailed: "准备命令失败，这一版没开工（看准备输出）。",
  sessionFailed: (message: string) => `没能开会话：${message}`,
  sendFailed: (message: string) => `任务没发出去：${message}。可以打开这一版的会话重新发送。`,
  prepareFailed: (message: string) => `准备时出错：${message}`,
  restartInterrupted: "本机服务重启前没准备好",
  projectMissing: "找不到发起试做的本机项目（目录关联可能改过），没法在原目录里操作 git。",
  noWorktree: "这一版没有工作目录（没建成或已删除），没法采用。",
  cleanupBusy: "这一版的目录还在被用（这一版的会话，或从它开的评审、接着做还在进行），没清理：先停下，再清理。",
  cleanupFailed: (message: string) => `没能删除：${message}`,
  branchNotRemoved: (branch: string, message: string) =>
    `分支 ${branch} 没删，git 说：${message}。不要它了可以再清理一次，确认时会写明强制删除、没合并的提交会丢。`,
  branchNeedsConfirm: (branch: string) => `分支 ${branch} 有没合并的提交，这次没有确认强制删除，留着没删：要删就再打开清理确认（会写明没合并的提交会丢）。`,
  adoptCommitFailed: (message: string) => `没能在这一版的分支上提交：${message}`,
};
