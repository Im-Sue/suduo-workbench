import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 英文字典的文字里不能混进中文（迁移时漏翻、复制粘贴错位）。只看字符串与模板，注释和正则不算；
 * 唯一例外是语言选项里的「简体中文」：各语言的名字按它自己的写法显示。
 */
const EN_DIRECTORY = new URL("../src/i18n/messages/en/", import.meta.url);
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const ALLOWED = new Set(["简体中文"]);

function cjkStrings(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      CJK.test(node.text) &&
      !ALLOWED.has(node.text)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("英文字典", () => {
  it("文字里没有中文", () => {
    const files = readdirSync(EN_DIRECTORY).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const offending = Object.fromEntries(
      files
        .map((file) => [file, cjkStrings(fileURLToPath(new URL(file, EN_DIRECTORY)))] as const)
        .filter(([, strings]) => strings.length > 0),
    );
    expect(offending).toEqual({});
  });
});
