import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/feedback/classify.js";
import {
  FEEDBACK_ROUTES,
  GLOBAL_ERROR_TOAST_DURATION_MS,
  routeFeedback,
} from "../src/feedback/routes.js";
import { FAILURE_KINDS, FEEDBACK_SURFACES } from "../src/feedback/types.js";

describe("routeFeedback", () => {
  it("FailureKind x FeedbackSurface 矩阵没有空洞", () => {
    expect(GLOBAL_ERROR_TOAST_DURATION_MS).toBe(8_000);
    for (const kind of FAILURE_KINDS) {
      for (const surface of FEEDBACK_SURFACES) {
        const route = FEEDBACK_ROUTES[kind][surface];
        expect(route.outlet).toBeTruthy();
        expect(route.durationMs).toBeGreaterThanOrEqual(0);
        if (route.outlet === "global") {
          expect(route.durationMs).toBe(GLOBAL_ERROR_TOAST_DURATION_MS);
        }
      }
    }
  });

  it("复现设计 3b~3f 的五条失败锚点", () => {
    expect(routeFeedback(classifyFailure({ status: 409, code: "VERSION_CONFLICT" }), { surface: "action" }))
      .toMatchObject({
        outlet: "global",
        durationMs: GLOBAL_ERROR_TOAST_DURATION_MS,
        politeness: "assertive",
      });
    expect(routeFeedback(classifyFailure({ status: 400, code: "VALIDATION_ERROR" }), { surface: "field" }))
      .toMatchObject({ outlet: "field" });
    expect(routeFeedback(classifyFailure({ status: 502, code: "DEPENDENCY_UNAVAILABLE" }), { surface: "region" }))
      .toMatchObject({ outlet: "region" });
    expect(routeFeedback(classifyFailure({ status: 409, code: "AUTH_INVALID" }), { surface: "action" }))
      .toMatchObject({ outlet: "page" });
    expect(routeFeedback(classifyFailure(new DOMException("cancelled", "AbortError")), { surface: "action" }))
      .toMatchObject({ outlet: "silent" });
    expect(routeFeedback(classifyFailure({ status: 401, code: "AUTH_INVALID" }), { surface: "realtime" }))
      .toMatchObject({ outlet: "page" });
    expect(routeFeedback(classifyFailure({ status: 502, code: "DEPENDENCY_UNAVAILABLE" }), { surface: "realtime" }))
      .toMatchObject({ outlet: "silent" });
  });
});
