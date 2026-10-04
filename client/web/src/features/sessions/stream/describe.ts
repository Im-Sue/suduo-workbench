import type { TimelineStep, TurnTimeline } from "../../../event-projection/timeline.js";
import { currentLocale } from "../../../i18n/locale.js";
import { messagesFor, type Messages } from "../../../i18n/messages/index.js";
import { formatDuration } from "../../../ui/format.js";

/**
 * 消息流里的一句话摘要（需求 §4.5）：
 * - 步骤组折叠后一行：「查看了 6 个文件 · 运行了 2 条命令 · 18 秒」；
 * - 回合结束一行：「完成 · 用时 2 分 14 秒 · 修改 3 个文件 · 运行 5 条命令」。
 */

/** 折叠摘要里依次列出的步骤类型（字典 conversation.summary 里同名的说法）。 */
const GROUP_KINDS = ["read", "search", "list", "command", "tool", "web", "approval"] as const satisfies readonly TimelineStep["kind"][];

export function stepGroupSummary(steps: readonly TimelineStep[], t: Messages = messagesFor(currentLocale())): string {
  const text = t.conversation.summary;
  const parts: string[] = [];
  for (const kind of GROUP_KINDS) {
    const count = steps.filter((step) => step.kind === kind).length;
    if (count > 0) parts.push(text[kind](count));
  }
  if (parts.length === 0) {
    const thinking = steps.filter((step) => step.kind === "thinking").length;
    parts.push(thinking === steps.length ? text.thinking : text.steps(steps.length));
  }
  const duration = groupDuration(steps);
  if (duration !== null) parts.push(formatDuration(duration));
  return parts.join(" · ");
}

/** 从第一步开始到最后一步结束；还有步骤在跑时不给（界面上由计时器显示）。 */
export function groupDuration(steps: readonly TimelineStep[]): number | null {
  if (steps.length === 0 || steps.some((step) => step.status === "running" || step.status === "waiting")) return null;
  const start = Math.min(...steps.map((step) => step.startedTs));
  const end = Math.max(...steps.map((step) => step.endedTs ?? step.startedTs));
  return end > start ? end - start : null;
}

export function turnSummaryText(turn: TurnTimeline, t: Messages = messagesFor(currentLocale())): string {
  const text = t.conversation.summary;
  const parts = [text.outcome[turn.status]];
  if (turn.summary.durationMs !== null && turn.summary.durationMs >= 1000) parts.push(text.duration(formatDuration(turn.summary.durationMs)));
  if (turn.summary.filesChanged > 0) parts.push(text.filesChanged(turn.summary.filesChanged));
  if (turn.summary.commands > 0) parts.push(text.commands(turn.summary.commands));
  return parts.join(" · ");
}

/** 计时显示：1:05、12:30、1:02:03。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * 展开的步骤列表里，把连续的「空思考」（没有摘要、已结束）合成一行「思考 ×N」。
 * 代码模式的模型在等工具结果（如等用户确认评论）时每隔几十秒就醒一次、留下一条空思考，
 * 逐条显示只会刷屏。有摘要的思考与其他步骤原样保留。
 */
export function collapseEmptyThinking(steps: readonly TimelineStep[], t: Messages = messagesFor(currentLocale())): TimelineStep[] {
  const result: TimelineStep[] = [];
  let run: TimelineStep[] = [];
  const flush = () => {
    if (run.length === 1) {
      result.push(run[0]!);
    } else if (run.length > 1) {
      const first = run[0]!;
      const last = run.at(-1)!;
      const durations = run.map((step) => step.durationMs).filter((value): value is number => value !== null);
      result.push({
        ...first,
        title: t.conversation.summary.thinkingRepeated(run.length),
        durationMs: durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0),
        endedTs: last.endedTs,
      });
    }
    run = [];
  };
  for (const step of steps) {
    const empty = step.kind === "thinking" && step.output.trim() === "" && step.status === "completed";
    if (empty) {
      run.push(step);
      continue;
    }
    flush();
    result.push(step);
  }
  flush();
  return result;
}
