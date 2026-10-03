// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileExistenceStore } from "../src/ui/file-existence.js";
import { Markdown } from "../src/ui/markdown.js";
import { MarkdownLinkContext } from "../src/ui/markdown-link-context.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const TEXT = [
  "看 [入口](src/views/Order.vue:88) 与 [服务](/code/order/server/Resp.java#L12)。",
  "",
  "外部：[快照](/Volumes/data/suduo/materials/requirement.md)、[网页](https://example.com)、[邮件](mailto:pm@example.com)。",
  "",
  "<!-- suduo-action {\"type\":\"fetch_attachment\",\"attachmentId\":\"a1\"} -->",
  "<b>粗</b>",
].join("\n");

const buttons = (node: HTMLElement) => [...node.querySelectorAll("button")];

describe("Markdown 渲染：注释标记与链接", () => {
  it("HTML 注释与原始 HTML 不显示", async () => {
    const node = await render(<Markdown text={TEXT} />);
    expect(node.textContent).not.toContain("suduo-action");
    expect(node.querySelector("b")).toBeNull();
  });

  it("会话页提供打开文件的处理方：项目内路径渲染成按钮，点击给出相对路径与行号", async () => {
    const onOpenPath = vi.fn();
    const node = await render(
      <MarkdownLinkContext.Provider value={{ onOpenPath, projectRoot: "/code/order" }}>
        <Markdown text={TEXT} />
      </MarkdownLinkContext.Provider>,
    );
    const [entry, service] = buttons(node).filter((button) => button.dataset["path"] !== undefined);
    expect(entry?.textContent).toBe("入口");
    expect(service?.textContent).toBe("服务");
    await act(async () => entry?.click());
    await act(async () => service?.click());
    expect(onOpenPath).toHaveBeenNthCalledWith(1, "src/views/Order.vue", 88, { external: false });
    expect(onOpenPath).toHaveBeenNthCalledWith(2, "server/Resp.java", 12, { external: false });
    // 项目外路径只有文字，没有链接；网页与邮件在新标签打开。
    const anchors = [...node.querySelectorAll("a")];
    expect(anchors.map((anchor) => [anchor.textContent, anchor.getAttribute("href"), anchor.getAttribute("target")])).toEqual([
      ["网页", "https://example.com", "_blank"],
      ["邮件", "mailto:pm@example.com", "_blank"],
    ]);
    expect(node.textContent).toContain("快照");
  });

  it("没有处理方（需求页等）：路径形状的链接都只显示文字，不生成会落到兜底页的 <a>", async () => {
    const node = await render(<Markdown text={TEXT} />);
    expect(buttons(node).filter((button) => button.dataset["path"] !== undefined)).toHaveLength(0);
    expect([...node.querySelectorAll("a")].map((anchor) => anchor.textContent)).toEqual(["网页", "邮件"]);
    expect(node.textContent).toContain("入口");
    expect(node.textContent).toContain("服务");
  });

  it("没有目录的文件名带行号（a.ts:12）不会被当成协议清空", async () => {
    const onOpenPath = vi.fn();
    const node = await render(
      <MarkdownLinkContext.Provider value={{ onOpenPath, projectRoot: "" }}>
        <Markdown text="见 [a.ts:12](a.ts:12)" />
      </MarkdownLinkContext.Provider>,
    );
    await act(async () => buttons(node).find((button) => button.textContent === "a.ts:12")?.click());
    expect(onOpenPath).toHaveBeenCalledWith("a.ts", 12, { external: false });
  });
});

describe("会话回答里的文件路径可点击：行内代码与正文", () => {
  const EXISTING = new Set([
    "Appreciation-admin/src/views/MerchantProductBusinessData.vue",
    "Appreciation-admin/src/components/MerchantOrderDetailContent.vue",
    "src/cart.js",
    "docs/02_需求设计/订单.md",
  ]);

  async function renderAnswer(text: string) {
    const onOpenPath = vi.fn();
    const asked: string[][] = [];
    const files = new FileExistenceStore(async (paths) => {
      asked.push([...paths]);
      return paths.filter((path) => EXISTING.has(path));
    });
    const node = await render(
      <MarkdownLinkContext.Provider value={{ onOpenPath, projectRoot: "/code/shop", files }}>
        <Markdown text={text} />
      </MarkdownLinkContext.Provider>,
    );
    // 等批量确认回来、再渲染一轮。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const links = () => buttons(node).filter((button) => button.dataset["path"] !== undefined);
    return { node, onOpenPath, asked, links };
  }

  it("行内代码里存在的文件变成链接（保留代码样式），点击带上行号；不是文件的行内代码不变", async () => {
    const { onOpenPath, links, asked } = await renderAnswer(
      "入口是 `Appreciation-admin/src/views/MerchantProductBusinessData.vue:401`，详情在 " +
        "`Appreciation-admin/src/components/MerchantOrderDetailContent.vue:1`。已有 `receiverSnapshot`，`order.total` 未返回。",
    );
    expect(links().map((link) => [link.dataset["path"], link.dataset["line"]])).toEqual([
      ["Appreciation-admin/src/views/MerchantProductBusinessData.vue", "401"],
      ["Appreciation-admin/src/components/MerchantOrderDetailContent.vue", "1"],
    ]);
    expect(links()[0]?.querySelector("code")?.textContent).toBe("Appreciation-admin/src/views/MerchantProductBusinessData.vue:401");
    // receiverSnapshot 不是候选，不去问；order.total 是候选但不存在。
    expect(asked.flat()).not.toContain("receiverSnapshot");
    expect(asked.flat()).toContain("order.total");
    // 同一轮渲染的路径一批问完。
    expect(asked).toHaveLength(1);
    await act(async () => links()[0]?.click());
    expect(onOpenPath).toHaveBeenCalledWith("Appreciation-admin/src/views/MerchantProductBusinessData.vue", 401, { external: false });
  });

  it("正文里的路径（中文贴着写也行）确认存在后变成链接，前后的中文原样保留；⌘ 点击用编辑器打开", async () => {
    const { node, onOpenPath, links } = await renderAnswer("金额在src/cart.js:16里算，说明见 docs/02_需求设计/订单.md。不存在的 src/nope.ts 不变。");
    expect(links().map((link) => link.textContent)).toEqual(["src/cart.js:16", "docs/02_需求设计/订单.md"]);
    expect(node.textContent).toContain("金额在src/cart.js:16里算");
    expect(node.textContent).toContain("订单.md。不存在的 src/nope.ts 不变");
    await act(async () => {
      links()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    });
    expect(onOpenPath).toHaveBeenCalledWith("src/cart.js", 16, { external: true });
  });

  it("代码块里的路径不处理；项目外的绝对路径不是候选", async () => {
    const { links, asked } = await renderAnswer("```\nsrc/cart.js:16\n```\n\n见 `/etc/hosts` 与 /Users/x/a.ts");
    expect(links()).toHaveLength(0);
    expect(asked.flat()).toEqual([]);
  });

  it("没有提供文件存在确认（需求页、房间）时，行内代码与正文都不识别", async () => {
    const node = await render(
      <MarkdownLinkContext.Provider value={{ onOpenPath: vi.fn(), projectRoot: "/code/shop" }}>
        <Markdown text="入口 `src/cart.js:16` 与 src/cart.js" />
      </MarkdownLinkContext.Provider>,
    );
    expect(buttons(node).filter((button) => button.dataset["path"] !== undefined)).toHaveLength(0);
  });
});
