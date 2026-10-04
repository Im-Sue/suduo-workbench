/** 版本管理的检查点：提交标题与说明（写进 git 提交，按写入时的语言）。 */
export const checkpoint = {
  /** 回合开始前自动存档的提交标题。 */
  autoSubject: "SuDuo 自动存档：回合开始前",
  /** 手动检查点的提交标题前缀，后面接说明或时间。 */
  manualPrefix: "SuDuo 检查点：",
  /** 还原前先存一个检查点时用的说明。 */
  beforeRestore: "还原前自动存档",
  restoredTo: (hash: string) => `还原到 ${hash}`,
};
