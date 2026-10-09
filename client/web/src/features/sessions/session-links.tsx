import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { SessionDto, SessionLinkDto, SessionLinksDto, SessionStartOptions } from "@suduo/client-contracts";
import { CornerDownRightIcon, MessagesSquareIcon } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import { sessionReadViewLabel, type SessionReadRef } from "../../event-projection/suduo-tools.js";
import { useT } from "../../i18n/provider.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StartOptions } from "../agents/StartOptions.js";
import { rememberAgent } from "../agents/queries.js";

/**
 * 会话之间的关系（多 Agent 协作 S7，需求 4.1 / 4.2）：消息里引用别的会话（`[标题](suduo://session/<ID>)`）、
 * Agent 读取别的会话的步骤、「交给另一个 Agent 接着做」与两边互相显示的接续关系。
 */

const SESSION_LINK = /\[([^\]\n]*)\]\(suduo:\/\/session\/([0-9a-f-]{36})\)|suduo:\/\/session\/([0-9a-f-]{36})/giu;

/** 插进输入框的会话引用：`[标题](suduo://session/<ID>)`（标题里的方括号去掉，免得截断链接）。 */
export function sessionLinkText(session: { id: string; title: string }): string {
  const title = session.title.replace(/[[\]\n]/gu, " ").trim() || session.id.slice(0, 8);
  return `[${title}](suduo://session/${session.id})`;
}

/** 一个会话的详情（会话名、Agent 名）：读取步骤、会话标签共用，取不到时不报错。 */
function useSessionInfo(sessionId: string) {
  return useQuery({
    queryKey: ["session-info", sessionId],
    queryFn: () => api.getSession(sessionId),
    staleTime: 60_000,
    retry: false,
  });
}

/** 时间线上 Agent 读另一个会话的步骤：「读取了 Claude Code ·「导出接口」· 最近 3 轮」。 */
export function SessionReadTitle({ read }: { read: SessionReadRef }) {
  const t = useT();
  const info = useSessionInfo(read.sessionId);
  const view = sessionReadViewLabel(read, t);
  const session = info.data;
  return (
    <span data-testid="session-read-title" data-session-id={read.sessionId}>
      {session === undefined
        ? t.sessionLinks.read.pending(view)
        : t.sessionLinks.read.title(session.agent?.displayName ?? session.agentId, session.title, view)}
    </span>
  );
}

/** 消息正文：会话引用换成可点的标签，其余文字原样。 */
export function TextWithSessionLinks({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(SESSION_LINK)) {
    const index = match.index;
    if (index > last) parts.push(text.slice(last, index));
    const id = (match[2] ?? match[3] ?? "").toLowerCase();
    parts.push(<SessionChip key={`${String(index)}-${id}`} sessionId={id} fallbackTitle={match[1] ?? null} />);
    last = index + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

function SessionChip({ sessionId, fallbackTitle }: { sessionId: string; fallbackTitle: string | null }) {
  const t = useT();
  const info = useSessionInfo(sessionId);
  const title = info.data?.title ?? fallbackTitle ?? sessionId.slice(0, 8);
  const agent = info.data?.agent?.displayName ?? null;
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId }}
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-xs bg-primary-soft px-1.5 align-baseline text-caption text-primary-text no-underline hover:underline"
      title={t.sessionLinks.chip.open(title)}
      data-testid="session-chip"
      data-session-id={sessionId}
    >
      <MessagesSquareIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{agent === null ? title : `${agent} · ${title}`}</span>
    </Link>
  );
}

/** 会话页顶部：接续自哪个会话、被哪些会话接着做（需求 4.2「两个会话互相显示」）。 */
export function SessionLinksBar({ links }: { links: SessionLinksDto | undefined }) {
  const t = useT();
  const text = t.sessionLinks.banner;
  if (links === undefined || (links.continuedFrom === null && links.continuedBy.length === 0)) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-5 py-1.5 text-caption text-muted-foreground" data-testid="session-links-bar">
      {links.continuedFrom === null ? null : (
        <span className="inline-flex min-w-0 items-center gap-1" data-testid="session-continued-from">
          <CornerDownRightIcon className="size-3 shrink-0" aria-hidden="true" />
          {text.continuedFrom}
          <LinkedSession link={links.continuedFrom} />
        </span>
      )}
      {links.continuedBy.length === 0 ? null : (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1" data-testid="session-continued-by">
          {text.continuedBy}
          {links.continuedBy.map((link) => (
            <LinkedSession key={link.id} link={link} />
          ))}
        </span>
      )}
    </div>
  );
}

function LinkedSession({ link }: { link: SessionLinkDto }) {
  const text = useT().sessionLinks.banner;
  const label = text.session(link.agentName, link.title);
  if (link.state === "deleted") return <span className="text-subtle-foreground">{label}{text.deleted}</span>;
  return (
    <Link to="/sessions/$sessionId" params={{ sessionId: link.id }} className="truncate text-primary-text hover:underline">
      {label}
    </Link>
  );
}

// ---------- 交给另一个 Agent 接着做 ----------

/** 新会话打开时要预填的首条消息（接着做时由对话框放进来，会话页取走一次）。 */
const pendingDrafts = new Map<string, string>();

export function takePendingDraft(sessionId: string): string | null {
  const draft = pendingDrafts.get(sessionId) ?? null;
  pendingDrafts.delete(sessionId);
  return draft;
}

/** 选 Agent / 权限 / 模型后开新会话，跳过去并预填「接着 @原会话 继续：」（不自动发出）。 */
export function ContinueSessionDialog({
  session,
  open,
  onOpenChange,
}: {
  session: SessionDto;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useT();
  const text = t.sessionLinks.continue;
  const navigate = useNavigate();
  const [options, setOptions] = useState<(SessionStartOptions & { agentId: string }) | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ReturnType<typeof classifyFailure> | null>(null);
  // 重新打开时不带上次的错误。
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const start = async () => {
    if (options === null) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.continueSession(session.id, options);
      rememberAgent(options.agentId);
      pendingDrafts.set(created.id, text.prefill(sessionLinkText(session)));
      onOpenChange(false);
      await navigate({ to: "/sessions/$sessionId", params: { sessionId: created.id } });
    } catch (cause) {
      setError(classifyFailure(cause));
    } finally {
      setCreating(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (creating ? undefined : onOpenChange(next))}>
      <DialogContent size="md" data-testid="continue-session-dialog">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description(session.title)}</DialogDescription>
        </DialogHeader>
        {open ? <StartOptions onChange={setOptions} onNavigate={() => onOpenChange(false)} avoidAgentId={session.agentId} /> : null}
        {error === null ? null : <InlineError kind={error.kind}>{text.failed(error.message)}</InlineError>}
        <DialogFooter>
          <Button variant="secondary" disabled={creating} onClick={() => onOpenChange(false)}>
            {t.feedback.dialog.close}
          </Button>
          <Button variant="primary" disabled={options === null} loading={creating} data-testid="continue-session-start" onClick={() => void start()}>
            {text.start}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
