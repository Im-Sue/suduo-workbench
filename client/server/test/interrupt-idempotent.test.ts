import { describe, expect, it } from "vitest";
import { isTurnGoneError } from "../src/application/interrupt-service.js";

describe("isTurnGoneError（中断幂等判定）", () => {
  it("codex 报 turn 不存在/未运行 → 视为已停止", () => {
    for (const message of [
      "turn not found: t-1",
      "No active turn for thread",
      "no such turn",
      "turn is not running",
      "turn already completed",
      "Unknown turn id",
    ]) {
      expect(isTurnGoneError(new Error(message))).toBe(true);
    }
  });

  it("真实故障不吞：连接/超时类错误仍视为不确定", () => {
    for (const message of [
      "request timed out after 20000ms",
      "codex app-server exited; code=1",
      "connection closed",
    ]) {
      expect(isTurnGoneError(new Error(message))).toBe(false);
    }
  });
});
