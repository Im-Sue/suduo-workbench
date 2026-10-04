import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_CODEX_ERRORS,
  AGENT_RUN_FAILURE_CATEGORIES,
  AGENT_RUN_REASON_CODES,
  agentRunEventsTruncatedFallback,
  agentRunProgressFallback,
  agentRunReasonFallback,
  readAgentRunProgress,
  readAgentRunReason,
  type AgentRunReason,
} from "../src/index.js";

/** 每个原因 code 的一组合法参数（带参数的给样例，其余空对象）。 */
function sampleReasons(): AgentRunReason[] {
  const samples: AgentRunReason[] = [];
  for (const code of AGENT_RUN_REASON_CODES) {
    switch (code) {
      case "local_folder_unavailable":
        samples.push({ code, params: { path: "/work/shop" } });
        break;
      case "stalled":
        samples.push({ code, params: { minutes: 20 } });
        break;
      case "local_start_failed":
      case "run_error":
      case "reply_rejected":
        samples.push({ code, params: { detail: "boom" } });
        break;
      case "turn_failed":
        for (const codexError of AGENT_RUN_CODEX_ERRORS) samples.push({ code, params: { codexError } });
        for (const category of AGENT_RUN_FAILURE_CATEGORIES) samples.push({ code, params: { category } });
        samples.push({ code, params: { detail: "boom" } }, { code, params: {} });
        break;
      default:
        samples.push({ code, params: {} });
    }
  }
  return samples;
}

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

describe("任务原因的 code 与英文兜底", () => {
  it("每个 code 都有英文兜底，不含中文，读回来与写下的一致", () => {
    for (const reason of sampleReasons()) {
      const text = agentRunReasonFallback(reason.code, reason.params);
      expect(text, reason.code).not.toBe("");
      expect(text, reason.code).not.toMatch(CJK);
      expect(readAgentRunReason(reason.code, reason.params)).toEqual(reason);
    }
  });

  it("英文措辞抽查（含单复数）", () => {
    expect(agentRunReasonFallback("owner_offline", {})).toBe("The owner is offline");
    expect(agentRunReasonFallback("stalled", { minutes: 1 })).toBe("Run interrupted: no progress for 1 minute");
    expect(agentRunReasonFallback("stalled", { minutes: 20 })).toBe("Run interrupted: no progress for 20 minutes");
    expect(agentRunReasonFallback("turn_failed", { detail: "disk full" })).toBe("The run failed: disk full");
    expect(agentRunReasonFallback("turn_failed", {})).toBe("The run failed for an unknown reason.");
  });

  it("认不出的 code、参数缺失或类型不对、取值认不出：读成 null（由前端显示原文）；多出来的参数忽略", () => {
    expect(readAgentRunReason(null, null)).toBeNull();
    expect(readAgentRunReason(undefined, undefined)).toBeNull();
    expect(readAgentRunReason("future_reason", {})).toBeNull();
    expect(readAgentRunReason("stalled", null)).toBeNull();
    expect(readAgentRunReason("stalled", { minutes: "20" })).toBeNull();
    expect(readAgentRunReason("local_folder_unavailable", { path: 1 })).toBeNull();
    expect(readAgentRunReason("turn_failed", { codexError: "somethingNew" })).toBeNull();
    expect(readAgentRunReason("turn_failed", { category: "teapot" })).toBeNull();
    expect(readAgentRunReason("turn_failed", { detail: 3 })).toBeNull();
    expect(readAgentRunReason("owner_offline", { extra: "x" })).toEqual({ code: "owner_offline", params: {} });
    expect(readAgentRunReason("turn_failed", {})).toEqual({ code: "turn_failed", params: {} });
    // 带着认不出的参数（新版本加的分支）：退回原文，不当成「原因未知」。
    expect(readAgentRunReason("turn_failed", { httpStatus: 418 })).toBeNull();
  });
});

describe("任务进度的 code 与英文兜底", () => {
  it("thinking 与按种类计数，顺序固定、单复数", () => {
    expect(agentRunProgressFallback("thinking", {})).toBe("Thinking");
    expect(agentRunProgressFallback("activity", { command: 2, read: 6 })).toBe("Read 6 files · Ran 2 commands");
    expect(agentRunProgressFallback("activity", { read: 1, search: 1, list: 1, command: 1, tool: 1, web: 1 })).toBe(
      "Read 1 file · Searched once · Listed 1 folder · Ran 1 command · Made 1 tool call · Searched the web once",
    );
    expect(agentRunProgressFallback("activity", {})).toBe("Thinking");
  });

  it("读线上的进度：认得的种类取正整数；混有认不出的种类、没有有效计数或认不出的 code 为 null", () => {
    expect(readAgentRunProgress("thinking", null)).toEqual({ code: "thinking", params: {} });
    expect(readAgentRunProgress("activity", { read: 2, command: 0, tool: "1" })).toEqual({
      code: "activity",
      params: { read: 2 },
    });
    // 新版本加的种类：只渲染认得的那部分会漏信息，退回原文。
    expect(readAgentRunProgress("activity", { read: 2, edits: 3 })).toBeNull();
    expect(readAgentRunProgress("activity", { edits: 3 })).toBeNull();
    expect(readAgentRunProgress("future_progress", { read: 1 })).toBeNull();
    expect(readAgentRunProgress(null, null)).toBeNull();
  });
});

describe("执行过程截断说明", () => {
  it("英文兜底带省略条数，单复数", () => {
    expect(agentRunEventsTruncatedFallback(1)).toBe(
      "The run details were too long, so 1 record in the middle was left out (the beginning and end are kept). The full details are in the room task session on the owner's computer.",
    );
    expect(agentRunEventsTruncatedFallback(42)).toContain("so 42 records in the middle were left out");
  });
});
