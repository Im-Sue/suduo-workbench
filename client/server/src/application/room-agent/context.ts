import type { Locale } from "@suduo/client-contracts";
import type { RoomMessageDto } from "@suduo/cloud-contracts";
import { messagesFor } from "../../i18n/messages/index.js";
import { formatMessageLine, shortTime } from "./message-format.js";

/**
 * 房间 Agent 的回合输入（技术设计 4.4「Agent 上下文（默认值）」）：
 * - 新话题：近邻层（触发消息之前、24 小时内最近 20 条，单条 500 字）+ 话题层（根 + 之前的回复，
 *   最多 50 条，单条 1500 字）+ 触发消息；
 * - 续接（同一话题再次被 @）：只给上次触发之后话题里的新消息（不含自己的回答）+ 触发消息；
 * - 超过 40000 字主动降级：近邻 20 → 5 → 0，再从最早的话题回复截。
 * 固定层（身份、边界、工具）在建线程时进 developerInstructions，见 SessionContextService.roomSetup。
 * SuDuo 写的框架文字（标题、提示、文件标签、截断说明）按任务会话的语言；房间消息正文与人名原样。
 */

export const ROOM_CONTEXT_LIMITS = {
  neighborSteps: [20, 5, 0] as const,
  neighborWindowMs: 24 * 60 * 60_000,
  neighborBody: 500,
  topicLimit: 50,
  topicBody: 1_500,
  triggerBody: 20_000,
  budget: 40_000,
};

export interface RoomTurnInputOptions {
  /** 任务会话的语言：框架文字按它写。 */
  locale: Locale;
  /** new = 这个话题第一次进线程；continue = 线程里已有这个话题的历史。 */
  mode: "new" | "continue";
  trigger: RoomMessageDto;
  /** 话题里（根 + 回复）触发消息之前的消息；新话题时包含根。 */
  threadBefore: readonly RoomMessageDto[];
  /** 新话题：触发消息之前的房间消息；续接时忽略。 */
  neighbors: readonly RoomMessageDto[];
  /** 房间近况查不到时的说明（三态：查不到 ≠ 没有）。 */
  neighborsUnavailable?: string;
  /** 续接：上次触发消息的序号。 */
  lastTriggerSeq: number;
  /** 本机 Agent：续接时跳过自己发过的回答（线程里已经有了）。 */
  selfAgentId: string;
}

export interface RoomTurnInput {
  text: string;
  neighborCount: number;
  topicCount: number;
  /** 因条数上限或字数预算省略的话题消息数。 */
  omittedTopic: number;
}

export function buildRoomTurnInput(options: RoomTurnInputOptions): RoomTurnInput {
  const limits = ROOM_CONTEXT_LIMITS;
  const locale = options.locale;
  const text = messagesFor(locale).roomPrompt.turn;
  const reference = options.trigger.createdAt;
  const triggerLine = formatMessageLine(options.trigger, {
    bodyLimit: limits.triggerBody,
    time: shortTime(options.trigger.createdAt, reference),
    withTool: true,
    locale,
  });
  const topicLine = (message: RoomMessageDto) =>
    formatMessageLine(message, { bodyLimit: limits.topicBody, time: shortTime(message.createdAt, reference), withTool: true, locale });
  const neighborLine = (message: RoomMessageDto) =>
    formatMessageLine(message, { bodyLimit: limits.neighborBody, time: shortTime(message.createdAt, reference), withTool: true, locale });

  if (options.mode === "continue") {
    const fresh = options.threadBefore.filter(
      (message) =>
        message.seq > options.lastTriggerSeq &&
        message.id !== options.trigger.id &&
        !(message.authorKind === "agent" && message.agent?.id === options.selfAgentId),
    );
    let kept = fresh.slice(-limits.topicLimit);
    let omitted = fresh.length - kept.length;
    const render = () =>
      [
        ...(kept.length === 0
          ? []
          : [
              text.newInThread,
              ...(omitted > 0 ? [text.omitted(omitted)] : []),
              ...kept.map(topicLine),
              "",
            ]),
        text.trigger,
        triggerLine,
        text.answer,
      ].join("\n");
    let rendered = render();
    while (rendered.length > limits.budget && kept.length > 0) {
      kept = kept.slice(1);
      omitted += 1;
      rendered = render();
    }
    return { text: rendered, neighborCount: 0, topicCount: kept.length, omittedTopic: omitted };
  }

  // 新话题。
  const threadIds = new Set(options.threadBefore.map((message) => message.id));
  threadIds.add(options.trigger.id);
  const triggerAt = Date.parse(options.trigger.createdAt);
  const recentNeighbors = options.neighbors
    .filter(
      (message) =>
        !threadIds.has(message.id) &&
        message.seq < options.trigger.seq &&
        (!Number.isFinite(triggerAt) || triggerAt - Date.parse(message.createdAt) <= limits.neighborWindowMs),
    )
    .sort((a, b) => a.seq - b.seq);
  const root = options.threadBefore.find((message) => message.threadRootId === null) ?? null;
  const replies = options.threadBefore.filter((message) => message !== root);
  // 话题层最多 50 条：根 + 最近的回复。
  let keptReplies = replies.slice(-(root === null ? limits.topicLimit : limits.topicLimit - 1));
  let omitted = replies.length - keptReplies.length;

  const render = (neighborCount: number) => {
    const neighbors = neighborCount === 0 ? [] : recentNeighbors.slice(-neighborCount);
    const topic = [...(root === null ? [] : [root]), ...keptReplies];
    const sections: string[] = [];
    if (options.neighborsUnavailable !== undefined && neighborCount > 0) {
      sections.push(text.neighborsUnavailable(options.neighborsUnavailable), "");
    } else if (neighbors.length > 0) {
      sections.push(
        text.neighbors(neighbors.length),
        ...neighbors.map(neighborLine),
        "",
      );
    }
    if (topic.length > 0) {
      sections.push(
        text.topic(topic.length),
        ...(omitted > 0 ? [text.omittedReplies(omitted)] : []),
        ...topic.map(topicLine),
        "",
      );
    }
    sections.push(text.trigger, triggerLine, text.answer);
    return { text: sections.join("\n"), neighborCount: neighbors.length };
  };

  for (const step of limits.neighborSteps) {
    const rendered = render(step);
    if (rendered.text.length <= limits.budget) {
      return {
        text: rendered.text,
        neighborCount: rendered.neighborCount,
        topicCount: keptReplies.length + (root === null ? 0 : 1),
        omittedTopic: omitted,
      };
    }
  }
  // 近邻已降到 0 仍超长：从最早的话题回复开始截（保留根与触发消息）。
  let rendered = render(0);
  while (rendered.text.length > limits.budget && keptReplies.length > 0) {
    keptReplies = keptReplies.slice(1);
    omitted += 1;
    rendered = render(0);
  }
  return {
    text: rendered.text,
    neighborCount: 0,
    topicCount: keptReplies.length + (root === null ? 0 : 1),
    omittedTopic: omitted,
  };
}

/**
 * 线程重建（续接失败、建了全新线程）时附在固定层后面的「话题此前的讨论」：到上次被 @ 为止的话题消息，
 * 加上自己之前的回答（回答在完成时才分配序号，总在触发消息之后）。重建发生在已按「续接」组装好回合输入之后，
 * 回合输入只有上次触发之后、别人的新消息，两段合起来才完整。与需求卡同样包在证据段里，规则在前。
 */
export function rebuiltTopicSection(
  history: readonly RoomMessageDto[] | { unavailable: string },
  lastTriggerSeq: number,
  selfAgentId: string,
  /** 任务会话的语言。 */
  locale: Locale,
): string {
  const limits = ROOM_CONTEXT_LIMITS;
  const text = messagesFor(locale).roomPrompt.rebuilt;
  const turnText = messagesFor(locale).roomPrompt.turn;
  const head = [text.title, text.lost];
  if ("unavailable" in history) {
    return [...head, text.unavailable(history.unavailable)].join("\n");
  }
  const earlier = history
    .filter(
      (message) =>
        message.seq <= lastTriggerSeq || (message.authorKind === "agent" && message.agent?.id === selfAgentId),
    )
    .sort((a, b) => a.seq - b.seq);
  if (earlier.length === 0) {
    return [...head, text.none].join("\n");
  }
  const reference = earlier.at(-1)!.createdAt;
  const line = (message: RoomMessageDto) =>
    formatMessageLine(message, { bodyLimit: limits.topicBody, time: shortTime(message.createdAt, reference), withTool: true, locale });
  let kept = earlier.slice(-limits.topicLimit);
  let omitted = earlier.length - kept.length;
  const render = () =>
    [
      ...head,
      text.evidenceIntro,
      text.nextTurns,
      text.open,
      ...(omitted > 0 ? [turnText.omitted(omitted)] : []),
      ...kept.map(line),
      text.close,
    ].join("\n");
  let rendered = render();
  while (rendered.length > limits.budget / 2 && kept.length > 1) {
    kept = kept.slice(1);
    omitted += 1;
    rendered = render();
  }
  return rendered;
}

/** 会话标题：「房间名 · 话题前 20 字」；都为空时按建会话时的语言给默认名。 */
export function roomTaskTitle(roomName: string, topicBody: string, locale: Locale): string {
  const head = Array.from(topicBody.replace(/\s+/gu, " ").trim()).slice(0, 20).join("");
  const title = head === "" ? roomName : `${roomName} · ${head}`;
  return Array.from(title).slice(0, 300).join("") || messagesFor(locale).roomPrompt.taskTitle;
}
