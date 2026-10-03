import { currentLocale } from "../i18n/locale.js";
import { messagesFor } from "../i18n/messages/index.js";
import { showMessage } from "../ui/message.js";
import { classifyFailure } from "./classify.js";
import {
  getAuthExpiredHandler,
  publishPageFeedback,
  registerAuthExpiredHandler,
} from "./page-store.js";
import { routeFeedback } from "./routes.js";
import type { Failure, FeedbackContext, FeedbackRoute } from "./types.js";

export { registerAuthExpiredHandler };

export interface ReportResult {
  failure: Failure;
  route: FeedbackRoute;
}

export function reportFailure(cause: unknown, context: FeedbackContext): ReportResult {
  const failure = classifyFailure(cause);
  const route = routeFeedback(failure, context);
  if (route.outlet === "global") {
    const text = messagesFor(currentLocale()).feedback;
    showMessage(
      context.title === undefined ? failure.message : text.titled(context.title, failure.message),
      "error",
      {
        feedbackKind: failure.kind,
        ...(context.id === undefined ? {} : { id: context.id }),
        // 全局提示带「重试」（技术设计 §6.2）；页面级失败的重试由失败页自己的按钮承担。
        ...(context.retry === undefined ? {} : { action: { label: text.retry, onClick: context.retry } }),
      },
    );
  } else if (route.outlet === "page") {
    publishPageFeedback({ failure, route, retry: context.retry });
    if (
      failure.kind === "auth_expired" &&
      getAuthExpiredHandler() === null &&
      import.meta.env.DEV
    ) {
      console.warn("[feedback] auth-expired handler is not registered");
    }
  }
  return { failure, route };
}
