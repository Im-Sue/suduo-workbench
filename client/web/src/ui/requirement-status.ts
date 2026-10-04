import type { RequirementStatus } from "@suduo/cloud-contracts";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor, type Messages } from "../i18n/messages/index.js";

/** 需求状态的显示名，按调用时的界面语言取（本机服务给 Codex 的状态名在 server 字典 `common.requirementStatus`）。 */
export function requirementStatusLabel(status: RequirementStatus, t: Messages = messagesFor(currentLocale())): string {
  const labels: Record<RequirementStatus, string> = t.common.requirementStatus;
  return labels[status];
}
