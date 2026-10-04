import type { Locale, LocalePreference } from "@suduo/client-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  dropCarried,
  finishLocaleRebuild,
  peekCarried,
  registerCarrySource,
  registerLocaleBoundary,
  registerLossCheck,
} from "./carry.js";
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
 * 重建会清掉组件内的状态：要保住的（输入框草稿、排队的消息）用 useCarrySource / useCarried 带过去；
 * 保不住的（打开的对话框、没保存的表单）用 useLossCheck 登记：设置里切换前先问，别的标签页切换时先不跟（carry.ts）。
 * 事件流（EventSource）随重建按新语言重连，地址上带 `?locale=`（locale.ts 的 withLocaleParam）。
 */
export function LocaleBoundary({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const queryClient = useQueryClient();
  const previous = useRef(locale);
  useEffect(() => registerLocaleBoundary(), []);
  useEffect(() => {
    // 重建结束（不再算「正在重建」，丢掉没被读走的快照）。同一次提交里，旧界面的卸载清理先于新界面的挂载 effect，
    // 这个 effect 又排在子组件的挂载 effect 之后；但开发模式下 StrictMode 还会在这之后、同一个任务里把新挂上的
    // effect 卸载再挂载一遍，所以放进微任务，等这些都跑完再结束。放在判断前面：语言来回切、最后没变也要结束。
    queueMicrotask(finishLocaleRebuild);
    if (previous.current === locale) return;
    previous.current = locale;
    void queryClient.invalidateQueries();
  }, [locale, queryClient]);
  return <Fragment key={locale}>{children}</Fragment>;
}

/**
 * 重建前登记的快照，重建后读回（只在挂载时读一次；没有时为 undefined）。
 * 与 useCarrySource 用同一个 key，key 里要带上区分对象的东西（会话 id、房间 id）。
 */
export function useCarried<T>(key: string): T | undefined {
  const [value] = useState(() => peekCarried<T>(key));
  useEffect(() => dropCarried(key), [key]);
  return value;
}

/** 登记要带过语言切换的状态：snapshot 每次渲染都换成最新的，切换前由 locale.ts 统一调用。 */
export function useCarrySource(key: string, snapshot: () => unknown): void {
  const latest = useRef(snapshot);
  useLayoutEffect(() => {
    latest.current = snapshot;
  });
  useEffect(() => registerCarrySource(key, () => latest.current()), [key]);
}

/**
 * 登记「现在切换语言会丢东西」：为 true（或函数返回 true）期间，设置里切换语言会先确认，
 * 别的标签页切换时这里先不跟。传函数时在需要判断的那一刻才调用（可以看 DOM）。
 */
export function useLossCheck(active: boolean | (() => boolean)): void {
  const latest = useRef(active);
  useLayoutEffect(() => {
    latest.current = active;
  });
  useEffect(
    () =>
      registerLossCheck(() => {
        const current = latest.current;
        return typeof current === "function" ? current() : current;
      }),
    [],
  );
}
