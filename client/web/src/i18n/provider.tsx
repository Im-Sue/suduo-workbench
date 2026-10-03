import type { Locale, LocalePreference } from "@suduo/client-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { currentLocale, currentLocalePreference, subscribeLocale } from "./locale.js";
import { messagesFor, type Messages } from "./messages/index.js";

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, currentLocale, currentLocale);
}

export function useLocalePreference(): LocalePreference {
  return useSyncExternalStore(subscribeLocale, currentLocalePreference, currentLocalePreference);
}

/** 当前语言的字典：`const t = useT(); t.sessions.checkpoints.turnStart`。 */
export function useT(): Messages {
  return messagesFor(useLocale());
}

/**
 * 语言切换时：按新语言重建整棵界面（不订阅语言的组件与格式化函数也跟着变），
 * 并让所有查询重取，已经显示的服务端文字随之换成新语言（技术设计 §三）。
 * 重建会丢掉组件内的状态（输入框草稿、打开的对话框），加切换入口时要提示或先保存草稿。
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
