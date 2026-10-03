import { createContext, memo, useContext, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useFileExistence } from "./file-existence.js";
import { MarkdownLinkContext, type MarkdownLinkHandlers } from "./markdown-link-context.js";
import { markdownUrlTransform, pathTokenCandidates, resolveMarkdownLink, resolvePathText } from "./markdown-links.js";
import { remarkMentions } from "./markdown-mentions.js";
import { remarkFilePaths } from "./markdown-paths.js";

/**
 * markdown 渲染：react-markdown + GFM + rehype-highlight
 * （竞品实证的标准管道，替代早期自研子集渲染器）。
 * memo：流式期间仅 text 变化的消息重渲染。
 * skipHtml：原始 HTML（含 `<!-- … -->` 注释）不显示，也不执行。
 * 链接按 MarkdownLinkContext 处理：项目内文件交给文件面板，项目外路径只显示文字（需求 4.6）。
 * 提供了文件存在确认时（会话页），行内代码与正文里的路径确认文件存在后也变成链接（会话回答里的文件路径可点击）。
 */
export const Markdown = memo(function Markdown({
  text,
  highlights,
}: {
  text: string;
  /** 房间消息：要高亮的 @ 名字（不含 @）。调用方需保持数组引用稳定。 */
  highlights?: readonly string[];
}) {
  const { files } = useContext(MarkdownLinkContext);
  const detectPaths = files !== undefined;
  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      ...(highlights === undefined || highlights.length === 0 ? [] : [remarkMentions(highlights)]),
      ...(detectPaths ? [remarkFilePaths] : []),
    ],
    [highlights, detectPaths],
  );
  return (
    <div className="md">
      <ReactMarkdown
        skipHtml
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={markdownUrlTransform}
        components={{
          a: MarkdownLink,
          table: (props) => {
            const { node, ...rest } = props;
            void node;
            return (
              <div className="md-table-wrap">
                <table {...rest} />
              </div>
            );
          },
          pre: PreBlock,
          code: CodeElement,
          span: SpanElement,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function MarkdownLink(props: ComponentProps<"a"> & { node?: unknown }) {
  const { node, href, children, ...rest } = props;
  void node;
  const { onOpenPath, projectRoot } = useContext(MarkdownLinkContext);
  const target = resolveMarkdownLink(href, projectRoot ?? "");
  if (target.kind === "external") {
    return <a {...rest} href={target.href} target="_blank" rel="noreferrer">{children}</a>;
  }
  if (target.kind === "anchor") {
    return <a {...rest} href={target.href}>{children}</a>;
  }
  if (target.kind === "file" && onOpenPath !== undefined) {
    return (
      <PathButton path={target.path} line={target.line} onOpenPath={onOpenPath}>
        {children}
      </PathButton>
    );
  }
  // 项目外的路径、或这里没法打开文件：只显示文字，不生成会跳到兜底页的链接。
  return <span title={href ?? undefined}>{children}</span>;
}

const PATH_BUTTON_CLASS =
  "md-path inline cursor-pointer rounded-xs border-0 bg-transparent p-0 text-left text-primary-text underline underline-offset-2 [font:inherit] outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-ring";

/** 文件链接：单击在右侧文件面板预览并定位到行；⌘ / Ctrl 单击用本机编辑器打开。 */
function PathButton({
  path,
  line,
  onOpenPath,
  children,
}: {
  path: string;
  line: number | null;
  onOpenPath: NonNullable<MarkdownLinkHandlers["onOpenPath"]>;
  children: ReactNode;
}) {
  const where = line === null ? path : `${path} 第 ${line} 行`;
  return (
    <button
      type="button"
      className={PATH_BUTTON_CLASS}
      title={`${where}\n点击在文件面板预览，⌘ / Ctrl 点击用编辑器打开`}
      data-path={path}
      data-line={line ?? undefined}
      onClick={(event: MouseEvent) => onOpenPath(path, line, { external: event.metaKey || event.ctrlKey })}
    >
      {children}
    </button>
  );
}

/** 代码块里的 `<code>` 不做路径识别：那是代码，不是引用。 */
const InsidePre = createContext(false);

/** 行内代码：像路径、且本机确认文件存在时变成链接（保留等宽灰底）。 */
function CodeElement(props: ComponentProps<"code"> & { node?: unknown }) {
  const { node, children, ...rest } = props;
  void node;
  const insidePre = useContext(InsidePre);
  const { onOpenPath, projectRoot, files } = useContext(MarkdownLinkContext);
  const text = typeof children === "string" ? children : null;
  const reference = !insidePre && files !== undefined && text !== null ? resolvePathText(text, projectRoot ?? "") : null;
  const existence = useFileExistence(reference?.path ?? null);
  const code = <code {...rest}>{children}</code>;
  if (reference === null || existence !== "exists" || onOpenPath === undefined) return code;
  return (
    <PathButton path={reference.path} line={reference.line} onOpenPath={onOpenPath}>
      {code}
    </PathButton>
  );
}

/** 正文里由 remarkFilePaths 切出来的路径片段；其余 span（@ 高亮等）原样。 */
function SpanElement(props: ComponentProps<"span"> & { node?: unknown; "data-path-token"?: string }) {
  const { node, ...rest } = props;
  void node;
  const token = rest["data-path-token"];
  if (typeof token !== "string") return <span {...rest} />;
  return <PathToken token={token} />;
}

function PathToken({ token }: { token: string }) {
  const { onOpenPath, projectRoot } = useContext(MarkdownLinkContext);
  const candidates = useMemo(() => pathTokenCandidates(token, projectRoot ?? ""), [token, projectRoot]);
  // 候选最多 4 个，固定顺序调用 hook。
  const existence = [
    useFileExistence(candidates[0]?.path ?? null),
    useFileExistence(candidates[1]?.path ?? null),
    useFileExistence(candidates[2]?.path ?? null),
    useFileExistence(candidates[3]?.path ?? null),
  ];
  // 按顺序取第一个存在的；前面的还没确认完就先显示文字，免得链接范围先短后长地跳。
  let chosen: (typeof candidates)[number] | null = null;
  for (const [position, candidate] of candidates.entries()) {
    if (existence[position] === "exists") {
      chosen = candidate;
      break;
    }
    if (existence[position] !== "missing") break;
  }
  if (chosen === null || onOpenPath === undefined) return <>{token}</>;
  return (
    <>
      {chosen.before}
      <PathButton path={chosen.path} line={chosen.line} onOpenPath={onOpenPath}>
        {chosen.text}
      </PathButton>
      {chosen.after}
    </>
  );
}

function PreBlock(props: ComponentProps<"pre"> & { node?: unknown }) {
  const { node, ...rest } = props;
  void node;
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const value = preRef.current?.innerText ?? "";
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>代码</span>
        <button type="button" onClick={copy} title="复制代码">
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <InsidePre.Provider value={true}>
        <pre ref={preRef} {...rest} />
      </InsidePre.Provider>
    </div>
  );
}
