/**
 * 正文里的文件路径（会话回答里的文件路径可点击）：把文字节点里像路径的片段切出来，包成带
 * `data-path-token` 的 span，由 Markdown 渲染时确认文件存在后变成链接。
 * 只处理普通文字，代码块 / 行内代码（另有渲染器）/ 链接文字 / 已被别的插件包过的片段不动。
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

/**
 * 带 `/` 的路径（可含中文目录名）或带 ASCII 扩展名的文件名，后面可跟 `:行`、`:行:列`、`:行-行`、`#L行`。
 * 中文与路径贴在一起时会整段切出，前后的中文由渲染器按候选剥掉。
 */
const PATH_TOKEN =
  /(?:[\p{L}\p{N}_@~.+-]*\/)+[\p{L}\p{N}_@.+-]+(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:-L?\d+)?)?|[\p{L}\p{N}_+-][\p{L}\p{N}_.+-]*\.[A-Za-z][A-Za-z0-9]{0,15}(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:-L?\d+)?)?/gu;

export function remarkFilePaths() {
  return (tree: unknown) => walk(tree as MdNode);
}

function walk(node: MdNode): void {
  if (node.children === undefined || SKIP.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && child.data === undefined) next.push(...split(child.value));
    else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

function split(value: string): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  PATH_TOKEN.lastIndex = 0;
  for (let match = PATH_TOKEN.exec(value); match !== null; match = PATH_TOKEN.exec(value)) {
    const token = match[0];
    // 没有任何 ASCII 字母数字的（「需求/评论」）不可能是项目里的路径，省一次确认。
    if (!/[A-Za-z0-9]/.test(token)) continue;
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
    parts.push({ type: "text", value: token, data: { hName: "span", hProperties: { "data-path-token": token } } });
    last = match.index + token.length;
  }
  if (parts.length === 0) return [{ type: "text", value }];
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}
