import { ImageIcon, ZapIcon } from "lucide-react";
import type { ConversationMessage, MessageAttribution } from "../../../event-projection/reducer.js";
import { formatClock } from "../../../ui/format.js";
import { cn } from "@/lib/utils";

/**
 * 用户消息。归属三态只说能证实的那一种（需求 R3 / R4）：
 * 「已并入当前工作」的说明必须原样是「已记入当前正在跑的这一轮」——能证明的是这条话记进了哪一轮，
 * 不能证明模型在那一轮里读到了它，所以禁止任何「会送到」的表述。
 */
const ATTRIBUTION_LABEL: Record<MessageAttribution, string> = {
  submitted: "已提交",
  merged: "已并入当前工作",
  "new-turn": "已作为新一轮",
};
const MERGED_NOTE = "已记入当前正在跑的这一轮";
const INTERRUPTED_NOTE = "这一轮被中断，这条可能没被处理到";

export function UserBubble({ message, inline = false }: { message: ConversationMessage; inline?: boolean }) {
  return (
    <article className={cn("flex flex-col items-end gap-1", inline && "my-1")} data-testid="user-message">
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3.5 py-2 text-body break-words whitespace-pre-wrap text-foreground",
          inline ? "border border-dashed border-border-strong bg-card" : "bg-muted",
        )}
      >
        {message.skills.length > 0 ? (
          <span className="mb-1 flex flex-wrap gap-1">
            {message.skills.map((skill) => (
              <span key={skill} className="inline-flex items-center gap-1 rounded-xs bg-primary-soft px-1.5 text-caption text-primary-text">
                <ZapIcon className="size-3" aria-hidden="true" />
                {skill}
              </span>
            ))}
          </span>
        ) : null}
        {message.text}
        {message.attachments.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {message.attachments.map((attachment) => (
              <span key={attachment} className="inline-flex items-center gap-1 rounded-xs bg-card px-1.5 text-caption text-muted-foreground" data-testid="attachment-chip">
                <ImageIcon className="size-3" aria-hidden="true" />
                图片附件
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <p className="m-0 text-caption text-subtle-foreground">
        {formatClock(message.ts)} ·{" "}
        <span
          data-testid="message-attribution"
          data-attribution={message.attribution}
          title={message.attribution === "merged" ? MERGED_NOTE : undefined}
        >
          {ATTRIBUTION_LABEL[message.attribution]}
          {message.attribution === "merged" ? `（${MERGED_NOTE}）` : null}
        </span>
        {message.interruptedNote ? <span data-testid="message-interrupted-note"> · {INTERRUPTED_NOTE}</span> : null}
      </p>
    </article>
  );
}
