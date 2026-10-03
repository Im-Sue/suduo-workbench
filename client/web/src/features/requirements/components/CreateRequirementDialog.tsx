import { useQueryClient } from "@tanstack/react-query";
import { type RequirementListItemDto } from "@suduo/client-contracts";
import {
  REQUIREMENT_STATUS_LABELS,
  REQUIREMENTS_WEB_ATTACHMENT_UPLOAD_PRECHECK_LIMIT,
  type RequirementStatus,
  type UserSummaryDto,
} from "@suduo/cloud-contracts";
import { ChevronRightIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { classifyFailure } from "../../../feedback/classify.js";
import { InlineError } from "../../../feedback/components/index.js";
import type { Failure } from "../../../feedback/types.js";
import { showMessage } from "../../../ui/message.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { StatusIcon } from "@/components/ui/status-icon";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatBytes, requirementCode } from "../format.js";
import { useCreateRequirement } from "../queries.js";
import { highlightRequirement } from "../highlight.js";
import { enqueueUploads, precheck } from "../upload-queue.js";
import { AssigneeMenu } from "./AssigneeMenu.js";
import { StatusMenu } from "./StatusMenu.js";
import { UserAvatar } from "./UserAvatar.js";

const TITLE_MAX = 200;
const SUMMARY_MAX = 4000;

/**
 * 新建需求（原型 Main · 新建）：只有标题必填；状态按入口预填（列头「+」带该列状态，修复「列内新建错状态」）；
 * 负责人默认是自己；可先选材料，创建后自动上传；⌘⏎ 创建；「继续新建下一条」保留状态与负责人。
 * 有未保存内容时，关闭需要确认。
 */
export function CreateRequirementDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  initialStatus,
  currentUser,
  onView,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  projectId: string;
  projectName: string;
  initialStatus: RequirementStatus;
  currentUser: UserSummaryDto | null;
  /** 提示里点「查看」：打开新建的需求。 */
  onView(requirement: RequirementListItemDto): void;
}) {
  const queryClient = useQueryClient();
  const create = useCreateRequirement(projectId);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<RequirementStatus>(initialStatus);
  const [assignee, setAssignee] = useState<UserSummaryDto | null>(currentUser);
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [titleError, setTitleError] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 每次打开都按入口重新预填。
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setSummary("");
    setStatus(initialStatus);
    setAssignee(currentUser);
    setFiles([]);
    setRejected(null);
    setTitleError(false);
    setFailure(null);
    setConfirmingDiscard(false);
  }, [open, initialStatus, currentUser]);

  // 选文件时就按大小、数量上限预检，放不进去的当场说明，不等创建后才失败。
  const addFiles = (picked: readonly File[]) => {
    const accepted: File[] = [];
    const reasons: string[] = [];
    let room = REQUIREMENTS_WEB_ATTACHMENT_UPLOAD_PRECHECK_LIMIT - files.length;
    for (const file of picked) {
      const reason = precheck(file, room);
      if (reason === null) {
        accepted.push(file);
        room -= 1;
      } else {
        reasons.push(`「${file.name}」${reason}`);
      }
    }
    setRejected(reasons.length === 0 ? null : reasons.slice(0, 3).join("；") + (reasons.length > 3 ? ` 等 ${reasons.length} 个文件` : ""));
    if (accepted.length > 0) setFiles((current) => [...current, ...accepted]);
  };

  const dirty = title.trim() !== "" || summary.trim() !== "" || files.length > 0;

  const requestClose = () => {
    if (create.isPending) return;
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === "") {
      setTitleError(true);
      titleRef.current?.focus();
      return;
    }
    if (create.isPending) return;
    setFailure(null);
    try {
      const created = await create.mutateAsync({
        title: trimmed,
        ...(summary.trim() === "" ? {} : { summary }),
        status,
        assigneeId: assignee?.id ?? null,
      });
      if (files.length > 0) {
        // 对话框多半已关掉：材料传失败时单独提示，并给「查看」回到这条需求重试。
        enqueueUploads(queryClient, created.id, files, 0, {
          onFailed: (item) =>
            showMessage(`${requirementCode(created.number)} 的材料「${item.file.name}」没能上传`, "error", {
              id: `create-upload-${item.id}`,
              action: { label: "查看", onClick: () => onView(created) },
            }),
        });
      }
      highlightRequirement(created.id);
      showMessage(
        `已创建 ${requirementCode(created.number)}${files.length > 0 ? `，${files.length} 份材料正在上传` : ""}`,
        "success",
        { action: { label: "查看", onClick: () => onView(created) } },
      );
      if (more) {
        setTitle("");
        setSummary("");
        setFiles([]);
        setRejected(null);
        setTitleError(false);
        titleRef.current?.focus();
      } else {
        onOpenChange(false);
      }
    } catch (cause) {
      setFailure(classifyFailure(cause));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent
        size="lg"
        showCloseButton={false}
        className="top-[max(12vh,48px)] max-w-[600px] translate-y-0 gap-0 p-0"
        data-testid="create-requirement-dialog"
        onEscapeKeyDown={(event) => {
          if (dirty) {
            event.preventDefault();
            setConfirmingDiscard(true);
          }
        }}
      >
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        >
          <div className="flex items-center gap-2 px-5 pt-4">
            <Badge className="max-w-48 truncate">{projectName}</Badge>
            <ChevronRightIcon className="size-3 text-subtle-foreground" aria-hidden="true" />
            <DialogTitle className="text-small font-medium">新建需求</DialogTitle>
            <DialogDescription className="sr-only">只有标题必填，其余可以稍后补充。</DialogDescription>
            <Button type="button" size="icon-sm" variant="ghost" className="ml-auto" aria-label="关闭" onClick={requestClose}>
              <XIcon />
            </Button>
          </div>

          {confirmingDiscard ? (
            <div
              className="mx-5 mt-3 flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-small"
              role="alertdialog"
              aria-label="放弃这条需求？"
              data-testid="form-dialog-discard"
            >
              <span className="flex-1">放弃这条还没创建的需求？</span>
              <Button autoFocus size="sm" type="button" variant="ghost" onClick={() => setConfirmingDiscard(false)}>
                继续编辑
              </Button>
              <Button size="sm" type="button" variant="danger" onClick={() => onOpenChange(false)}>
                放弃
              </Button>
            </div>
          ) : null}

          <div className="flex flex-col gap-2.5 px-5 pt-3 pb-4">
            <label htmlFor="new-requirement-title" className="sr-only">需求标题</label>
            <input
              ref={titleRef}
              id="new-requirement-title"
              autoFocus
              maxLength={TITLE_MAX}
              placeholder="需求标题"
              aria-invalid={titleError || undefined}
              aria-describedby={titleError ? "new-requirement-title-error" : undefined}
              className="h-10 w-full border-0 bg-transparent px-0.5 text-[18px] leading-7 font-semibold text-foreground outline-none placeholder:text-disabled-foreground"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                if (event.target.value.trim() !== "") setTitleError(false);
              }}
            />
            {titleError ? (
              <p id="new-requirement-title-error" className="m-0 text-caption text-danger" role="alert">
                写一个标题，方便大家在看板上认出它
              </p>
            ) : null}
            <label htmlFor="new-requirement-summary" className="sr-only">描述</label>
            <textarea
              id="new-requirement-summary"
              rows={4}
              maxLength={SUMMARY_MAX}
              placeholder="补充背景、目标或验收标准，支持 Markdown（可稍后再写）"
              className="min-h-24 w-full resize-y border-0 bg-transparent px-0.5 text-body text-foreground outline-none placeholder:text-disabled-foreground"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <StatusMenu
                status={status}
                onChange={setStatus}
                trigger={
                  <button type="button" className={CHIP} aria-label={`状态：${REQUIREMENT_STATUS_LABELS[status]}`}>
                    <StatusIcon status={status} aria-hidden="true" />
                    {REQUIREMENT_STATUS_LABELS[status]}
                  </button>
                }
              />
              <AssigneeMenu assignee={assignee} currentUserId={currentUser?.id ?? null} onChange={setAssignee}>
                <button type="button" className={CHIP} aria-label={`负责人：${assignee?.displayName ?? "未指派"}`}>
                  <UserAvatar user={assignee} size="sm" />
                  {assignee?.displayName ?? "未指派"}
                </button>
              </AssigneeMenu>
              <button type="button" className={cn(CHIP, "border-dashed")} onClick={() => fileRef.current?.click()}>
                <PaperclipIcon className="size-3.5" aria-hidden="true" />
                添加材料
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  if (picked.length > 0) addFiles(picked);
                }}
              />
            </div>
            {files.length === 0 ? null : (
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="待上传的材料">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex h-7 max-w-full items-center gap-1.5 rounded-sm bg-muted pr-1 pl-2 text-caption"
                  >
                    <span className="max-w-56 truncate">{file.name}</span>
                    <span className="text-subtle-foreground">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      aria-label={`移除 ${file.name}`}
                      className="inline-flex size-5 items-center justify-center rounded-xs text-subtle-foreground hover:bg-muted-strong hover:text-foreground"
                      onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {rejected === null ? null : <InlineError kind="validation">{rejected}</InlineError>}
            {failure === null ? null : <InlineError kind={failure.kind}>没能创建：{failure.message}</InlineError>}
          </div>

          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <label className="flex cursor-pointer items-center gap-2 text-small text-muted-foreground">
              <Switch checked={more} onCheckedChange={setMore} aria-label="继续新建下一条" />
              继续新建下一条
            </label>
            <div className="flex-1" />
            <Button type="button" variant="secondary" onClick={requestClose}>取消</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              创建需求
              <Kbd className="ml-1">⌘⏎</Kbd>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const CHIP =
  "inline-flex h-7 items-center gap-1.5 rounded-sm border border-border-strong bg-transparent px-2.5 text-caption font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted";
