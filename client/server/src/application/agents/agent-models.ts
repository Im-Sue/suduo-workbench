import type { CodexModelOptionDto } from "@suduo/client-contracts";

/**
 * Claude Code 的模型别名（`--model` 认的官方别名，跟着 Claude Code 版本指向当前的模型）。
 * 不列具体版本号：订阅档位不同可用模型不同，别名由 Claude Code 自己解析；「默认」= 不指定（null）。
 */
export const CLAUDE_MODEL_OPTIONS: readonly CodexModelOptionDto[] = [
  { id: "opus", model: "opus", displayName: "Opus", isDefault: false, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: null },
  { id: "sonnet", model: "sonnet", displayName: "Sonnet", isDefault: false, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: null },
  { id: "haiku", model: "haiku", displayName: "Haiku", isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: null },
];

/**
 * 某家 Agent 可选的模型（会话级选择器用，与 Codex 的 model/list 投影同形）。Codex 从 model/list 取；
 * Claude 用别名；ACP Agent 的模型要建会话后才知道，这里先不给（选择器不出现，跟随 Agent 自己的默认）。
 */
export async function agentModelOptions(
  agentId: string,
  codexModels: () => Promise<CodexModelOptionDto[]>,
): Promise<CodexModelOptionDto[]> {
  switch (agentId) {
    case "codex":
      return codexModels();
    case "claude-code":
      return [...CLAUDE_MODEL_OPTIONS];
    default:
      return [];
  }
}
