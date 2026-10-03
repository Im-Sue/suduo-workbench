import { useSyncExternalStore, type ReactElement } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/toaster";
import { PageFailure } from "../feedback/components/index.js";
import {
  getPageFeedbackSnapshot,
  subscribePageFeedback,
} from "../feedback/page-store.js";
import { GLOBAL_ERROR_TOAST_DURATION_MS } from "../feedback/routes.js";
import type { MessageFeedbackKind, FailureKind } from "../feedback/types.js";

/**
 * 全局提示：sonner 薄封装（UI/UX 重设计 P0 起替换 react-hot-toast）。
 * 右下角、自动消失、悬停暂停、最多 3 条；样式走语义令牌，亮暗自适配。
 * 调用方只依赖 showMessage()——底层实现可再换，API 不变。
 * 规则：结果在原地可见时不弹提示；需要用户动手的问题用 Banner，不用 toast。
 */

export type MessageType = MessageFeedbackKind;

const MESSAGE_DURATION_MS = 5_000;

export interface MessageOptions {
  /** 同 id 的提示只刷新已有那条，不叠加新条（断连风暴等重复告警场景）。 */
  id?: string;
  /** 错误已被分类时，覆盖 MessageType 默认的 data-feedback-kind。 */
  feedbackKind?: FailureKind;
  /** 提示里的一个跟进动作（如「会话已就绪 · 进入」）。 */
  action?: { label: string; onClick(): void };
}

export function showMessage(
  text: string | ReactElement,
  type: MessageType = "info",
  options: MessageOptions = {},
): void {
  const feedbackKind = options.feedbackKind ?? type;
  const content = (
    <span
      data-feedback-kind={feedbackKind}
      data-feedback-result="global"
      data-testid="global-message"
      role={type === "error" ? "alert" : undefined}
    >
      {text}
    </span>
  );
  const shared = {
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.action === undefined ? {} : { action: options.action }),
  };
  if (type === "success") {
    toast.success(content, { ...shared, duration: MESSAGE_DURATION_MS });
    return;
  }
  if (type === "error") {
    toast.error(content, { ...shared, duration: GLOBAL_ERROR_TOAST_DURATION_MS });
    return;
  }
  if (type === "warning") {
    toast.warning(content, { ...shared, duration: MESSAGE_DURATION_MS, icon: <AlertTriangleIcon /> });
    return;
  }
  toast(content, { ...shared, duration: MESSAGE_DURATION_MS });
}

/** 页面级失败的展示参数（去登录 / 重试）；外壳用它把失败页放进内容区，而不是叠在页面之外。 */
export function usePageFailureProps() {
  const { pageFeedback, authExpiredHandler } = useSyncExternalStore(
    subscribePageFeedback,
    getPageFeedbackSnapshot,
    getPageFeedbackSnapshot,
  );
  return pageFeedback === null
    ? null
    : pageFeedback.failure.kind === "auth_expired"
      ? authExpiredHandler === null
        ? { failure: pageFeedback.failure, route: pageFeedback.route, actionLabel: "去登录" }
        : {
            failure: pageFeedback.failure,
            route: pageFeedback.route,
            actionLabel: "去登录",
            onAction: authExpiredHandler,
          }
      : pageFeedback.retry === undefined
        ? { failure: pageFeedback.failure, route: pageFeedback.route }
        : { failure: pageFeedback.failure, route: pageFeedback.route, onAction: pageFeedback.retry };
}

/** 页面级失败出口：放在内容区里，出现时替代内容。 */
export function PageFailureOutlet() {
  const props = usePageFailureProps();
  return props === null ? null : <PageFailure {...props} />;
}

/**
 * 全局提示宿主。pageFailure=false 时只挂 toast（外壳自己在内容区放 PageFailureOutlet）。
 */
export function MessageHost({ pageFailure = true }: { pageFailure?: boolean } = {}) {
  return (
    <>
      {pageFailure ? <PageFailureOutlet /> : null}
      <Toaster />
    </>
  );
}
