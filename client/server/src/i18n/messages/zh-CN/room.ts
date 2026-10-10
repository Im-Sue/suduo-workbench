/**
 * 共享 Agent 在所有者本机执行房间任务时写下的文字（中英双语技术设计 §4.3）：按所有者的界面语言写，
 * 写下后就是房间里的内容，不随看的人的语言变。
 */
export const room = {
  codexNotRemovable: "Codex 是本机默认登记的 Agent，不能去掉",
  /** 这台电脑上的这家 Agent 不能执行讨论里的任务（多 Agent S6，ADR-0009 只读红线）。 */
  agentNotReadOnly: (name: string) => `${name} 做不到只读（可能不经询问就写文件），不能共享进讨论、不执行讨论里的任务`,
  agentDisabled: (name: string) => `${name} 在这台电脑的 AI Agent 设置里停用了，不执行讨论里的任务`,
  agentUnsupported: (agentId: string) => `这个版本的 SuDuo 不能在讨论里使用 ${agentId}`,
  /** 执行过程里单条长文本截断后的后缀，紧接在截下的文字后面；total 是原文字数。 */
  clipped: (total: number) => `…（以下省略，共 ${String(total)} 字）`,
  /** 回合结束了但没有文字回答时，替 Agent 写进回答正文的占位。 */
  noTextReply: "（这次没有给出文字回答，执行过程见详情。）",
  /** 回答超过房间消息上限时，截断处补的说明（前面空一行）。 */
  replyClipped: "\n\n…（回答太长，后面省略；完整内容在所有者本机的房间任务会话里）",
};
