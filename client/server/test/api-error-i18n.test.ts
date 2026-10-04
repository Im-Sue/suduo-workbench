import { describe, expect, it } from "vitest";
import { ApiError, IndeterminateOperationError, errorResponse, errorTextOf, renderText } from "../src/application/api-error.js";
import { messagesFor } from "../src/i18n/messages/index.js";

describe("报错说明按语言生成", () => {
  const error = new ApiError(500, "RUNTIME_REQUEST_FAILED", (t) => t.common.internalError, { id: "x" });

  it("Error.message 固定为中文，返回给界面时按请求语言", () => {
    expect(error.message).toBe(messagesFor("zh-CN").common.internalError);
    expect(error.localizedMessage("en")).toBe(messagesFor("en").common.internalError);
    expect(errorResponse(error, "req-1", "en")).toEqual({
      error: {
        code: "RUNTIME_REQUEST_FAILED",
        message: messagesFor("en").common.internalError,
        requestId: "req-1",
        details: { id: "x" },
      },
    });
    // 没给语言时与 Error.message 一致（旧调用方行为不变）。
    expect(errorResponse(error, "req-1").error.message).toBe(error.message);
  });

  it("固定文字两种语言都原样返回", () => {
    const plain = new ApiError(400, "VALIDATION_ERROR", "codex: invalid flag");
    expect(plain.message).toBe("codex: invalid flag");
    expect(plain.localizedMessage("en")).toBe("codex: invalid flag");
    expect(renderText("raw", messagesFor("en"))).toBe("raw");
  });

  it("拼进另一段说明：ApiError 跟着字典走，其它错误用原文", () => {
    const en = messagesFor("en");
    expect(errorTextOf(error)(en)).toBe(en.common.internalError);
    const indeterminate = new IndeterminateOperationError((t) => t.common.internalError);
    expect(indeterminate.message).toBe(messagesFor("zh-CN").common.internalError);
    expect(errorTextOf(indeterminate)(en)).toBe(en.common.internalError);
    expect(errorTextOf(new Error("ECONNREFUSED"))(en)).toBe("ECONNREFUSED");
    expect(errorTextOf("boom")(en)).toBe("boom");
  });
});
