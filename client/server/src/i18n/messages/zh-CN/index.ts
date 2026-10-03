/**
 * 本机服务的中文字典，也是英文字典必须对齐的样板（中英双语技术设计 §4.2）。
 * 按功能区分组；新增条目时英文字典缺了同名条目就是类型错误。
 */
export const zhCN = {
  checkpoint: {
    /** 回合开始前自动存档的提交标题。 */
    autoSubject: "SuDuo 自动存档：回合开始前",
    /** 手动检查点的提交标题前缀，后面接说明或时间。 */
    manualPrefix: "SuDuo 检查点：",
    /** 还原前先存一个检查点时用的说明。 */
    beforeRestore: "还原前自动存档",
    restoredTo: (hash: string) => `还原到 ${hash}`,
  },
};

export type ServerMessages = typeof zhCN;
