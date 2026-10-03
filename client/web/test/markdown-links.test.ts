import { describe, expect, it } from "vitest";
import { FileExistenceStore } from "../src/ui/file-existence.js";
import {
  markdownUrlTransform,
  normalizeRelativePath,
  pathTokenCandidates,
  resolveMarkdownLink,
  resolvePathText,
} from "../src/ui/markdown-links.js";

const ROOT = "/code/order";

describe("Markdown 链接分类（需求 4.6）", () => {
  it("网页与邮件链接照旧新标签打开；页内锚点照旧", () => {
    expect(resolveMarkdownLink("https://example.com/a?b=1", ROOT)).toEqual({ kind: "external", href: "https://example.com/a?b=1" });
    expect(resolveMarkdownLink("http://127.0.0.1:3000", ROOT)).toEqual({ kind: "external", href: "http://127.0.0.1:3000" });
    expect(resolveMarkdownLink("mailto:pm@example.com", ROOT)).toEqual({ kind: "external", href: "mailto:pm@example.com" });
    expect(resolveMarkdownLink("#user-content-fn-1", ROOT)).toEqual({ kind: "anchor", href: "#user-content-fn-1" });
  });

  it("项目内相对路径：src/a.ts、./src/a.ts，行号写法 :12、:12:5、#L12、:12-20", () => {
    expect(resolveMarkdownLink("src/a.ts", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: null });
    expect(resolveMarkdownLink("./src/a.ts", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: null });
    expect(resolveMarkdownLink("src/a.ts:12", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
    expect(resolveMarkdownLink("src/a.ts:12:5", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
    expect(resolveMarkdownLink("src/a.ts#L12", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
    expect(resolveMarkdownLink("src/a.ts#L12-L20", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
    expect(resolveMarkdownLink("src/a.ts:12-20", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
    expect(resolveMarkdownLink("README.md#安装", ROOT)).toEqual({ kind: "file", path: "README.md", line: null });
  });

  it("没有目录的文件名带行号（a.ts:12）不当成协议", () => {
    expect(resolveMarkdownLink("a.ts:12", ROOT)).toEqual({ kind: "file", path: "a.ts", line: 12 });
    expect(resolveMarkdownLink("Makefile", ROOT)).toEqual({ kind: "file", path: "Makefile", line: null });
  });

  it("项目内绝对路径换成相对路径；file:// 也认", () => {
    expect(resolveMarkdownLink("/code/order/src/a.ts", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: null });
    expect(resolveMarkdownLink("/code/order/src/a.ts:30", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: 30 });
    expect(resolveMarkdownLink("file:///code/order/src/a.ts#L7", ROOT)).toEqual({ kind: "file", path: "src/a.ts", line: 7 });
    expect(resolveMarkdownLink("/code/order/src/a.ts", "/code/order/")).toEqual({ kind: "file", path: "src/a.ts", line: null });
  });

  it("URL 编码先解码（中文、空格）", () => {
    expect(resolveMarkdownLink("docs/%E9%9C%80%E6%B1%82%20%E8%AF%B4%E6%98%8E.md:3", ROOT)).toEqual({
      kind: "file",
      path: "docs/需求 说明.md",
      line: 3,
    });
    expect(resolveMarkdownLink("/code/order/%E4%B8%AD%E6%96%87.ts", ROOT)).toEqual({ kind: "file", path: "中文.ts", line: null });
  });

  it("项目外的绝对路径、越出项目的相对路径、家目录、不认识的协议：只显示文字", () => {
    expect(resolveMarkdownLink("/etc/hosts", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("/code/order-2/a.ts", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("/Volumes/Sue-SSD/Dev/data/suduo/stack/app/requirement.md", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("../other/a.ts", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("src/../../a.ts", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("~/notes.md", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("vscode://file/code/order/a.ts", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("tel:10086", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("", ROOT)).toEqual({ kind: "text" });
    expect(resolveMarkdownLink(undefined, ROOT)).toEqual({ kind: "text" });
  });

  it("不知道项目目录时：绝对路径一律只显示文字，相对路径仍按项目内处理", () => {
    expect(resolveMarkdownLink("/code/order/src/a.ts", "")).toEqual({ kind: "text" });
    expect(resolveMarkdownLink("src/a.ts:4", "")).toEqual({ kind: "file", path: "src/a.ts", line: 4 });
  });

  it("Windows 路径", () => {
    expect(resolveMarkdownLink("C:\\work\\order\\src\\a.ts:9", "C:\\work\\order")).toEqual({ kind: "file", path: "src/a.ts", line: 9 });
    expect(resolveMarkdownLink("C:/other/a.ts", "C:\\work\\order")).toEqual({ kind: "text" });
  });

  it("相对路径规整：去掉 . 与多余斜杠，折叠 ..", () => {
    expect(normalizeRelativePath("./src//a/../b.ts")).toBe("src/b.ts");
    expect(normalizeRelativePath("..")).toBeNull();
    expect(normalizeRelativePath(".")).toBeNull();
  });

  it("地址过滤：放行带行号的文件名与相对路径，拦掉会执行脚本的协议", () => {
    expect(markdownUrlTransform("a.ts:12")).toBe("a.ts:12");
    expect(markdownUrlTransform("src/a.ts#L3")).toBe("src/a.ts#L3");
    expect(markdownUrlTransform("https://example.com")).toBe("https://example.com");
    expect(markdownUrlTransform("javascript:alert(1)")).toBe("");
    expect(markdownUrlTransform(" JavaScript:alert(1)")).toBe("");
    expect(markdownUrlTransform("data:text/html;base64,xx")).toBe("");
  });
});

describe("会话回答里的文件路径：候选识别", () => {
  it("带 / 或有扩展名、没有空白的才是候选；标识符、版本号、命令、网址不是", () => {
    expect(resolvePathText("Appreciation-admin/src/views/A.vue:401", "/p")).toEqual({
      path: "Appreciation-admin/src/views/A.vue",
      line: 401,
    });
    expect(resolvePathText("src/a.ts#L12", "/p")).toEqual({ path: "src/a.ts", line: 12 });
    expect(resolvePathText("package.json", "/p")).toEqual({ path: "package.json", line: null });
    expect(resolvePathText("/p/src/a.ts:3", "/p")).toEqual({ path: "src/a.ts", line: 3 });
    for (const text of ["receiverSnapshot", "2.0.1", "npm run build", "https://a.com/x.js", "/etc/hosts", "../x.ts", ""]) {
      expect(resolvePathText(text, "/p")).toBeNull();
    }
  });

  it("正文片段：依次尝试整段、去掉前后贴着的中文、去掉句末的点", () => {
    const candidates = pathTokenCandidates("金额在src/cart.js:16里", "/p");
    expect(candidates.map((item) => [item.before, item.text, item.after])).toEqual([
      ["", "金额在src/cart.js:16里", ""],
      ["金额在", "src/cart.js:16里", ""],
      ["", "金额在src/cart.js:16", "里"],
      ["金额在", "src/cart.js:16", "里"],
    ]);
    expect(candidates.at(-1)).toMatchObject({ path: "src/cart.js", line: 16 });
    const dotted = pathTokenCandidates("src/a.ts.", "/p");
    expect(dotted[0]).toMatchObject({ path: "src/a.ts", text: "src/a.ts", after: "." });
  });
});

describe("文件存在确认：批量、缓存与过期", () => {
  it("同一轮的请求合成一批；存在的永久缓存，不存在的 15 秒后重问；失败当作不知道", async () => {
    let now = 0;
    const calls: string[][] = [];
    let fail = false;
    const store = new FileExistenceStore(async (paths) => {
      calls.push([...paths]);
      if (fail) throw new Error("offline");
      return paths.filter((path) => path.startsWith("src/"));
    }, () => now);
    store.request("src/a.ts");
    store.request("x.ts");
    store.request("src/a.ts");
    expect(store.get("src/a.ts")).toBe("unknown");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([["src/a.ts", "x.ts"]]);
    expect(store.get("src/a.ts")).toBe("exists");
    expect(store.get("x.ts")).toBe("missing");

    store.request("src/a.ts");
    store.request("x.ts");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    now = 16_000;
    store.request("x.ts");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([["src/a.ts", "x.ts"], ["x.ts"]]);

    fail = true;
    store.request("src/b.ts");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get("src/b.ts")).toBe("unknown");
  });
});
