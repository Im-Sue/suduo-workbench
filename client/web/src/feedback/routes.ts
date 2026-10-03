import {
  FAILURE_KINDS,
  FEEDBACK_SURFACES,
  type Failure,
  type FailureKind,
  type FeedbackContext,
  type FeedbackRoute,
  type FeedbackSurface,
} from "./types.js";

/** 错误 toast 的实际停留时间；路由和渲染必须使用同一值。 */
export const GLOBAL_ERROR_TOAST_DURATION_MS = 8_000;

/** 统一 loading 阈值；组件与域页面不得各自再定义。 */
export const FEEDBACK_TIMING_MS = {
  actionBusy: 0,
  initialSkeleton: 0,
  backgroundRefresh: 150,
  stillProcessing: 1_000,
  blocking: 2_000,
} as const;

const route = (
  outlet: FeedbackRoute["outlet"],
  durationMs: number,
  politeness: FeedbackRoute["politeness"],
): FeedbackRoute => ({ outlet, durationMs, politeness });

function routeFor(kind: FailureKind, surface: FeedbackSurface): FeedbackRoute {
  if (kind === "cancelled") return route("silent", 0, "off");
  if (kind === "auth_expired") return route("page", 0, "assertive");
  if (surface === "realtime") return route("silent", 0, "off");
  if (surface === "boundary") return route("boundary", 0, "assertive");
  if (kind === "not_configured") {
    return surface === "field" ? route("field", 0, "assertive") : route("page", 0, "assertive");
  }
  if (surface === "page") return route("page", 0, "assertive");
  if (surface === "region") return route("region", 0, "assertive");
  if (kind === "validation" && surface === "field") return route("field", 0, "assertive");
  return route("global", GLOBAL_ERROR_TOAST_DURATION_MS, "assertive");
}

/** 每个 FailureKind x FeedbackSurface 均有明确路线，禁止域页面自行补洞。 */
export const FEEDBACK_ROUTES: Record<FailureKind, Record<FeedbackSurface, FeedbackRoute>> =
  Object.fromEntries(
    FAILURE_KINDS.map((kind) => [
      kind,
      Object.fromEntries(FEEDBACK_SURFACES.map((surface) => [surface, routeFor(kind, surface)])),
    ]),
  ) as Record<FailureKind, Record<FeedbackSurface, FeedbackRoute>>;

export function routeFeedback(failure: Failure, context: FeedbackContext): FeedbackRoute {
  return FEEDBACK_ROUTES[failure.kind][context.surface];
}
