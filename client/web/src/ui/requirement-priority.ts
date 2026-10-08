import type { RequirementPriority } from "@suduo/cloud-contracts";
import { currentLocale } from "../i18n/locale.js";
import { messagesFor, type Messages } from "../i18n/messages/index.js";

/** 需求优先级的显示名，按调用时的界面语言取；null / 缺省（旧版需求服务不返回）为「无优先级」。 */
export function requirementPriorityLabel(
  priority: RequirementPriority | null | undefined,
  t: Messages = messagesFor(currentLocale()),
): string {
  if (priority === null || priority === undefined) return t.common.noPriority;
  const labels: Record<RequirementPriority, string> = t.common.requirementPriority;
  return labels[priority];
}
