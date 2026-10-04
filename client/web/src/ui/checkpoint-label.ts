import type { GitCheckpointDto } from "@suduo/client-contracts";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor, type Messages } from "../i18n/messages/index.js";

/**
 * 检查点的显示名：按服务端识别出的类型渲染（识别靠提交里的标记行，不看会随写入语言变化的标题）。
 * 不是检查点的普通提交原样显示提交标题（用户写的内容）。环境面板与「回到这一轮开始前？」确认框共用。
 */
export function checkpointLabel(checkpoint: GitCheckpointDto, t: Messages = messagesFor(currentLocale())): string {
  if (checkpoint.kind === "turn-start") return t.sessions.checkpoints.turnStart;
  if (checkpoint.kind === "manual") return t.sessions.checkpoints.manual(checkpoint.note ?? "");
  return checkpoint.subject;
}
