import { useEffect, useRef } from "react";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor } from "../../i18n/messages/index.js";
import type { SessionUiStatus } from "../../ui/session-status.js";

/**
 * 完成提醒（需求 §4.5）：会话在后台（标签页不可见）完成、失败或需要审批时，
 * 在浏览器标题前加前缀，并在用户已允许时发一条系统通知；回到页面后前缀自动去掉。
 * 不主动申请通知权限——是否开启由设置页决定（本机偏好 suduo.notify.system）。
 */
type AttentionStatus = "completed" | "approval" | "error";

/** 标题前缀的符号；文字按提醒时的界面语言取。 */
const MARK: Record<AttentionStatus, string> = {
  completed: "✓",
  approval: "●",
  error: "✕",
};

function isAttentionStatus(status: SessionUiStatus): status is AttentionStatus {
  return Object.hasOwn(MARK, status);
}

const NOTIFY_KEY = "suduo.notify.system";

export function systemNotifyEnabled(): boolean {
  try {
    return window.localStorage.getItem(NOTIFY_KEY) === "on";
  } catch {
    return false;
  }
}

export function useAttentionSignals(status: SessionUiStatus, sessionTitle: string | null): void {
  const previous = useRef<SessionUiStatus>(status);
  const baseTitle = useRef<string | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = status;
    if (typeof document === "undefined" || !document.hidden) return;
    // 只在状态真的变化成需要注意的样子时提醒（从运行中到结束，或新出现审批）。
    if (!isAttentionStatus(status) || before === status || (status !== "approval" && before !== "running")) return;
    const text = messagesFor(currentLocale()).conversation.attention;
    const label = text.title[status];
    baseTitle.current ??= document.title.replace(/^[✓●✕] [^·]+ · /, "");
    document.title = `${MARK[status]} ${label} · ${baseTitle.current}`;
    if (systemNotifyEnabled() && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(`${label} · ${sessionTitle ?? text.fallbackSession}`, {
          body: text.body[status],
          tag: "suduo-session",
        });
      } catch {
        // 某些环境不允许页面直接构造通知，标题前缀已足够。
      }
    }
  }, [status, sessionTitle]);

  useEffect(() => {
    const restore = () => {
      if (document.hidden || baseTitle.current === null) return;
      document.title = baseTitle.current;
      baseTitle.current = null;
    };
    document.addEventListener("visibilitychange", restore);
    return () => {
      document.removeEventListener("visibilitychange", restore);
      restore();
    };
  }, []);
}
