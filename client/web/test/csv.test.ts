import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/ui/csv.js";

describe("parseCsv", () => {
  it("基本行列", () => {
    const result = parseCsv("a,b,c\n1,2,3");
    expect(result.rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    expect(result.truncatedRows).toBe(false);
  });

  it("引号包裹的逗号、换行与转义引号", () => {
    const result = parseCsv('名称,"备注,含逗号","多\n行"\n"说""引号""",x,y');
    expect(result.rows[0]).toEqual(["名称", "备注,含逗号", "多\n行"]);
    expect(result.rows[1]?.[0]).toBe('说"引号"');
  });

  it("CRLF 与空行", () => {
    const result = parseCsv("a,b\r\n\r\n1,2\r\n");
    expect(result.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("行数封顶", () => {
    const text = Array.from({ length: 60 }, (_, index) => `r${String(index)}`).join("\n");
    const result = parseCsv(text, 50);
    expect(result.rows).toHaveLength(50);
    expect(result.truncatedRows).toBe(true);
  });
});
