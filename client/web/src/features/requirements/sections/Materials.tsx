import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ArtifactVersionDetailDto,
  ArtifactVersionDto,
  RequirementsAttachmentDto,
} from "../../../api/client.js";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBytes, inlineUrl, previewKind } from "../format.js";
import { requirementKeys } from "../keys.js";
import { artifactVersionQuery, artifactsQuery, attachmentsQuery } from "../queries.js";
import {
  cancelUpload,
  enqueueUploads,
  retryUpload,
  useUploadQueue,
  type UploadItem,
} from "../upload-queue.js";
import { PublishArtifactDialog } from "./PublishArtifactDialog.js";
import { formatDateTime, formatRelativeTime } from "../../../ui/format.js";

/**
 * 材料与确认版（原型 Detail · 材料与确认版）。
 * - 「确认版」是某一时刻的材料组合，发布后不可变；最新一版置顶，历史版本在菜单里切换查看；
 * - 其余没进过任何确认版的附件列在「其他材料」；
 * - 整个区块可拖入文件，页面上直接粘贴截图也会上传；每个文件独立上传、独立重试。
 */

function useMaterials(requirementId: string) {
  const attachments = useQuery(attachmentsQuery(requirementId));
  const versions = useQuery(artifactsQuery(requirementId));
  const newest = useMemo(
    () => (versions.data?.items ?? []).toSorted((a, b) => b.versionNumber - a.versionNumber),
    [versions.data],
  );
  const details = useQueries({
    queries: newest.map((version) => artifactVersionQuery(requirementId, version.id)),
  });
  const detailById = new Map<string, ArtifactVersionDetailDto>();
  for (const detail of details) if (detail.data !== undefined) detailById.set(detail.data.id, detail.data);
  const allDetailsLoaded = details.every((detail) => detail.data !== undefined);
  const publishedIds = new Set(
    [...detailById.values()].flatMap((version) => version.files.map((file) => file.attachmentId)),
  );
  const others = (attachments.data?.items ?? []).filter((item) => !publishedIds.has(item.id));
  return { attachments, versions, newest, detailById, allDetailsLoaded, others };
}

// ---------- 速览：只读概要 ----------

export function MaterialsPreview({ requirementId }: { requirementId: string }) {
  const text = useT().requirementDetail.materials;
  const { attachments, newest } = useMaterials(requirementId);
  const latest = newest[0];
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`peek-materials-${requirementId}`}>
      <div className="flex items-center gap-2">
        <h3 id={`peek-materials-${requirementId}`} className="m-0 text-small font-semibold">{text.heading}</h3>
        {attachments.data === undefined ? null : (
          <span className="text-caption text-subtle-foreground">{attachments.data.items.length}</span>
        )}
        {latest === undefined ? null : (
          <Badge variant="success" className="ml-auto">{text.versionBadge(latest.versionNumber)}</Badge>
        )}
      </div>
      {attachments.isPending ? <Skeleton className="h-9 w-full" /> : null}
      {attachments.isError ? <p className="m-0 text-caption text-subtle-foreground">{text.previewLoadFailed}</p> : null}
      {attachments.data?.items.length === 0 ? (
        <p className="m-0 text-caption text-subtle-foreground">{text.empty}</p>
      ) : null}
      {attachments.data?.items.slice(0, 5).map((attachment) => (
        <FileRow key={attachment.id} name={attachment.fileName} size={attachment.sizeBytes} downloadUrl={api.requirementAttachmentDownloadUrl(attachment.id)} />
      ))}
      {attachments.data !== undefined && attachments.data.items.length > 5 ? (
        <p className="m-0 text-caption text-subtle-foreground">{text.more(attachments.data.items.length - 5)}</p>
      ) : null}
    </section>
  );
}

// ---------- 详情：完整区块 ----------

export function MaterialsPanel({ requirementId }: { requirementId: string }) {
  const t = useT();
  const text = t.requirementDetail.materials;
  const queryClient = useQueryClient();
  const { attachments, versions, newest, detailById, allDetailsLoaded, others } = useMaterials(requirementId);
  const queue = useUploadQueue(requirementId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RequirementsAttachmentDto | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const existingCount = attachments.data?.items.length ?? 0;

  const upload = (files: readonly File[]) => {
    if (files.length > 0) enqueueUploads(queryClient, requirementId, files, existingCount);
  };

  // 页面上直接粘贴截图即上传（输入框里粘贴文字不受影响）。
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
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

  const viewed = (viewingId === null ? undefined : newest.find((item) => item.id === viewingId)) ?? newest[0];
  const viewedDetail = viewed === undefined ? undefined : detailById.get(viewed.id);

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
        <Button
          size="sm"
          variant="secondary"
          // 版本列表还没取到时不能发：否则「第几版」和默认勾选都按「没有版本」算，取到后又误报「别人刚发了一版」。
          disabled={existingCount === 0 || !versions.isSuccess || !allDetailsLoaded}
          disabledReason={existingCount === 0 ? text.publishNeedsMaterials : text.publishLoadingVersions}
          onClick={() => setPublishing(true)}
        >
          <CheckIcon />
          {text.publish}
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

      {versions.isError ? (
        <RegionError
          kind={classifyFailure(versions.error).kind}
          message={text.versionsLoadFailed(classifyFailure(versions.error).message)}
          onRetry={() => void versions.refetch()}
        />
      ) : null}

      {viewed === undefined ? null : (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3" data-testid="artifact-version">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={viewed.id === newest[0]?.id ? "success" : "neutral"}>
              {text.versionBadge(viewed.versionNumber)}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-caption text-subtle-foreground">
              {text.publishedBy({
                who: viewed.publishedBy.displayName,
                time: (
                  <time key="time" dateTime={viewed.publishedAt} title={formatDateTime(viewed.publishedAt)}>
                    {formatRelativeTime(viewed.publishedAt)}
                  </time>
                ),
              })}
            </span>
            {newest.length > 1 ? (
              <VersionMenu versions={newest} currentId={viewed.id} onPick={setViewingId} />
            ) : null}
          </div>
          {viewedDetail === undefined ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {viewedDetail.files.map((file) => {
                const url = api.artifactVersionFileDownloadUrl(viewed.id, file.id);
                return (
                  <li key={file.id}>
                    <FileRow
                      name={file.fileName}
                      size={file.sizeBytes}
                      downloadUrl={url}
                      onPreview={setPreview}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {newest.length > 0 && (others.length > 0 || queue.length > 0) ? (
          <h3 className="m-0 mt-1 text-small font-semibold text-muted-foreground">{text.others}</h3>
        ) : null}
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
          {others.map((attachment) => (
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
      {publishing ? (
        <PublishArtifactDialog
          requirementId={requirementId}
          attachments={attachments.data?.items ?? []}
          latest={newest[0] === undefined ? undefined : detailById.get(newest[0].id)}
          onClose={() => setPublishing(false)}
          onPublished={(version) => setViewingId(version.id)}
        />
      ) : null}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent size="lg" className="max-w-[min(1100px,calc(100vw-32px))]">
          <DialogHeader>
            <DialogTitle className="truncate">{preview?.name}</DialogTitle>
            <DialogDescription className="sr-only">{text.imagePreview}</DialogDescription>
          </DialogHeader>
          {preview === null ? null : <ImagePreview key={preview.url} name={preview.name} url={preview.url} />}
        </DialogContent>
      </Dialog>
    </section>
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

function VersionMenu({
  versions,
  currentId,
  onPick,
}: {
  versions: ArtifactVersionDto[];
  currentId: string;
  onPick(id: string): void;
}) {
  const text = useT().requirementDetail.materials;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost">
          {text.history}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{text.allVersions}</DropdownMenuLabel>
        {versions.map((version, index) => (
          <DropdownMenuItem key={version.id} onSelect={() => onPick(version.id)}>
            <span className="flex-1">
              {text.versionItem(version.versionNumber, index === 0)}
              <span className="ml-1.5 text-subtle-foreground">
                {version.publishedBy.displayName} · {formatRelativeTime(version.publishedAt)}
              </span>
            </span>
            {version.id === currentId ? <CheckIcon className="size-4 text-primary-text!" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  onPreview?(preview: { name: string; url: string }): void;
  extra?: ReactNode;
}) {
  const text = useT().requirementDetail.materials;
  const kind = previewKind(name);
  const Icon = fileIconFor(name);
  return (
    <div className="group/file flex h-9 items-center gap-2.5 rounded-sm border border-border px-2.5 hover:bg-muted">
      <Icon className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-small" title={name}>{name}</span>
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

/** 剪贴板里的截图通常都叫 image.png：加上时间，免得一串同名文件。 */
function renamePastedImage(file: File, t: Messages): File {
  if (!/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const extension = file.name.split(".").at(-1) ?? "png";
  return new File([file], t.requirementDetail.materials.pastedImageName(stamp, extension), { type: file.type, lastModified: file.lastModified });
}
