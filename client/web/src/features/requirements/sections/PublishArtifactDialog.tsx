import { useQueryClient } from "@tanstack/react-query";
import { REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT } from "@suduo/cloud-contracts";
import { useRef, useState } from "react";
import {
  api,
  ApiClientError,
  type ArtifactVersionDetailDto,
  type RequirementsAttachmentDto,
} from "../../../api/client.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { InlineError } from "../../../feedback/components/index.js";
import type { Failure } from "../../../feedback/types.js";
import { showMessage } from "../../../ui/message.js";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "../format.js";
import { requirementKeys } from "../keys.js";

/**
 * 发布确认版：勾选这一版包含的材料（默认沿用上一版 + 上一版之后新传的材料），可写一句这一版改了什么。
 * 幂等键跟着内容走：同样的勾选和说明重试沿用同一个键，网络中断后点「重试」不会发出第二个版本；
 * 改了勾选或说明就是另一次发布。对话框开着时有人先发了一版，不拦着，只说明一句（ADR-0004）。
 */
export function PublishArtifactDialog({
  requirementId,
  attachments,
  latest,
  onClose,
  onPublished,
}: {
  requirementId: string;
  attachments: RequirementsAttachmentDto[];
  latest: ArtifactVersionDetailDto | undefined;
  onClose(): void;
  onPublished(version: ArtifactVersionDetailDto): void;
}) {
  const queryClient = useQueryClient();
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  const openedWith = useRef(latest?.id);
  const inLatest = new Set(latest?.files.map((file) => file.attachmentId) ?? []);
  const isNew = (attachment: RequirementsAttachmentDto) =>
    latest !== undefined && !inLatest.has(attachment.id) && Date.parse(attachment.createdAt) > Date.parse(latest.publishedAt);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(attachments.filter((item) => latest === undefined || inLatest.has(item.id) || isNew(item)).map((item) => item.id)),
  );
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [touched, setTouched] = useState(false);
  const nextNumber = (latest?.versionNumber ?? 0) + 1;
  const publishedMeanwhile = latest !== undefined && latest.id !== openedWith.current ? latest : null;
  const overLimit = selected.size > REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT;
  const selectionError = touched && selected.size === 0
    ? "至少选一份材料"
    : overLimit
      ? `一个版本最多 ${REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT} 个文件`
      : undefined;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const publish = async () => {
    setTouched(true);
    if (selected.size === 0 || overLimit || submitting) return;
    setSubmitting(true);
    setFailure(null);
    const attachmentIds = attachments.filter((item) => selected.has(item.id)).map((item) => item.id);
    const trimmedNote = note.trim();
    const fingerprint = JSON.stringify([attachmentIds, trimmedNote]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { key: crypto.randomUUID(), fingerprint };
    try {
      const version = await api.publishArtifactVersion(requirementId, {
        operationKey: attempt.current.key,
        attachmentIds,
        ...(trimmedNote === "" ? {} : { note: trimmedNote }),
      });
      queryClient.setQueryData([...requirementKeys.artifacts(requirementId), version.id], version);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: requirementKeys.artifacts(requirementId), exact: true }),
        queryClient.invalidateQueries({ queryKey: requirementKeys.activity(requirementId) }),
        queryClient.invalidateQueries({ queryKey: requirementKeys.detail(requirementId) }),
      ]);
      onPublished(version);
      showMessage(`已发布确认版 · 第 ${version.versionNumber} 版`, "success");
      onClose();
    } catch (cause) {
      // 可能其实已经发出去了（响应丢失）：刷新版本列表，新版本出现时上方会说明。
      void queryClient.invalidateQueries({ queryKey: requirementKeys.artifacts(requirementId), exact: true });
      const failure = classifyFailure(cause);
      setFailure(
        cause instanceof ApiClientError && cause.code === "IDEMPOTENCY_CONFLICT"
          ? { ...failure, message: "刚才那次发布可能已经成功，确认版列表已刷新，请先看一眼再决定是否重发" }
          : failure,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent size="md" data-testid="publish-artifact-dialog">
        <DialogHeader>
          <DialogTitle>发布确认版 · 第 {nextNumber} 版</DialogTitle>
          <DialogDescription>
            确认版是团队对齐后的材料组合，发布后全组可见，不能修改。
          </DialogDescription>
        </DialogHeader>
        {publishedMeanwhile === null ? null : (
          <p className="m-0 rounded-md bg-warning-soft px-3 py-2 text-small" role="status">
            {publishedMeanwhile.publishedBy.displayName} 刚刚发布了第 {publishedMeanwhile.versionNumber} 版。继续发布会成为第 {nextNumber} 版。
          </p>
        )}
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-small font-medium">包含的材料（{selected.size}）</legend>
          <ul className="m-0 flex max-h-64 list-none flex-col gap-0.5 overflow-y-auto p-0" aria-invalid={selectionError !== undefined}>
            {attachments.map((attachment) => {
              const id = `publish-${attachment.id}`;
              return (
                <li key={attachment.id}>
                  <label htmlFor={id} className="flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2 hover:bg-muted">
                    <Checkbox id={id} checked={selected.has(attachment.id)} onCheckedChange={() => toggle(attachment.id)} />
                    <span className="min-w-0 flex-1 truncate text-small">{attachment.fileName}</span>
                    {isNew(attachment) ? (
                      <span className="shrink-0 text-caption text-primary-text">新</span>
                    ) : null}
                    <span className="shrink-0 text-caption text-subtle-foreground">{formatBytes(attachment.sizeBytes)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {selectionError === undefined ? null : <InlineError kind="validation">{selectionError}</InlineError>}
        </fieldset>
        <Field label="这一版改了什么" hint="可不填；会显示在活动里，方便大家了解变化。">
          <Textarea rows={3} maxLength={4000} value={note} placeholder="例如：补充导出上限与保留期" onChange={(event) => setNote(event.target.value)} />
        </Field>
        {failure === null ? null : <InlineError kind={failure.kind}>没能发布：{failure.message}</InlineError>}
        <DialogFooter>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>取消</Button>
          <Button variant="primary" loading={submitting} onClick={() => void publish()}>
            {failure === null ? `发布第 ${nextNumber} 版` : "重试发布"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
