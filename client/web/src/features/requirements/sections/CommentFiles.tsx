import { COMMENT_FILE_MAX_BYTES, REQUIREMENT_COMMENT_MAX_FILES, type CommentFileDto, type RoomFileKind } from "@suduo/cloud-contracts";
import { FileIcon, ImageIcon, RotateCwIcon, VideoIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { useT } from "../../../i18n/provider.js";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { formatBytes } from "../format.js";

/**
 * 评论框里待发的文件（需求附件评论文件与优先级 4.2 / R7）：
 * - 选、拖、粘贴进来只放进待发列表，不上传；点发送时才逐个上传，全部传好再发评论；
 * - 某个文件没传上去：评论不发出，那个文件标成失败，可重试或移除；已经传好的保留编号，再发时不重传；
 * - 至多 REQUIREMENT_COMMENT_MAX_FILES 个、单个不超过 300 MiB，超了当场说明。
 */
export interface PendingCommentFile {
  localId: string;
  file: File;
  kind: RoomFileKind;
  state: "pending" | "uploading" | "done" | "failed";
  progress: number;
  error: string | null;
  result: CommentFileDto | null;
}

/** 一次发送用到的文件：本地编号（用来从列表里拿掉）与云端结果（按顺序）。 */
export interface SentBatch {
  localIds: string[];
  files: CommentFileDto[];
}

export function useCommentFiles(requirementId: string) {
  const t = useT();
  const text = t.requirementDetail.comments;
  const [files, setFiles] = useState<PendingCommentFile[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  // 上传过程中按 localId 读最新状态（setState 是异步的）。
  const latest = useRef(files);
  latest.current = files;

  // 换了需求：待发文件不带过去。
  useEffect(() => {
    setFiles([]);
    setRejected(null);
  }, [requirementId]);

  const update = (localId: string, patch: Partial<PendingCommentFile>) =>
    setFiles((current) => current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)));

  const add = useCallback(
    (picked: readonly File[]) => {
      const reasons: string[] = [];
      const accepted: PendingCommentFile[] = [];
      let room = REQUIREMENT_COMMENT_MAX_FILES - latest.current.length;
      for (const file of picked) {
        if (file.size > COMMENT_FILE_MAX_BYTES) {
          reasons.push(text.fileTooLarge(file.name));
          continue;
        }
        if (room <= 0) {
          reasons.push(text.tooManyFiles(REQUIREMENT_COMMENT_MAX_FILES));
          break;
        }
        room -= 1;
        accepted.push({
          localId: crypto.randomUUID(),
          file,
          kind: fileKind(file),
          state: "pending",
          progress: 0,
          error: null,
          result: null,
        });
      }
      setRejected(reasons.length === 0 ? null : text.joinReasons(reasons));
      if (accepted.length > 0) setFiles((current) => [...current, ...accepted]);
    },
    [text],
  );

  const remove = (localId: string) => {
    setFiles((current) => current.filter((item) => item.localId !== localId));
    setRejected(null);
  };

  /**
   * 上传点发送那一刻列表里的文件（之后再加进来的留到下一次）。没传好的逐个上传；
   * 全部成功返回这批文件的本地编号与结果（按顺序），有失败返回 null（失败的标在列表里，再发只补传它们）。
   */
  const uploadAll = async (): Promise<SentBatch | null> => {
    const batch = latest.current;
    const results = new Map<string, CommentFileDto>();
    let failed = false;
    for (const item of batch) {
      if (item.state === "done" && item.result !== null) {
        results.set(item.localId, item.result);
        continue;
      }
      update(item.localId, { state: "uploading", progress: 0, error: null });
      try {
        const result = await api.uploadCommentFile(requirementId, item.file, (progress) => update(item.localId, { progress }));
        results.set(item.localId, result);
        update(item.localId, { state: "done", progress: 100, result });
      } catch (cause) {
        failed = true;
        update(item.localId, { state: "failed", error: classifyFailure(cause).message });
      }
    }
    if (failed) return null;
    return { localIds: batch.map((item) => item.localId), files: batch.map((item) => results.get(item.localId)!) };
  };

  /** 发出去的那一批从列表里拿掉（发送途中新加的留着）。 */
  const removeSent = (localIds: readonly string[]) => {
    const sent = new Set(localIds);
    setFiles((current) => current.filter((item) => !sent.has(item.localId)));
    setRejected(null);
  };

  /** 按云端文件编号拿掉（已随别的评论发出的文件）。 */
  const removeByFileIds = (fileIds: readonly string[]) => {
    const gone = new Set(fileIds);
    setFiles((current) => current.filter((item) => item.result === null || !gone.has(item.result.id)));
  };

  return { files, rejected, add, remove, uploadAll, removeSent, removeByFileIds };
}

function fileKind(file: File): RoomFileKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return "file";
}

/** 待发文件一行：名字、大小或进度、失败原因；可移除，失败的可重试（重试 = 再点发送时补传）。 */
export function PendingCommentFiles({
  files,
  busy,
  onRemove,
}: {
  files: readonly PendingCommentFile[];
  busy: boolean;
  onRemove(localId: string): void;
}) {
  const text = useT().requirementDetail.comments;
  if (files.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={text.pendingFiles} data-testid="comment-pending-files">
      {files.map((item) => {
        const Icon = item.kind === "image" ? ImageIcon : item.kind === "video" ? VideoIcon : FileIcon;
        return (
          <li
            key={item.localId}
            className={cn(
              "flex w-[210px] flex-col gap-1 rounded-sm px-2 py-1.5 text-caption",
              item.state === "failed" ? "bg-danger-soft" : "bg-muted",
            )}
            data-state={item.state}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-foreground" title={item.file.name}>{item.file.name}</span>
              {item.state === "failed" ? (
                <RotateCwIcon className="size-3 shrink-0 text-danger" aria-label={text.willRetry} />
              ) : null}
              <button
                type="button"
                disabled={busy}
                className="inline-flex size-5 items-center justify-center rounded-xs text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                aria-label={text.removeFile(item.file.name)}
                onClick={() => onRemove(item.localId)}
              >
                <XIcon className="size-3" />
              </button>
            </span>
            {item.state === "uploading" ? (
              <Progress value={item.progress} aria-label={text.fileProgress(item.file.name)} />
            ) : item.state === "failed" ? (
              <span className="truncate text-danger" title={item.error ?? undefined}>{item.error ?? text.fileFailed}</span>
            ) : (
              <span className="text-subtle-foreground">{formatBytes(item.file.size)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
