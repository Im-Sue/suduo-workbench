import { BotIcon, UsersIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../../requirements/components/UserAvatar.js";
import { agentAvailabilityNote, type MentionCandidate } from "../model.js";
import { AgentAvatar } from "./MessageItem.js";

/**
 * @ 选择框（需求十一）：真人在前，Agent 在后；不可用的 Agent 置灰并说明原因（离线 / 未共享 → 申请共享）。
 * 离线但已共享到本房间的 Agent 置灰标「离线」仍可选（模拟示例第 8 步 / R11），当前项是它时底部提示不会执行、之后可重试。
 * 焦点留在输入框里，用 aria-activedescendant 指向当前项；↑↓ 选择、回车确认、Esc 关闭。
 */
export function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/** 离线 Agent 的提示：@ 了照样发出，消息下显示「离线，未执行」（离线不补跑，需求 R11），触发人之后可以重试。 */
export const OFFLINE_AGENT_HINT = "离线时 @ 不会执行，之后可在消息上重试";

/**
 * 这个候选能不能选。已共享到本房间的 Agent 离线也能选（插入 @，服务端记一条「离线，未执行」的任务）；
 * 未共享且可以申请的 Agent 选中 = 申请共享（不插入）；自己的没共享、已申请过的不能选。
 */
export function candidateSelectable(candidate: MentionCandidate): boolean {
  if (candidate.kind !== "agent") return true;
  if (candidate.availability === "available" || candidate.availability === "offline") return true;
  return !candidate.mine && !candidate.requested;
}

function isOfflineAgent(candidate: MentionCandidate | undefined): boolean {
  return candidate?.kind === "agent" && candidate.availability === "offline";
}

export function MentionPicker({
  id,
  candidates,
  activeIndex,
  loading,
  onPick,
  onHover,
}: {
  id: string;
  candidates: readonly MentionCandidate[];
  activeIndex: number;
  loading: boolean;
  onPick(candidate: MentionCandidate): void;
  onHover(index: number): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.getElementById(optionId(id, activeIndex));
    if (active !== null && listRef.current?.contains(active) === true && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, id]);

  const people = candidates.filter((candidate) => candidate.kind !== "agent");
  const agents = candidates.filter((candidate) => candidate.kind === "agent");
  const indexOf = (candidate: MentionCandidate) => candidates.indexOf(candidate);
  const hintId = `${id}-hint`;
  const showOfflineHint = isOfflineAgent(candidates[activeIndex]);

  const renderOption = (candidate: MentionCandidate) => {
    const index = indexOf(candidate);
    const selectable = candidateSelectable(candidate);
    const usable = candidate.kind !== "agent" || candidate.availability === "available";
    const offline = isOfflineAgent(candidate);
    return (
      <div
        key={`${candidate.kind}:${candidate.id ?? "all"}`}
        id={optionId(id, index)}
        role="option"
        aria-selected={index === activeIndex}
        aria-disabled={selectable ? undefined : "true"}
        aria-describedby={offline && index === activeIndex ? hintId : undefined}
        title={offline ? OFFLINE_AGENT_HINT : undefined}
        data-testid="mention-option"
        data-kind={candidate.kind}
        data-availability={candidate.kind === "agent" ? candidate.availability : "available"}
        className={cn(
          "flex h-9 cursor-pointer items-center gap-2 rounded-sm px-2 text-small text-foreground",
          index === activeIndex && "bg-popover-hover",
          !usable && "text-subtle-foreground",
          !selectable && "cursor-not-allowed",
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          onPick(candidate);
        }}
        onMouseEnter={() => onHover(index)}
      >
        {candidate.kind === "user" ? (
          <span className="relative">
            <UserAvatar user={candidate.user} />
            {candidate.online ? <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-success ring-2 ring-popover" aria-hidden="true" /> : null}
          </span>
        ) : candidate.kind === "all" ? (
          <UsersIcon className="size-4 text-subtle-foreground" aria-hidden="true" />
        ) : (
          <span className={cn(!usable && "opacity-50")}>
            <AgentAvatar owner={candidate.agent.owner} size="md" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {candidate.kind === "agent" ? candidate.agent.label : candidate.text}
        </span>
        <span className="shrink-0 text-caption text-subtle-foreground">
          {candidate.kind === "user"
            ? candidate.online
              ? "在线"
              : ""
            : candidate.kind === "all"
              ? "提醒所有人，不唤起 Agent"
              : agentAvailabilityNote(candidate)}
        </span>
      </div>
    );
  };

  return (
    <div
      className="absolute right-2 bottom-[calc(100%+6px)] left-2 z-30 flex flex-col overflow-hidden rounded-md border border-border bg-popover shadow-3"
      data-testid="mention-picker"
    >
      <div ref={listRef} id={id} role="listbox" aria-label="选择要 @ 的人或 Agent" className="max-h-72 overflow-y-auto p-1">
        {people.length > 0 ? (
          <div role="group" aria-label="成员">
            <div className="px-2 pt-1 pb-0.5 text-caption font-medium text-subtle-foreground" aria-hidden="true">成员</div>
            {people.map(renderOption)}
          </div>
        ) : null}
        {agents.length > 0 ? (
          <div role="group" aria-label="Agent">
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-caption font-medium text-subtle-foreground" aria-hidden="true">
              <BotIcon className="size-3" />
              Agent
            </div>
            {agents.map(renderOption)}
          </div>
        ) : null}
        {candidates.length === 0 ? (
          <div className="px-2 py-2 text-small text-subtle-foreground" role="presentation">
            {loading ? "正在加载成员…" : "没有匹配的人或 Agent"}
          </div>
        ) : null}
      </div>
      {showOfflineHint ? (
        <p id={hintId} className="m-0 border-t border-border px-3 py-1.5 text-caption text-subtle-foreground">
          {OFFLINE_AGENT_HINT}
        </p>
      ) : null}
    </div>
  );
}
