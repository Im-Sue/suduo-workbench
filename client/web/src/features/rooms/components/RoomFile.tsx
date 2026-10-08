import type { RoomFileDto, RoomFileKind } from "@suduo/cloud-contracts";
import { DownloadIcon, EyeIcon, FileIcon, FileTextIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../../../api/client.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "../../requirements/format.js";
import { useT } from "../../../i18n/provider.js";

/**
 * 出缩略图的图片类型：浏览器能直接显示、远程也会按原类型内联给出的（file-types.ts 的 INLINE_AS_IS）。
 * svg 远程一律按附件给（可能带脚本），heic 浏览器显示不了，这两种按文件卡片。
 */
const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"]);

/** 能在消息、评论里显示的文件：房间文件与评论文件都有这几项。 */
export interface DisplayFile {
  id: string;
  fileName: string;
  contentType: string;
  kind: RoomFileKind;
  sizeBytes: number;
}

/** 文件地址：inline = 浏览器里直接看，否则下载。 */
export type FileUrl = (fileId: string, disposition?: "inline" | "attachment") => string;

export function canShowThumbnail(file: Pick<DisplayFile, "kind" | "contentType">): boolean {
  const type = file.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return file.kind === "image" && THUMBNAIL_TYPES.has(type);
}

/**
 * 消息里的文件（需求 4.4）：图片内联缩略（点开灯箱）、视频直接播放（可拖动进度，靠 Range 分段）、
 * 其他文件（含不能缩略的图片）一张卡片（名字、大小、下载）。
 */
export function RoomFiles({ files }: { files: readonly RoomFileDto[] }) {
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5" data-testid="room-files">
      <FileGallery files={files} urlFor={api.roomFileUrl} />
    </div>
  );
}

/**
 * 文件陈列（房间消息与需求评论共用）：缩略图 / 视频 / 文件卡片 + 大图预览。
 * `actions` 给每个文件追加操作（如评论文件的「存为附件」）：卡片上排在下载前，缩略图与视频下方单独一行。
 */
export function FileGallery({
  files,
  urlFor,
  actions,
  previewDocuments = false,
}: {
  files: readonly DisplayFile[];
  urlFor: FileUrl;
  actions?: (file: DisplayFile) => ReactNode;
  /** PDF 与文本类文件卡片上多一个「在新标签页预览」（评论文件按附件的规则可预览）。 */
  previewDocuments?: boolean;
}) {
  const t = useT();
  const [preview, setPreview] = useState<DisplayFile | null>(null);
  if (files.length === 0) return null;
  const withActions = (file: DisplayFile, node: ReactNode) =>
    actions === undefined ? (
      node
    ) : (
      <div key={file.id} className="flex flex-col items-start gap-1">
        {node}
        <div className="flex items-center gap-1">{actions(file)}</div>
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((file) => {
        if (canShowThumbnail(file)) {
          return withActions(
            file,
            <ImageThumbnail key={file.id} file={file} urlFor={urlFor} onOpen={() => setPreview(file)} />,
          );
        }
        if (file.kind === "video") {
          return withActions(
            file,
            <video
              key={file.id}
              controls
              preload="metadata"
              src={urlFor(file.id, "inline")}
              aria-label={t.rooms.files.video(file.fileName)}
              className="max-h-72 max-w-[min(420px,100%)] rounded-md bg-black"
              data-testid="room-video"
            />,
          );
        }
        return <FileCard key={file.id} file={file} urlFor={urlFor} extra={actions?.(file)} previewDocuments={previewDocuments} />;
      })}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent size="lg" className="max-w-[min(1100px,calc(100vw-32px))]">
          <DialogHeader>
            <DialogTitle className="truncate">{preview?.fileName}</DialogTitle>
            <DialogDescription className="sr-only">{t.rooms.files.imagePreview}</DialogDescription>
          </DialogHeader>
          {preview === null ? null : <Lightbox key={preview.id} file={preview} urlFor={urlFor} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 图片缩略：取不到 / 显示不了（onError）时退回文件卡片，不留破图。 */
function ImageThumbnail({
  file,
  urlFor,
  onOpen,
}: {
  file: DisplayFile;
  urlFor: FileUrl;
  onOpen(): void;
}) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  // 退回文件卡片时不再带操作：外层（withActions）已经在下方给过一次。
  if (broken) return <FileCard file={file} urlFor={urlFor} />;
  return (
    <button
      type="button"
      className="overflow-hidden rounded-md border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t.rooms.files.viewImage(file.fileName)}
      onClick={onOpen}
    >
      <img
        src={urlFor(file.id, "inline")}
        alt={file.fileName}
        loading="lazy"
        className="block max-h-48 max-w-[280px] object-cover"
        onError={() => setBroken(true)}
      />
    </button>
  );
}

function FileCard({
  file,
  urlFor,
  extra,
  previewDocuments = false,
}: {
  file: DisplayFile;
  urlFor: FileUrl;
  extra?: ReactNode;
  previewDocuments?: boolean;
}) {
  const t = useT();
  const document = file.contentType.startsWith("text/") || file.contentType === "application/pdf";
  const Icon = document ? FileTextIcon : FileIcon;
  return (
    <div className="flex h-12 max-w-[360px] min-w-[220px] items-center gap-2.5 rounded-md border border-border bg-card pr-1.5 pl-3" data-testid="room-file-card">
      <Icon className="size-5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-small font-medium text-foreground" title={file.fileName}>{file.fileName}</span>
        <span className="text-caption text-subtle-foreground">{formatBytes(file.sizeBytes)}</span>
      </div>
      {extra}
      {/* 文本按纯文本内联、html 与 svg 不内联（云端规则），这里只给 PDF 与 text/*（不含 html）开预览。 */}
      {previewDocuments && document && file.contentType !== "text/html" ? (
        <Button asChild size="icon-sm" variant="ghost">
          <a href={urlFor(file.id, "inline")} target="_blank" rel="noreferrer" aria-label={t.rooms.files.preview(file.fileName)}>
            <EyeIcon />
          </a>
        </Button>
      ) : null}
      <Button asChild size="icon-sm" variant="ghost">
        <a href={urlFor(file.id)} download={file.fileName} aria-label={t.rooms.files.download(file.fileName)}>
          <DownloadIcon />
        </a>
      </Button>
    </div>
  );
}

function Lightbox({ file, urlFor }: { file: DisplayFile; urlFor: FileUrl }) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md bg-muted px-6 py-10 text-center">
        <p className="m-0 text-small text-muted-foreground">{t.rooms.files.previewUnavailable}</p>
        <Button asChild variant="secondary">
          <a href={urlFor(file.id)} download={file.fileName}>
            <DownloadIcon />
            {t.rooms.files.downloadAction}
          </a>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <img
        src={urlFor(file.id, "inline")}
        alt={file.fileName}
        className="max-h-[70vh] w-full rounded-md bg-muted object-contain"
        onError={() => setBroken(true)}
      />
      <div className="flex justify-end">
        <Button asChild size="sm" variant="secondary">
          <a href={urlFor(file.id)} download={file.fileName}>
            <DownloadIcon />
            {t.rooms.files.downloadOriginal}
          </a>
        </Button>
      </div>
    </div>
  );
}
