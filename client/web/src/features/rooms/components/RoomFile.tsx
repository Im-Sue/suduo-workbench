import type { RoomFileDto } from "@suduo/cloud-contracts";
import { DownloadIcon, FileIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";
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

export function canShowThumbnail(file: Pick<RoomFileDto, "kind" | "contentType">): boolean {
  const type = file.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return file.kind === "image" && THUMBNAIL_TYPES.has(type);
}

/**
 * 消息里的文件（需求 4.4）：图片内联缩略（点开灯箱）、视频直接播放（可拖动进度，靠 Range 分段）、
 * 其他文件（含不能缩略的图片）一张卡片（名字、大小、下载）。
 */
export function RoomFiles({ files }: { files: readonly RoomFileDto[] }) {
  const t = useT();
  const [preview, setPreview] = useState<RoomFileDto | null>(null);
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2" data-testid="room-files">
      {files.map((file) => {
        if (canShowThumbnail(file)) return <ImageThumbnail key={file.id} file={file} onOpen={() => setPreview(file)} />;
        if (file.kind === "video") {
          return (
            <video
              key={file.id}
              controls
              preload="metadata"
              src={api.roomFileUrl(file.id, "inline")}
              aria-label={t.rooms.files.video(file.fileName)}
              className="max-h-72 max-w-[min(420px,100%)] rounded-md bg-black"
              data-testid="room-video"
            />
          );
        }
        return <FileCard key={file.id} file={file} />;
      })}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent size="lg" className="max-w-[min(1100px,calc(100vw-32px))]">
          <DialogHeader>
            <DialogTitle className="truncate">{preview?.fileName}</DialogTitle>
            <DialogDescription className="sr-only">{t.rooms.files.imagePreview}</DialogDescription>
          </DialogHeader>
          {preview === null ? null : <Lightbox key={preview.id} file={preview} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 图片缩略：取不到 / 显示不了（onError）时退回文件卡片，不留破图。 */
function ImageThumbnail({ file, onOpen }: { file: RoomFileDto; onOpen(): void }) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  if (broken) return <FileCard file={file} />;
  return (
    <button
      type="button"
      className="overflow-hidden rounded-md border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t.rooms.files.viewImage(file.fileName)}
      onClick={onOpen}
    >
      <img
        src={api.roomFileUrl(file.id, "inline")}
        alt={file.fileName}
        loading="lazy"
        className="block max-h-48 max-w-[280px] object-cover"
        onError={() => setBroken(true)}
      />
    </button>
  );
}

function FileCard({ file }: { file: RoomFileDto }) {
  const t = useT();
  const Icon = file.contentType.startsWith("text/") || file.contentType === "application/pdf" ? FileTextIcon : FileIcon;
  return (
    <div className="flex h-12 max-w-[320px] min-w-[220px] items-center gap-2.5 rounded-md border border-border bg-card pr-1.5 pl-3" data-testid="room-file-card">
      <Icon className="size-5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-small font-medium text-foreground" title={file.fileName}>{file.fileName}</span>
        <span className="text-caption text-subtle-foreground">{formatBytes(file.sizeBytes)}</span>
      </div>
      <Button asChild size="icon-sm" variant="ghost">
        <a href={api.roomFileUrl(file.id)} download={file.fileName} aria-label={t.rooms.files.download(file.fileName)}>
          <DownloadIcon />
        </a>
      </Button>
    </div>
  );
}

function Lightbox({ file }: { file: RoomFileDto }) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md bg-muted px-6 py-10 text-center">
        <p className="m-0 text-small text-muted-foreground">{t.rooms.files.previewUnavailable}</p>
        <Button asChild variant="secondary">
          <a href={api.roomFileUrl(file.id)} download={file.fileName}>
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
        src={api.roomFileUrl(file.id, "inline")}
        alt={file.fileName}
        className="max-h-[70vh] w-full rounded-md bg-muted object-contain"
        onError={() => setBroken(true)}
      />
      <div className="flex justify-end">
        <Button asChild size="sm" variant="secondary">
          <a href={api.roomFileUrl(file.id)} download={file.fileName}>
            <DownloadIcon />
            {t.rooms.files.downloadOriginal}
          </a>
        </Button>
      </div>
    </div>
  );
}
