/**
 * Markdown 里的 @ 高亮（房间消息）：把正文文字节点里的「@名字」拆出来，包成带样式的 span。
 * 只处理普通文字，代码块 / 行内代码 / 链接文字不动；不依赖 unist-util-visit，自己走一遍树。
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

export const MENTION_CLASS = "rounded-xs bg-primary-soft px-0.5 font-medium text-primary-text";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function remarkMentions(names: readonly string[]) {
  const usable = names.filter((name) => name.trim() !== "");
  const pattern = usable.length === 0 ? null : new RegExp(`@(?:${usable.map(escapeRegExp).join("|")})`, "g");
  return () => (tree: unknown) => {
    if (pattern !== null) walk(tree as MdNode, pattern);
  };
}

function walk(node: MdNode, pattern: RegExp): void {
  if (node.children === undefined || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") next.push(...split(child.value, pattern));
    else {
      walk(child, pattern);
      next.push(child);
    }
  }
  node.children = next;
}

function split(value: string, pattern: RegExp): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
    parts.push({
      type: "text",
      value: match[0],
      data: { hName: "span", hProperties: { className: MENTION_CLASS, "data-mention": "true" } },
    });
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return [{ type: "text", value }];
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}
