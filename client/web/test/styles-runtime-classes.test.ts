import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 有些类名是运行时由第三方生成的（rehype-highlight 的 hljs-*），源码里搜不到。
 * 按「源码没引用就删」清理旧样式时容易误删，这里钉住。
 */
describe("运行时生成的类名仍有样式", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

  it("代码高亮 hljs-* 的配色在", () => {
    for (const name of ["hljs-comment", "hljs-keyword", "hljs-string", "hljs-number", "hljs-title", "hljs-attr"]) {
      expect(css).toContain(`.${name}`);
    }
  });

  it("Markdown 渲染的容器样式在", () => {
    for (const name of [".md ", ".md-code", ".md-code-bar", ".md-table-wrap"]) {
      expect(css).toContain(name);
    }
  });
});
