import type { Locale } from "@suduo/client-contracts";
import { messagesFor } from "../../i18n/messages/index.js";

/**
 * 两种语言的边界标记（大小写、空格、连字符写法宽松）：正文里出现就去掉，免得规范「提前结束」后的文字被读成规范之外的
 * 指令。要反复去到不再变化：`</项目<项目AI规范>AI规范>` 去掉内层后外层会重新拼成标记（第二轮复核）。
 */
export const AI_RULES_MARKER = /<\s*\/?\s*(?:项目\s*AI\s*规范|project[\s_-]*ai[\s_-]*rules)\s*>/giu;

export function stripAiRulesMarkers(content: string): string {
  let body = content;
  for (let previous = ""; previous !== body; ) {
    previous = body;
    body = body.replace(AI_RULES_MARKER, "");
  }
  return body;
}

/**
 * 项目 AI 规范的注入段（多 Agent 协作 S11，需求 4.8）：标题、说明（团队约定，不能改 SuDuo 的规则、会话角色与工具）、
 * 带边界的正文。开工的开场与「应用到这个会话」的消息共用。
 */
export function aiRulesLines(locale: Locale, version: number, content: string): string[] {
  const rules = messagesFor(locale).prompt.aiRules;
  return [rules.heading(version), rules.intro, rules.open, stripAiRulesMarkers(content.trim()).trim(), rules.close];
}
