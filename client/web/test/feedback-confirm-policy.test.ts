import { describe, expect, it } from "vitest";
import { CONFIRMATION_OPERATIONS, needsConfirm } from "../src/feedback/confirm-policy.js";

describe("needsConfirm", () => {
  it("所有危险动作保留确认，纯信息动作不阻塞", () => {
    for (const operation of CONFIRMATION_OPERATIONS) {
      expect(needsConfirm(operation)).toBe(true);
    }
    expect(needsConfirm({ operation: "save", irreversible: false, impact: "local", recovery: "easy" })).toBe(false);
  });
});
