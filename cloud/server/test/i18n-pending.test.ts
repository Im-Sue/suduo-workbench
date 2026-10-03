import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 中英双语迁移期的待迁移清单（工作区根目录的 eslint.i18n-pending.js）只减不增（技术设计 §五）：
 * 条数不超过上限；每个文件都还在、而且还有写死的中文——迁完了就该从清单删掉，否则 lint 会一直放过它。
 */
const WORKSPACE = new URL("../../", import.meta.url);
const { I18N_PENDING_FILES, I18N_PENDING_MAX } = (await import(
  pathToFileURL(fileURLToPath(new URL("eslint.i18n-pending.js", WORKSPACE))).href
)) as { I18N_PENDING_FILES: string[]; I18N_PENDING_MAX: number };

// 与 eslint.config.js 的检测范围一致：CJK 文字与全角标点。
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function hasCjkText(path: string): boolean {
  const text = readFileSync(path, "utf8");
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      CJK.test(node.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("中英双语待迁移清单只减不增", () => {
  it("条数不超过上限，且没有重复、按字母排序", () => {
    expect(I18N_PENDING_FILES.length).toBeLessThanOrEqual(I18N_PENDING_MAX);
    expect(new Set(I18N_PENDING_FILES).size).toBe(I18N_PENDING_FILES.length);
    expect(I18N_PENDING_FILES).toEqual([...I18N_PENDING_FILES].sort());
  });

  it("清单里的文件都还在，而且都还有写死的中文", () => {
    const missing = I18N_PENDING_FILES.filter((file) => !existsSync(fileURLToPath(new URL(file, WORKSPACE))));
    expect(missing, "这些文件已不存在，请从清单删掉").toEqual([]);
    const migrated = I18N_PENDING_FILES.filter((file) => !hasCjkText(fileURLToPath(new URL(file, WORKSPACE))));
    expect(migrated, "这些文件已经没有写死的中文，请从清单删掉并调低 I18N_PENDING_MAX").toEqual([]);
  });
});
