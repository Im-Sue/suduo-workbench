import type { RequirementStatus } from "@suduo/cloud-contracts";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor, type Messages } from "../i18n/messages/index.js";

/** 需求状态的显示名，按调用时的界面语言取（云端契约里的 REQUIREMENT_STATUS_LABELS 只给本机服务用）。 */
export function requirementStatusLabel(status: RequirementStatus, t: Messages = messagesFor(currentLocale())): string {
  const labels: Record<RequirementStatus, string> = t.common.requirementStatus;
  return labels[status];
}
