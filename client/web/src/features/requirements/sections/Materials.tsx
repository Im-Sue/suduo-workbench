import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactVersionDto, RequirementsAttachmentDto } from "../../../api/client.js";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  RotateCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { api } from "../../../api/client.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { ConfirmDialog, RegionError } from "../../../feedback/components/index.js";
import { reportFailure } from "../../../feedback/report.js";
import { useT } from "../../../i18n/provider.js";
import type { Messages } from "../../../i18n/messages/index.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBytes, inlineUrl, newestFirst, previewKind } from "../format.js";
import { requirementKeys } from "../keys.js";
import { artifactVersionQuery, artifactsQuery, attachmentsQuery } from "../queries.js";
import {
  cancelUpload,
  enqueueUploads,
  retryUpload,
  useUploadQueue,
  type UploadItem,
} from "../upload-queue.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";

/**
 * 附件（需求附件评论文件与优先级 4.1）：需求的额外存储，用途由人决定。
 * - 按上传时间从新到旧平铺，没有「确认版 / 其他材料」之分；读的人从上往下读，新旧重复以新的为准；
 * - 以前发布过的确认版收在底部「历史确认版」，只能查看与下载（确认版已停用，不能再发布）；
 * - 整个区块可拖入文件，页面上直接粘贴截图也会上传（评论框里的粘贴归评论）；每个文件独立上传、独立重试。
 */

function useAttachments(requirementId: string) {
  const attachments = useQuery(attachmentsQuery(requirementId));
  const items = useMemo(() => newestFirst(attachments.data?.items ?? []), [attachments.data]);
  return { attachments, items };
}

// ---------- 速览：只读概要 ----------

export function MaterialsPreview({ requirementId }: { requirementId: string }) {
  const text = useT().requirementDetail.materials;
  const { attachments, items } = useAttachments(requirementId);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`peek-materials-${requirementId}`}>
      <div className="flex items-center gap-2">
        <h3 id={`peek-materials-${requirementId}`} className="m-0 text-small font-semibold">{text.heading}</h3>
        {attachments.data === undefined ? null : (
          <span className="text-caption text-subtle-foreground">{items.length}</span>
        )}
      </div>
      {attachments.isPending ? <Skeleton className="h-9 w-full" /> : null}
      {attachments.isError ? <p className="m-0 text-caption text-subtle-foreground">{text.previewLoadFailed}</p> : null}
      {attachments.data !== undefined && items.length === 0 ? (
        <p className="m-0 text-caption text-subtle-foreground">{text.empty}</p>
      ) : null}
      {items.slice(0, 5).map((attachment) => (
        <FileRow
          key={attachment.id}
          name={attachment.fileName}
          size={attachment.sizeBytes}
          downloadUrl={api.requirementAttachmentDownloadUrl(attachment.id)}
          onPreview={setPreview}
        />
      ))}
      {items.length > 5 ? <p className="m-0 text-caption text-subtle-foreground">{text.more(items.length - 5)}</p> : null}
      <ImagePreviewDialog preview={preview} onClose={() => setPreview(null)} />
    </section>
  );
}

// ---------- 详情：完整区块 ----------

export function MaterialsPanel({ requirementId }: { requirementId: string }) {
  const t = useT();
  const text = t.requirementDetail.materials;
  const queryClient = useQueryClient();
  const { attachments, items } = useAttachments(requirementId);
  const queue = useUploadQueue(requirementId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RequirementsAttachmentDto | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const existingCount = attachments.data?.items.length ?? 0;

  const upload = (files: readonly File[]) => {
    if (files.length > 0) enqueueUploads(queryClient, requirementId, files, existingCount);
  };

  // 页面上直接粘贴截图即上传（输入框里粘贴文字不受影响）。
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      // 已经有人收下了这次粘贴（如评论框把截图当评论文件）：不再重复传成附件。
      if (event.defaultPrevented) return;
      // 对话框开着时（如开始会话里手动输入路径）粘贴归对话框，不当材料上传。
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      enqueueUploads(queryClient, requirementId, files.map((file) => renamePastedImage(file, t)), existingCount);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [queryClient, requirementId, existingCount, t]);

  const remove = async (attachment: RequirementsAttachmentDto) => {
    try {
      await api.deleteRequirementAttachment(attachment.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: requirementKeys.attachments(requirementId) }),
        queryClient.invalidateQueries({ queryKey: requirementKeys.activity(requirementId) }),
        queryClient.invalidateQueries({ queryKey: requirementKeys.detail(requirementId) }),
      ]);
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.deleteFailed(attachment.fileName), retry: () => void remove(attachment) });
    }
  };

  const onDragOver = (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  };

  return (
    <section
      aria-labelledby="materials-heading"
      className={cn(
        "relative flex flex-col gap-3 rounded-lg border border-transparent p-0.5 transition-colors",
        dragging && "border-dashed border-primary bg-primary-soft/40",
      )}
      data-testid="materials-panel"
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        upload(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="flex items-center gap-2">
        <h2 id="materials-heading" className="m-0 text-section font-semibold">{text.panelHeading}</h2>
        <div className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
          <UploadIcon />
          {text.upload}
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            upload(files);
          }}
        />
      </header>

      <div className="flex flex-col gap-1">
        {attachments.isPending ? <Skeleton className="h-9 w-full" /> : null}
        {attachments.isError ? (
          <RegionError
            kind={classifyFailure(attachments.error).kind}
            message={text.loadFailed(classifyFailure(attachments.error).message)}
            onRetry={() => void attachments.refetch()}
          />
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={text.listLabel}>
          {queue.map((item) => (
            <li key={item.id}>
              <UploadRow item={item} />
            </li>
          ))}
          {items.map((attachment) => (
            <li key={attachment.id}>
              <FileRow
                name={attachment.fileName}
                size={attachment.sizeBytes}
                meta={`${attachment.uploadedBy.displayName} · ${formatRelativeTime(attachment.createdAt)}`}
                downloadUrl={api.requirementAttachmentDownloadUrl(attachment.id)}
                onPreview={setPreview}
                extra={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={text.deleteFile(attachment.fileName)}
                    onClick={() => setPendingDelete(attachment)}
                  >
                    <Trash2Icon />
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="mt-1 flex h-12 items-center justify-center gap-2 rounded-md border border-dashed border-border-strong text-small text-subtle-foreground outline-none hover:border-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => fileRef.current?.click()}
        >
          <UploadIcon className="size-4" aria-hidden="true" />
          {dragging ? text.dropToUpload : text.dropHint}
        </button>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={text.deleteConfirm.title(pendingDelete?.fileName ?? "")}
        description={text.deleteConfirm.description}
        confirmLabel={text.deleteConfirm.confirm}
        onConfirm={() => {
          if (pendingDelete !== null) void remove(pendingDelete);
        }}
      />
      <HistoricalVersions requirementId={requirementId} onPreview={setPreview} />
      <ImagePreviewDialog preview={preview} onClose={() => setPreview(null)} />
    </section>
  );
}

interface FilePreview {
  name: string;
  url: string;
}

/** 图片附件的大图预览（详情页「材料」与需求抽屉共用）。 */
function ImagePreviewDialog({ preview, onClose }: { preview: FilePreview | null; onClose(): void }) {
  const text = useT().requirementDetail.materials;
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" className="max-w-[min(1100px,calc(100vw-32px))]">
        <DialogHeader>
          <DialogTitle className="truncate">{preview?.name}</DialogTitle>
          <DialogDescription className="sr-only">{text.imagePreview}</DialogDescription>
        </DialogHeader>
        {preview === null ? null : <ImagePreview key={preview.url} name={preview.name} url={preview.url} />}
      </DialogContent>
    </Dialog>
  );
}

/** 本机服务确认不了图片类型时按下载返回，<img> 会加载失败：这时说明原因并给下载。 */
function ImagePreview({ name, url }: { name: string; url: string }) {
  const text = useT().requirementDetail.materials;
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md bg-muted px-6 py-10 text-center">
        <p className="m-0 text-small text-muted-foreground">{text.imageUnavailable}</p>
        <Button asChild variant="secondary">
          <a href={url.replace(/[?&]disposition=inline/, "")} download>
            <DownloadIcon />
            {text.download}
          </a>
        </Button>
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={name}
      className="max-h-[70vh] w-full rounded-md bg-muted object-contain"
      onError={() => setBroken(true)}
    />
  );
}

/**
 * 历史确认版：确认版停用前发布过的版本，收起放在附件区底部，只能查看与下载。
 * 从没发布过（或读不到版本列表）时整块不显示；展开后才去取各版的文件清单。
 */
function HistoricalVersions({
  requirementId,
  onPreview,
}: {
  requirementId: string;
  onPreview(preview: FilePreview): void;
}) {
  const text = useT().requirementDetail.materials;
  const versions = useQuery(artifactsQuery(requirementId));
  const [open, setOpen] = useState(false);
  const ordered = useMemo(
    () => (versions.data?.items ?? []).toSorted((a, b) => b.versionNumber - a.versionNumber),
    [versions.data],
  );
  if (ordered.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="historical-versions">
      <button
        type="button"
        aria-expanded={open}
        className="-ml-1.5 flex w-fit items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-small text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
        {text.history(ordered.length)}
      </button>
      {open ? (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
          <p className="m-0 text-caption text-subtle-foreground">{text.historyHint}</p>
          {ordered.map((version) => (
            <HistoricalVersion key={version.id} requirementId={requirementId} version={version} onPreview={onPreview} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HistoricalVersion({
  requirementId,
  version,
  onPreview,
}: {
  requirementId: string;
  version: ArtifactVersionDto;
  onPreview(preview: FilePreview): void;
}) {
  const text = useT().requirementDetail.materials;
  const detail = useQuery(artifactVersionQuery(requirementId, version.id));
  return (
    <section className="flex flex-col gap-1" aria-label={text.versionItem(version.versionNumber)}>
      <h3 className="m-0 flex flex-wrap items-baseline gap-1.5 text-small font-semibold">
        <span>{text.versionItem(version.versionNumber)}</span>
        <span className="font-normal text-caption text-subtle-foreground">
          {text.publishedBy({
            who: version.publishedBy.displayName,
            time: (
              <time key="time" dateTime={version.publishedAt} title={formatDateTime(version.publishedAt)}>
                {formatRelativeTime(version.publishedAt)}
              </time>
            ),
          })}
        </span>
      </h3>
      {detail.isPending ? <Skeleton className="h-9 w-full" /> : null}
      {detail.isError ? (
        <RegionError
          kind={classifyFailure(detail.error).kind}
          message={text.versionLoadFailed(classifyFailure(detail.error).message)}
          onRetry={() => void detail.refetch()}
        />
      ) : null}
      {detail.data === undefined ? null : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {detail.data.files.map((file) => (
            <li key={file.id}>
              <FileRow
                name={file.fileName}
                size={file.sizeBytes}
                downloadUrl={api.artifactVersionFileDownloadUrl(version.id, file.id)}
                onPreview={onPreview}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FileRow({
  name,
  size,
  meta,
  downloadUrl,
  onPreview,
  extra,
}: {
  name: string;
  size: number;
  meta?: string;
  downloadUrl: string;
  onPreview?(preview: FilePreview): void;
  extra?: ReactNode;
}) {
  const text = useT().requirementDetail.materials;
  const kind = previewKind(name);
  const Icon = fileIconFor(name);
  // 能预览的文件，点文件名本身也能预览（图片在当前页放大，PDF 等在新标签页打开），不只靠右边的小眼睛。
  const nameClass = "min-w-0 flex-1 truncate text-left text-small";
  // PDF 等用 <a>：继承文字颜色、平时不加下划线，和图片的按钮看起来一样（没有全局的链接样式重置）。
  const nameLinkClass = cn(
    nameClass,
    "cursor-pointer rounded-xs text-inherit no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
  );
  return (
    <div className="group/file flex h-9 items-center gap-2.5 rounded-sm border border-border px-2.5 hover:bg-muted">
      <Icon className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
      {onPreview === undefined || kind === null ? (
        <span className={nameClass} title={name}>{name}</span>
      ) : kind === "image" ? (
        <button type="button" className={nameLinkClass} title={name} onClick={() => onPreview({ name, url: inlineUrl(downloadUrl) })}>
          {name}
        </button>
      ) : (
        <a href={inlineUrl(downloadUrl)} target="_blank" rel="noreferrer" className={nameLinkClass} title={name}>
          {name}
        </a>
      )}
      {meta === undefined ? null : <span className="hidden shrink-0 text-caption text-subtle-foreground sm:inline">{meta}</span>}
      <span className="shrink-0 text-caption text-subtle-foreground">{formatBytes(size)}</span>
      {onPreview === undefined || kind === null ? null : kind === "image" ? (
        <Button size="icon-sm" variant="ghost" aria-label={text.previewFile(name)} onClick={() => onPreview({ name, url: inlineUrl(downloadUrl) })}>
          <EyeIcon />
        </Button>
      ) : (
        <Button asChild size="icon-sm" variant="ghost">
          <a href={inlineUrl(downloadUrl)} target="_blank" rel="noreferrer" aria-label={text.previewInNewTab(name)}>
            <EyeIcon />
          </a>
        </Button>
      )}
      <Button asChild size="icon-sm" variant="ghost">
        <a href={downloadUrl} download aria-label={text.downloadFile(name)}>
          <DownloadIcon />
        </a>
      </Button>
      {extra}
    </div>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const text = useT().requirementDetail.upload;
  const Icon = fileIconFor(item.file.name);
  return (
    <div
      className={cn(
        "flex min-h-9 flex-col justify-center gap-1 rounded-sm border px-2.5 py-1.5",
        item.state === "failed" ? "border-danger/40 bg-danger-soft/40" : "border-border",
      )}
      data-testid="upload-row"
      data-state={item.state}
    >
      <div className="flex items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-small">{item.file.name}</span>
        {item.state === "uploading" || item.state === "queued" ? (
          <span className="shrink-0 font-mono text-caption text-subtle-foreground">
            {item.state === "queued" ? text.queued : `${item.progress}%`}
          </span>
        ) : null}
        {item.state === "done" ? <CheckIcon className="size-4 shrink-0 text-success" aria-label={text.uploaded} /> : null}
        {item.state === "failed" && item.retryable ? (
          <Button size="sm" variant="ghost" onClick={() => retryUpload(item.requirementId, item.id)}>
            <RotateCwIcon />
            {text.retry}
          </Button>
        ) : null}
        {item.state !== "done" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={item.state === "uploading" ? text.cancel(item.file.name) : text.remove(item.file.name)}
            onClick={() => cancelUpload(item.requirementId, item.id)}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {item.state === "uploading" ? <Progress value={item.progress} className="h-1" aria-label={text.progress(item.progress)} /> : null}
      {item.state === "failed" ? (
        <p className="m-0 flex items-center gap-1 text-caption text-danger" role="alert">
          <AlertCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {text.failed(item.error ?? "")}
        </p>
      ) : null}
    </div>
  );
}

function fileIconFor(name: string) {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"].includes(extension)) return FileImageIcon;
  if (["xls", "xlsx", "csv", "numbers"].includes(extension)) return FileSpreadsheetIcon;
  if (["pdf", "doc", "docx", "md", "txt", "pages", "rtf"].includes(extension)) return FileTextIcon;
  return FileIcon;
}

/** 剪贴板里的截图通常都叫 image.png：加上时间，免得一串同名文件。评论框粘贴的截图也用它。 */
export function renamePastedImage(file: File, t: Messages): File {
  if (!/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const extension = file.name.split(".").at(-1) ?? "png";
  return new File([file], t.requirementDetail.materials.pastedImageName(stamp, extension), { type: file.type, lastModified: file.lastModified });
}
