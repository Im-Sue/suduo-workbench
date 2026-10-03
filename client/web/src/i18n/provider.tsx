import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { useLocale } from "./locale.js";
import { messagesFor, type Messages } from "./messages/index.js";

/** 当前语言的字典：`const t = useT(); t.sessions.checkpoints.turnStart`。 */
export function useT(): Messages {
  return messagesFor(useLocale());
}

/**
 * 语言切换时：按新语言重建整棵界面（不订阅语言的组件与格式化函数也跟着变），
 * 并让所有查询重取，已经显示的服务端文字随之换成新语言（技术设计 §三）。
 */
export function LocaleBoundary({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const queryClient = useQueryClient();
  const previous = useRef(locale);
  useEffect(() => {
    if (previous.current === locale) return;
    previous.current = locale;
    void queryClient.invalidateQueries();
  }, [locale, queryClient]);
  return <Fragment key={locale}>{children}</Fragment>;
}
