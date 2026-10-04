import { ImageIcon, ZapIcon } from "lucide-react";
import type { ConversationMessage } from "../../../event-projection/reducer.js";
import { useT } from "../../../i18n/provider.js";
import { formatClock } from "../../../ui/format.js";
import { cn } from "@/lib/utils";

/**
 * 用户消息。归属三态只说能证实的那一种（需求 R3 / R4）：
 * 「已并入当前工作」的说明必须原样是「已记入当前正在跑的这一轮」——能证明的是这条话记进了哪一轮，
 * 不能证明模型在那一轮里读到了它，所以禁止任何「会送到」的表述（文字在字典 conversation.message）。
 */
export function UserBubble({ message, inline = false }: { message: ConversationMessage; inline?: boolean }) {
  const text = useT().conversation.message;
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
                {text.imageAttachment}
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
          title={message.attribution === "merged" ? text.mergedNote : undefined}
        >
          {text.attribution[message.attribution]}
          {message.attribution === "merged" ? text.mergedSuffix(text.mergedNote) : null}
        </span>
        {message.interruptedNote ? <span data-testid="message-interrupted-note"> · {text.interruptedNote}</span> : null}
      </p>
    </article>
  );
}
