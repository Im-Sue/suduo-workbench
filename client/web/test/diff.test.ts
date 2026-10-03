import { describe, expect, it } from "vitest";
import { computeDiff } from "../src/ui/diff.js";

describe("computeDiff", () => {
  it("识别中段单行修改并给出正确行号", () => {
    const result = computeDiff("a\nb\nc", "a\nB\nc");
    expect(result.mode).toBe("unified");
    if (result.mode !== "unified") {
      return;
    }
    expect(result.adds).toBe(1);
    expect(result.dels).toBe(1);
    const del = result.rows.find((row) => row.kind === "del");
    const add = result.rows.find((row) => row.kind === "add");
    expect(del).toMatchObject({ text: "b", beforeLine: 2, afterLine: null });
    expect(add).toMatchObject({ text: "B", beforeLine: null, afterLine: 2 });
  });

  it("新建文件全部为新增行", () => {
    const result = computeDiff("", "x\ny");
    expect(result.mode).toBe("unified");
    if (result.mode !== "unified") {
      return;
    }
    expect(result.adds).toBe(2);
    expect(result.dels).toBe(0);
    expect(result.rows.every((row) => row.kind === "add")).toBe(true);
    expect(result.rows[1]).toMatchObject({ afterLine: 2 });
  });

  it("删除文件全部为删除行", () => {
    const result = computeDiff("x\ny", "");
    expect(result.mode).toBe("unified");
    if (result.mode !== "unified") {
      return;
    }
    expect(result.adds).toBe(0);
    expect(result.dels).toBe(2);
    expect(result.rows.every((row) => row.kind === "del")).toBe(true);
  });

  it("内容一致时无增删", () => {
    const result = computeDiff("a\nb", "a\nb");
    expect(result.mode).toBe("unified");
    if (result.mode !== "unified") {
      return;
    }
    expect(result.adds).toBe(0);
    expect(result.dels).toBe(0);
    expect(result.rows.filter((row) => row.kind === "hunk")).toHaveLength(0);
  });

  it("CRLF 与 LF 不产生虚假差异", () => {
    const result = computeDiff("a\r\nb\r\nc", "a\nb\nc");
    expect(result.mode).toBe("unified");
    if (result.mode !== "unified") {
      return;
    }
    expect(result.adds).toBe(0);
    expect(result.dels).toBe(0);
  });

  it("远离改动的 context 折叠为 hunk 行", () => {
    const before = Array.from({ length: 60 }, (_, index) => `line-${String(index)}`);
    const after = [...before];
    after[30] = "CHANGED";
    const result = computeDiff(before.join("\n"), after.join("\n"));
    expect(result.mode).toBe("unified");
    if (result.mode !== "unified") {
      return;
    }
    expect(result.rows.some((row) => row.kind === "hunk")).toBe(true);
    expect(result.rows.length).toBeLessThan(before.length);
  });

  it("超过复杂度上限自动降级为双列", () => {
    const before = Array.from({ length: 2100 }, (_, index) => `a-${String(index)}`);
    const after = Array.from({ length: 2100 }, (_, index) => `b-${String(index)}`);
    const result = computeDiff(before.join("\n"), after.join("\n"));
    expect(result.mode).toBe("split");
    if (result.mode !== "split") {
      return;
    }
    expect(result.before).toHaveLength(2100);
    expect(result.after).toHaveLength(2100);
  });
});
