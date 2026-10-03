import { useEffect, useMemo, type ReactNode } from "react";
import type { FileContentDto, SystemOpenTarget } from "@suduo/client-contracts";
import { api, type WorkspaceDiff } from "../api/client.js";
import { computeDiff } from "../ui/diff.js";
import { Markdown } from "../ui/markdown.js";
import { MonacoView } from "./MonacoView.js";
import { formatBytes } from "../ui/format.js";
import { ArrowLeftIcon, FileIcon } from "lucide-react";
import { DiffStat } from "../features/sessions/stream/TurnView.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { OpenMenu } from "./OpenMenu.js";
import { CsvPreview, SheetPreview } from "./TablePreview.js";

export type DrawerState =
  | { mode: "diff"; diff: WorkspaceDiff }
  /** line：从回答里的文件链接打开时要定位的行（从 1 开始）；Markdown 渲染预览忽略它。 */
  | { mode: "preview"; content: FileContentDto; line?: number | null }
  | { mode: "fallback"; path: string; message: string }
  /** 还没写到磁盘的改动（例如等你确认的文件修改）：直接显示 Codex 给的统一 diff。 */
  | { mode: "patch"; path: string; diff: string; label: string };

const KIND_LABEL = { created: "新建", modified: "修改", deleted: "删除" } as const;

/** 超过该体量不再做 markdown 渲染（元素爆炸会卡主线程），退回纯文本。 */
const MARKDOWN_RENDER_CAP = 300_000;
/** 页面内文本展示上限；再大靠系统应用打开。 */
const TEXT_RENDER_CAP = 2_000_000;

/**
 * 检查面板里的文件查看器：diff、文件预览、无法预览时的说明。头部「返回」回到面板标签页（也可按 Esc）。
 */
export function Drawer({
  state,
  projectId,
  targets,
  onClose,
  onSystemOpen,
}: {
  state: DrawerState;
  projectId: string;
  targets: SystemOpenTarget[];
  onClose(): void;
  onSystemOpen(path: string, mode: SystemOpenTarget): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 输入框里的 Esc 另有用途（如输入框为空时停止这一轮），不抢。
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"]') !== null) return;
      // 已处理：不让同一次 Esc 再被审批坞当成「拒绝」。
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="文件详情">
      {state.mode === "diff" ? (
        <DiffView diff={state.diff} targets={targets} onClose={onClose} onSystemOpen={onSystemOpen} />
      ) : state.mode === "patch" ? (
        <PatchView path={state.path} diff={state.diff} label={state.label} onClose={onClose} />
      ) : state.mode === "preview" ? (
        <PreviewView content={state.content} line={state.line ?? null} projectId={projectId} targets={targets} onClose={onClose} onSystemOpen={onSystemOpen} />
      ) : (
        <FallbackView path={state.path} message={state.message} targets={targets} onClose={onClose} onSystemOpen={onSystemOpen} />
      )}
    </section>
  );
}

function ViewerHead({
  badge,
  path,
  stat,
  actions,
  onClose,
}: {
  badge: string;
  path: string;
  stat?: ReactNode;
  actions?: ReactNode;
  onClose(): void;
}) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pr-2 pl-2">
      <Button size="icon-sm" variant="ghost" aria-label="返回" title="返回（Esc）" onClick={onClose}>
        <ArrowLeftIcon />
      </Button>
      <span className="shrink-0 rounded-xs bg-muted px-1.5 text-caption text-muted-foreground">{badge}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-caption text-foreground" title={path} dir="rtl">
        <bdi>{path}</bdi>
      </span>
      {stat}
      {actions}
    </header>
  );
}

function DiffView({
  diff,
  targets,
  onClose,
  onSystemOpen,
}: {
  diff: WorkspaceDiff;
  targets: SystemOpenTarget[];
  onClose(): void;
  onSystemOpen(path: string, mode: SystemOpenTarget): void;
}) {
  const result = useMemo(() => computeDiff(diff.before, diff.after), [diff.before, diff.after]);
  return (
    <>
      <ViewerHead
        badge={KIND_LABEL[diff.kind]}
        path={diff.path}
        stat={result.mode === "unified" ? <DiffStat additions={result.adds} deletions={result.dels} /> : undefined}
        actions={diff.kind === "deleted" ? undefined : <OpenMenu path={diff.path} targets={targets} onOpen={onSystemOpen} />}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-view">
        <MonacoView mode="diff" original={diff.before} modified={diff.after} path={diff.path} />
        {diff.truncated ? <p className="m-0 px-3 py-2 text-caption text-subtle-foreground">二进制或超大文件只显示摘要。</p> : null}
      </div>
    </>
  );
}

function PatchView({ path, diff, label, onClose }: { path: string; diff: string; label: string; onClose(): void }) {
  const lines = diff.split("\n");
  return (
    <>
      <ViewerHead badge={label} path={path} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-auto bg-card" data-testid="patch-view">
        {diff.trim() === "" ? (
          <p className="m-0 p-4 text-small text-subtle-foreground">没有可显示的改动内容。</p>
        ) : (
          <pre className="m-0 py-2 font-mono text-caption leading-[18px]">
            {lines.map((line, index) => (
              <div
                key={index}
                className={cn(
                  "px-3 whitespace-pre-wrap break-all",
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "bg-diff-add-bg text-diff-add-fg"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "bg-diff-del-bg text-diff-del-fg"
                      : line.startsWith("@@")
                        ? "text-subtle-foreground"
                        : "text-foreground",
                )}
              >
                {line === "" ? " " : line}
              </div>
            ))}
          </pre>
        )}
      </div>
    </>
  );
}

function PreviewView({
  content,
  line,
  projectId,
  targets,
  onClose,
  onSystemOpen,
}: {
  content: FileContentDto;
  line: number | null;
  projectId: string;
  targets: SystemOpenTarget[];
  onClose(): void;
  onSystemOpen(path: string, mode: SystemOpenTarget): void;
}) {
  return (
    <>
      <ViewerHead
        badge="预览"
        path={content.path}
        stat={<span className="shrink-0 text-caption text-subtle-foreground">{formatBytes(content.size)}</span>}
        actions={<OpenMenu path={content.path} targets={targets} onOpen={onSystemOpen} />}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3" data-testid="file-preview">
        <PreviewBody content={content} line={line} projectId={projectId} targets={targets} onSystemOpen={onSystemOpen} />
      </div>
    </>
  );
}

function PreviewBody({
  content,
  line,
  projectId,
  targets,
  onSystemOpen,
}: {
  content: FileContentDto;
  line: number | null;
  projectId: string;
  targets: SystemOpenTarget[];
  onSystemOpen(path: string, mode: SystemOpenTarget): void;
}) {
  if (content.type === "binary") {
    if (content.mediaType === "application/pdf") {
      // 浏览器原生 PDF 查看器，零依赖。
      return <iframe className="h-full min-h-[480px] w-full flex-1 rounded-md border border-border" title={content.path} src={api.fileRawUrl(projectId, content.path)} />;
    }
    if (/\.(xlsx|xls)$/i.test(content.path)) {
      return <SheetPreview projectId={projectId} path={content.path} />;
    }
    return (
      <Unpreviewable
        title="这种文件没法在工作台里预览"
        message="Word 等文件请用系统默认应用打开查看。"
        action={<OpenMenu path={content.path} targets={targets} onOpen={onSystemOpen} />}
      />
    );
  }
  if (content.type === "image") {
    return <img className="max-w-full self-start rounded-md border border-border bg-muted" src={content.url} alt={content.path} />;
  }
  if (content.mediaType === "text/csv") {
    return (
      <>
        {content.truncated === true ? <Truncated>文件较大，只解析了开头部分——完整内容请用系统应用打开。</Truncated> : null}
        <CsvPreview text={content.text} />
      </>
    );
  }
  const truncatedByServer = content.truncated === true;
  const overCap = content.text.length > TEXT_RENDER_CAP;
  const display = overCap ? content.text.slice(0, TEXT_RENDER_CAP) : content.text;
  const asMarkdown = content.mediaType === "text/markdown" && content.text.length <= MARKDOWN_RENDER_CAP;
  return (
    <>
      {truncatedByServer || overCap ? <Truncated>文件较大，只显示开头部分——完整内容请用系统应用打开。</Truncated> : null}
      {content.mediaType === "text/markdown" && !asMarkdown ? <Truncated>文档较大，已按纯文本显示以保证流畅。</Truncated> : null}
      {asMarkdown ? (
        <div className="text-body text-foreground">
          <Markdown text={display} />
        </div>
      ) : (
        <div className="flex min-h-[70vh] flex-1 overflow-hidden rounded-md border border-border">
          <MonacoView mode="read" text={display} path={content.path} revealLine={line} />
        </div>
      )}
    </>
  );
}

function Truncated({ children }: { children: ReactNode }) {
  return <p className="m-0 mb-2 rounded-md bg-warning-soft px-3 py-2 text-small text-foreground">{children}</p>;
}

function Unpreviewable({ title, message, action }: { title: string; message: string; action: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <FileIcon className="size-5 text-subtle-foreground" aria-hidden="true" />
      <p className="m-0 text-small font-medium text-foreground">{title}</p>
      <p className="m-0 text-caption text-subtle-foreground">{message}</p>
      <div className="mt-1">{action}</div>
    </div>
  );
}

function FallbackView({
  path,
  message,
  targets,
  onClose,
  onSystemOpen,
}: {
  path: string;
  message: string;
  targets: SystemOpenTarget[];
  onClose(): void;
  onSystemOpen(path: string, mode: SystemOpenTarget): void;
}) {
  return (
    <>
      <ViewerHead badge="文件" path={path} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-auto">
        <Unpreviewable title="没法在工作台里预览" message={message} action={<OpenMenu path={path} targets={targets} onOpen={onSystemOpen} />} />
      </div>
    </>
  );
}
