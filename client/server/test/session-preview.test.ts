import { describe, expect, it } from "vitest";
import {
  SESSION_PREVIEW_MAX_CHARS,
  normalizePreviewText,
  sessionMessagePreview,
} from "../src/application/session-preview.js";

describe("会话列表预览规整", () => {
  it("折叠所有空白并去首尾空白", () => {
    expect(normalizePreviewText("  第一行\n\n  第二行\t\t结尾  ")).toBe("第一行 第二行 结尾");
  });

  it("超过 120 字按字符截断并加省略号；emoji 不被拆半；结果幂等", () => {
    const long = "中".repeat(SESSION_PREVIEW_MAX_CHARS + 30);
    const cut = normalizePreviewText(long);
    expect(Array.from(cut)).toHaveLength(SESSION_PREVIEW_MAX_CHARS + 1);
    expect(cut.endsWith("…")).toBe(true);
    expect(normalizePreviewText(cut)).toBe(cut);

    const emoji = "😀".repeat(SESSION_PREVIEW_MAX_CHARS + 1);
    const emojiCut = normalizePreviewText(emoji);
    expect(Array.from(emojiCut).slice(0, -1).every((character) => character === "😀")).toBe(true);
    expect(normalizePreviewText("短句")).toBe("短句");
  });

  it("用户消息取文本段；纯图片 / 纯 skill 不产生预览", () => {
    expect(
      sessionMessagePreview({
        type: "message.submitted",
        payload: {
          content: [
            { type: "text", text: "请看\n这张图" },
            { type: "local-image", attachmentId: "a.png" },
            { type: "text", text: "并总结" },
          ],
          clientTurnId: "x",
        },
      }),
    ).toEqual({ role: "user", text: "请看 这张图 并总结" });
    expect(
      sessionMessagePreview({
        type: "message.submitted",
        payload: { content: [{ type: "skill", name: "req", path: "/p/SKILL.md" }] },
      }),
    ).toBeNull();
  });

  it("助手回复只认 item.completed 的 agentMessage 完整正文", () => {
    expect(
      sessionMessagePreview({
        type: "item.completed",
        payload: { item: { type: "agentMessage", id: "m", text: "  完成了。\n\n共改 3 个文件  " } },
      }),
    ).toEqual({ role: "assistant", text: "完成了。 共改 3 个文件" });
    expect(sessionMessagePreview({ type: "item.completed", payload: { item: { type: "reasoning", summary: ["x"] } } })).toBeNull();
    expect(sessionMessagePreview({ type: "message.delta", payload: { text: "增量", itemId: "m" } })).toBeNull();
    expect(sessionMessagePreview({ type: "item.completed", payload: { item: { type: "agentMessage", text: "   " } } })).toBeNull();
  });
});
