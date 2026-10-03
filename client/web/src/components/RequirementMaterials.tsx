import type { SessionContextDto } from "@suduo/client-contracts";
import { REQUIREMENT_STATUS_LABELS } from "@suduo/cloud-contracts";
import { DownloadIcon, ExternalLinkIcon, FileTextIcon, PaperclipIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type RequirementDetailItemDto, type RequirementsAttachmentDto } from "../api/client.js";
import { classifyFailure } from "../feedback/classify.js";
import { RegionError } from "../feedback/components/index.js";
import {
  formatBytes,
  inlineUrl,
  previewKind,
  requirementCode,
} from "../features/requirements/format.js";
import { formatDateTime, formatRelativeTime } from "../ui/format.js";

/** 外壳（会话列表）知道的关联需求。 */
export interface LinkedRequirement {
  id: string;
  number: number | null;
  title: string | null;
}

/** 会话上下文的三态（需求 R2：查不到 ≠ 没有）。 */
export type SessionContextState =
  | { status: "loading" }
  | { status: "ready"; value: SessionContextDto }
  | { status: "error"; message: string };

type Remote<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

/** 需求详情页地址：`/p/<远程项目>/requirements/<编号>`；没有编号时用需求 ID（路由同样认）。 */
export function requirementPageHref(context: SessionContextDto): string | null {
  const requirement = context.requirement;
  if (requirement === null || context.remoteProjectId === null) return null;
  const ref = requirement.number ?? requirement.remoteRequirementId;
  return `/p/${encodeURIComponent(context.remoteProjectId)}/requirements/${encodeURIComponent(String(ref))}`;
}

/**
 * 会话右栏「需求」标签：关联需求的概要——编号、标题、状态、开工时与现在的版本、附件，以及去需求页的入口。
 * 数据来自会话上下文接口 + 需求详情 / 附件接口；任何一项查不到都说「查不到：原因」并给重试，不显示成「没有」。
 * 评论、确认版等完整内容在需求页；模型在会话里用 suduo 工具按需查看（ADR-0008）。
 */
export function RequirementMaterials({
  context,
  onRetryContext,
  onNavigate,
}: {
  context: SessionContextState;
  onRetryContext(): void;
  /** 站内跳转（会话画布不依赖路由上下文）。 */
  onNavigate(path: string): void;
}) {
  if (context.status === "loading") {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="requirement-materials" data-state="loading">
        <FileTextIcon className="size-5 text-subtle-foreground" aria-hidden="true" />
        <p className="m-0 text-small text-muted-foreground">正在读取关联需求…</p>
      </div>
    );
  }
  if (context.status === "error") {
    return (
      <div data-testid="requirement-materials" data-state="error">
        <RegionError kind="runtime_failed" message={`查不到关联需求：${context.message}`} onRetry={onRetryContext} />
      </div>
    );
  }
  const value = context.value;
  if (value.requirement === null) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="requirement-materials" data-state="ready" data-linked="false">
        <FileTextIcon className="size-5 text-subtle-foreground" aria-hidden="true" />
        <p className="m-0 text-small text-muted-foreground">
          {value.kind === "project" ? "这是项目会话，没有关联具体需求。" : "本会话没有关联需求。"}
        </p>
      </div>
    );
  }
  return <RequirementSummary key={value.requirement.remoteRequirementId} context={value} onNavigate={onNavigate} />;
}

function RequirementSummary({ context, onNavigate }: { context: SessionContextDto; onNavigate(path: string): void }) {
  const linked = context.requirement;
  const requirementId = linked?.remoteRequirementId ?? "";
  const [detail, retryDetail] = useRemote<RequirementDetailItemDto>(requirementId, () => api.getRequirement(requirementId));
  const [attachments, retryAttachments] = useRemote<RequirementsAttachmentDto[]>(requirementId, async () =>
    (await api.listRequirementAttachments(requirementId)).items,
  );
  if (linked === null) return null;

  const current = detail.status === "ready" ? detail.value : null;
  const number = current?.number ?? linked.number;
  const title = current?.title ?? linked.title;
  const href = requirementPageHref(context);

  return (
    <div className="flex flex-col gap-5" data-testid="requirement-materials" data-state="ready" data-linked="true">
      <section className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-caption text-subtle-foreground">{requirementCode(number)}</span>
          {current === null ? null : (
            <Badge variant="neutral" data-testid="requirement-material-status">{REQUIREMENT_STATUS_LABELS[current.status]}</Badge>
          )}
        </div>
        <h3 className="m-0 text-body font-semibold text-foreground" data-testid="requirement-material-title">
          {title ?? (detail.status === "loading" ? "正在读取需求…" : "这条需求")}
        </h3>
        <p className="m-0 text-caption text-subtle-foreground" data-testid="requirement-material-version">
          开工时第 {linked.startVersion} 版，
          {current !== null
            ? `现在第 ${current.version} 版`
            : detail.status === "loading"
              ? "现在的版本正在读取…"
              : "现在的版本查不到"}
          {current !== null && current.version !== linked.startVersion ? <span className="text-warning"> · 开工后需求改过</span> : null}
        </p>
        {detail.status === "error" ? (
          <Unavailable message={`查不到需求详情：${detail.message}`} onRetry={retryDetail} part="detail" />
        ) : null}
        {href === null ? null : (
          <a
            href={href}
            className="inline-flex w-fit items-center gap-1 rounded-xs text-small text-primary-text underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="requirement-material-open"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              onNavigate(href);
            }}
          >
            在需求页打开
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </section>

      <section className="flex flex-col gap-1.5" aria-labelledby="rm-attachments">
        <h4 id="rm-attachments" className="m-0 text-small font-semibold text-foreground">
          附件{attachments.status === "ready" ? <span className="ml-1.5 font-normal text-subtle-foreground">{attachments.value.length}</span> : null}
        </h4>
        {attachments.status === "loading" ? <p className="m-0 text-small text-subtle-foreground">正在读取附件…</p> : null}
        {attachments.status === "error" ? (
          <Unavailable message={`查不到附件：${attachments.message}`} onRetry={retryAttachments} part="attachments" />
        ) : null}
        {attachments.status === "ready" && attachments.value.length === 0 ? (
          <p className="m-0 text-small text-subtle-foreground">这条需求没有附件</p>
        ) : null}
        {attachments.status === "ready" && attachments.value.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {attachments.value.map((attachment, index) => (
              <AttachmentRow key={attachment.id} attachment={attachment} index={index} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

/** 附件一行：能在线看的（图片、PDF、文本）点名字在新标签页打开，其余点名字下载；右侧固定一个下载按钮。 */
function AttachmentRow({ attachment, index }: { attachment: RequirementsAttachmentDto; index: number }) {
  const downloadUrl = api.requirementAttachmentDownloadUrl(attachment.id);
  const previewable = previewKind(attachment.fileName) !== null;
  const meta = [formatBytes(attachment.sizeBytes), attachment.uploadedBy.displayName, formatRelativeTime(attachment.createdAt)]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <li
      className="flex min-h-9 items-center gap-2 rounded-sm border border-border px-2.5 py-1.5"
      data-testid="requirement-material-attachment"
      data-index={index}
    >
      <PaperclipIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <a
          className="truncate text-small text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          href={previewable ? inlineUrl(downloadUrl) : downloadUrl}
          {...(previewable ? { target: "_blank", rel: "noreferrer" } : { download: attachment.fileName })}
          title={previewable ? `在新标签页查看「${attachment.fileName}」` : `下载「${attachment.fileName}」`}
        >
          {attachment.fileName}
        </a>
        <span className="truncate text-caption text-subtle-foreground" title={formatDateTime(attachment.createdAt)}>{meta}</span>
      </span>
      <Button asChild size="icon-sm" variant="ghost">
        <a href={downloadUrl} download={attachment.fileName} aria-label={`下载「${attachment.fileName}」`}>
          <DownloadIcon />
        </a>
      </Button>
    </li>
  );
}

function Unavailable({ message, onRetry, part }: { message: ReactNode; onRetry(): void; part: string }) {
  return (
    <div className="flex items-center gap-2 rounded-sm bg-danger-soft px-2.5 py-1.5 text-small text-foreground" role="alert" data-testid="requirement-material-error" data-part={part}>
      <span className="min-w-0 flex-1">{message}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        <RotateCwIcon />
        重试
      </Button>
    </div>
  );
}

/** 按 key 读一次远程数据；key 变了重读，retry 再读一次。失败保留原因（不当成空）。 */
function useRemote<T>(key: string, load: () => Promise<T>): [Remote<T>, () => void] {
  const [state, setState] = useState<Remote<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    loadRef.current()
      .then((value) => {
        if (!cancelled) setState({ status: "ready", value });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ status: "error", message: classifyFailure(cause).message });
      });
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);
  return [state, () => setAttempt((value) => value + 1)];
}
