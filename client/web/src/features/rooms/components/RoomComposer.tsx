import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ROOM_FILE_MAX_BYTES, type RoomDto, type UserSummaryDto } from "@suduo/cloud-contracts";
import { ArchiveIcon, FileIcon, ImageIcon, PaperclipIcon, RotateCwIcon, SendHorizontalIcon, VideoIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { settingsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { InlineError } from "../../../feedback/components/index.js";
import { useT } from "../../../i18n/provider.js";
import { showMessage } from "../../../ui/message.js";
import { formatBytes } from "../../requirements/format.js";
import {
  addDraftFiles,
  collectMentions,
  draftKey,
  removeDraftFile,
  retryDraftFile,
  updateDraft,
  useRoomDraft,
  type DraftFile,
  type PickedMention,
} from "../drafts.js";
import { agentName, buildMentionCandidates, type MentionCandidate } from "../model.js";
import { newClientId, sendRoomMessage } from "../pending.js";
import { agentsQuery, membersQuery, shareRequestsQuery, sharesQuery, useRequestShare } from "../queries.js";
import { candidateSelectable, MentionPicker, optionId } from "./MentionPicker.js";

/**
 * 房间输入框（需求十一）：Enter 发送、Shift+Enter 换行、拼音选字的回车不发送；
 * `@` 弹候选（真人在前、Agent 在后，不可用的置灰说明原因；离线的照样可 @，未共享的回车即申请共享；
 * 当前项不能选时回车照常发送）；
 * 粘贴 / 拖放 / 选择文件立即上传（带进度、可移除、失败可重试）；归档的房间只读。
 * 发送：先本地占位，失败把内容放回这里并原地提示，再发沿用同一个 clientId。
 */
// 「@」前面不能是字母数字（免得把邮箱当成 @）；中文后面直接打 @ 也能弹候选。
const MENTION_TRIGGER = /(?:^|[^A-Za-z0-9_.@])@([^\s@]{0,32})$/;

interface PickerState {
  /** 「@」在正文里的位置。 */
  start: number;
  query: string;
  index: number;
}

export function RoomComposer({
  room,
  threadRootId,
  placeholder,
  autoFocus = false,
}: {
  room: RoomDto;
  threadRootId: string | null;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const t = useT();
  const text = t.rooms.composer;
  const queryClient = useQueryClient();
  const key = draftKey(room.id, threadRootId);
  const [draft, update] = useRoomDraft(key);
  const settings = useQuery(settingsQuery).data;
  const meUser = settings?.session?.user ?? null;
  const me: UserSummaryDto | null = meUser === null ? null : { id: meUser.id, displayName: meUser.displayName };
  const archived = room.archivedAt !== null;
  const members = useQuery({ ...membersQuery(room.id), enabled: !archived });
  const agents = useQuery({ ...agentsQuery, enabled: !archived });
  const shares = useQuery({ ...sharesQuery(room.id), enabled: !archived });
  const requests = useQuery({ ...shareRequestsQuery(room.id), enabled: !archived });
  const requestShare = useRequestShare(room.id);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const listboxId = `room-mention-${room.id}-${threadRootId ?? "main"}`;

  const requestedAgentIds = useMemo(
    () => new Set((requests.data?.items ?? []).filter((item) => item.requester.id === me?.id && item.status === "pending").map((item) => item.agent.id)),
    [requests.data, me?.id],
  );
  const candidates = useMemo(
    () =>
      picker === null
        ? []
        : buildMentionCandidates(
            {
              members: members.data?.items ?? [],
              agents: agents.data?.items ?? [],
              shares: shares.data?.items ?? [],
              requestedAgentIds,
              meId: me?.id ?? null,
              query: picker.query,
            },
            t,
          ),
    [picker, members.data, agents.data, shares.data, requestedAgentIds, me?.id, t],
  );

  // 输入框随内容长高（最多 200px）；插入 @ 后把光标放到插入内容之后。
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${String(Math.min(element.scrollHeight, 200))}px`;
    if (pendingCaret.current !== null) {
      element.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [draft.text]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const uploading = draft.files.some((file) => file.state === "uploading");
  const doneFiles = draft.files.filter((file) => file.state === "done" && file.result !== null);
  const canSend = !archived && !uploading && (draft.text.trim() !== "" || doneFiles.length > 0);

  const syncPicker = (value: string, caret: number) => {
    const match = MENTION_TRIGGER.exec(value.slice(0, caret));
    if (match === null) {
      setPicker(null);
      return;
    }
    const query = match[1] ?? "";
    const start = caret - query.length - 1;
    setPicker((current) => (current !== null && current.start === start && current.query === query ? current : { start, query, index: 0 }));
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    update((current) => ({ ...current, text: value, error: null }));
    syncPicker(value, event.target.selectionStart);
  };

  const pick = (candidate: MentionCandidate) => {
    if (picker === null) return;
    if (!candidateSelectable(candidate)) return;
    if (candidate.kind === "agent" && candidate.availability === "unshared") {
      // 未共享：选中 = 向所有者申请共享（不插入，@ 了也只会「离线，未执行」）。
      // 离线但已共享的照常插入：发出后消息下显示「离线，未执行」，之后可重试。
      setPicker(null);
      requestShare.mutate(candidate.id, {
        onSuccess: () => showMessage(text.shareRequested(candidate.agent.owner.displayName, agentName(candidate.agent, t)), "success"),
      });
      return;
    }
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? draft.text.length;
    const insert = `@${candidate.text} `;
    const next = `${draft.text.slice(0, picker.start)}${insert}${draft.text.slice(Math.max(caret, picker.start))}`;
    const mention: PickedMention = { kind: candidate.kind, id: candidate.id, text: candidate.text };
    pendingCaret.current = picker.start + insert.length;
    update((current) => ({ ...current, text: next, picked: [...current.picked, mention] }));
    setPicker(null);
    element?.focus();
  };

  const send = () => {
    if (!canSend) return;
    const body = draft.text.trim();
    const files = doneFiles;
    const fileIds = files.map((file) => file.result?.id ?? "");
    const retry = draft.retry;
    // 失败后原样再发：沿用那次的 clientId（服务端按它合并，响应丢了也不会多出一条）。
    const clientId =
      retry !== null && retry.body === body && retry.fileIds.join(",") === fileIds.join(",") ? retry.clientId : newClientId();
    const mentions = collectMentions(body, draft.picked);
    const picked = draft.picked;
    update((current) => ({
      ...current,
      text: "",
      files: current.files.filter((file) => !files.some((sent) => sent.localId === file.localId)),
      picked: [],
      retry: null,
      error: null,
    }));
    setPicker(null);
    void sendRoomMessage(queryClient, {
      clientId,
      roomId: room.id,
      threadRootId,
      body,
      mentions,
      files: files.flatMap((file) => (file.result === null ? [] : [file.result])),
      author: me,
      createdAt: new Date().toISOString(),
    }).catch((cause: unknown) => {
      // 没发出去：内容放回输入框（输入框里已有新写的字时接在后面），原地提示，可直接再发。
      updateDraft(key, (current) => ({
        ...current,
        text: current.text.trim() === "" ? body : `${body}\n${current.text}`,
        files: [...files, ...current.files.filter((file) => !files.some((sent) => sent.localId === file.localId))],
        picked: [...picked, ...current.picked],
        retry: { clientId, body, fileIds },
        error: classifyFailure(cause),
      }));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (composing) return; // 拼音输入的回车是选字，不发送也不选候选
    if (picker !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = candidates.length;
        if (count > 0) {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setPicker({ ...picker, index: (picker.index + delta + count) % count });
        }
        return;
      }
      // 当前项能选才拦下回车 / Tab；不能选的（自己没共享的、已申请过的）不吞回车，照常发送。
      const candidate = candidates[picker.index];
      if ((event.key === "Enter" || event.key === "Tab") && candidate !== undefined && candidateSelectable(candidate)) {
        event.preventDefault();
        pick(candidate);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPicker(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const takeFiles = (files: readonly File[]) => {
    if (files.length > 0 && !archived) addDraftFiles(key, room.id, files);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    takeFiles(files);
  };

  if (archived) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3.5 py-3 text-small text-subtle-foreground" data-testid="room-composer-archived">
        <ArchiveIcon className="size-4 shrink-0" aria-hidden="true" />
        {text.archived}
      </div>
    );
  }

  const active = picker === null ? null : candidates[picker.index];
  return (
    <div
      className="relative"
      data-testid="room-composer"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        takeFiles([...event.dataTransfer.files]);
      }}
    >
      {draft.error === null ? null : (
        <div className="mb-1.5 flex items-center gap-2" data-testid="room-send-error">
          <InlineError kind={draft.error.kind}>{text.sendFailed(draft.error.message)}</InlineError>
          <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={send} disabled={!canSend}>
            <RotateCwIcon className="size-3" />
            {text.retry}
          </Button>
        </div>
      )}
      <div
        className={cn(
          "relative rounded-lg border bg-card shadow-1 transition-colors focus-within:border-border-strong",
          dragActive ? "border-primary bg-primary-soft" : "border-border",
        )}
      >
        {dragActive ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg text-small font-medium text-primary-text">
            {text.dropFiles}
          </div>
        ) : null}
        {picker === null ? null : (
          <MentionPicker
            id={listboxId}
            candidates={candidates}
            activeIndex={picker.index}
            loading={members.isPending || agents.isPending}
            onPick={pick}
            onHover={(index) => setPicker({ ...picker, index })}
          />
        )}
        {draft.files.length === 0 ? null : (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 px-3 pt-2.5 pb-0" aria-label={text.filesLabel}>
            {draft.files.map((file) => (
              <DraftFileChip
                key={file.localId}
                file={file}
                onRemove={() => removeDraftFile(key, file.localId)}
                onRetry={() => retryDraftFile(key, room.id, file.localId)}
              />
            ))}
          </ul>
        )}
        <label htmlFor={`${listboxId}-input`} className="sr-only">
          {threadRootId === null ? text.messageLabel(room.name) : text.replyLabel}
        </label>
        <textarea
          id={`${listboxId}-input`}
          ref={textareaRef}
          rows={1}
          value={draft.text}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={picker !== null}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={picker === null || active === undefined ? undefined : optionId(listboxId, picker.index)}
          data-testid="room-composer-input"
          className="block max-h-[200px] min-h-11 w-full resize-none overflow-y-auto border-0 bg-transparent px-3.5 pt-2.5 pb-1 text-body text-foreground outline-none placeholder:text-subtle-foreground"
          onChange={onChange}
          onSelect={(event) => {
            const target = event.currentTarget;
            if (target.selectionStart === target.selectionEnd) syncPicker(target.value, target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setPicker(null)}
        />
        <div className="flex items-center gap-1 px-2 pt-1 pb-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-small text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            title={text.attachTitle}
            data-testid="room-attach"
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon className="size-3.5" aria-hidden="true" />
            {text.attach}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-label={text.fileInputLabel}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              takeFiles(files);
            }}
          />
          <button
            type="button"
            className="inline-flex h-7 items-center rounded-sm px-2 text-small text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            title={text.mentionTitle}
            aria-label={text.mentionLabel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const element = textareaRef.current;
              const caret = element?.selectionStart ?? draft.text.length;
              const needsSpace = caret > 0 && !/\s$/.test(draft.text.slice(0, caret));
              const insert = `${needsSpace ? " " : ""}@`;
              const next = `${draft.text.slice(0, caret)}${insert}${draft.text.slice(caret)}`;
              pendingCaret.current = caret + insert.length;
              update((current) => ({ ...current, text: next }));
              setPicker({ start: caret + insert.length - 1, query: "", index: 0 });
              element?.focus();
            }}
          >
            @
          </button>
          {/* 话题面板里的输入框较窄：提示放不下时省略，不换成两行。 */}
          <span className="ml-1 hidden min-w-0 truncate text-caption text-subtle-foreground sm:inline" title={text.keyHint}>
            {text.keyHint}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring disabled:bg-muted-strong disabled:text-disabled-foreground"
            data-testid="room-send"
            disabled={!canSend}
            title={uploading ? text.waitForUpload : text.sendTitle}
            aria-label={text.send}
            onClick={send}
          >
            <SendHorizontalIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

function DraftFileChip({ file, onRemove, onRetry }: { file: DraftFile; onRemove(): void; onRetry(): void }) {
  const text = useT().rooms.composer.file;
  const Icon = file.kind === "image" ? ImageIcon : file.kind === "video" ? VideoIcon : FileIcon;
  return (
    <li
      className={cn(
        "flex w-[200px] flex-col gap-1 rounded-sm px-2 py-1.5 text-caption",
        file.state === "failed" ? "bg-danger-soft" : "bg-muted",
      )}
      data-testid="room-draft-file"
      data-state={file.state}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-foreground" title={file.name}>{file.name}</span>
        {file.state === "failed" && file.size <= ROOM_FILE_MAX_BYTES ? (
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-xs text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={text.retry(file.name)}
            onClick={onRetry}
          >
            <RotateCwIcon className="size-3" />
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-xs text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label={text.remove(file.name)}
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </button>
      </span>
      {file.state === "uploading" ? (
        <Progress value={file.progress} aria-label={text.progress(file.name)} />
      ) : file.state === "failed" ? (
        <span className="truncate text-danger" title={file.error ?? undefined}>{file.error ?? text.failed}</span>
      ) : (
        <span className="text-subtle-foreground">{formatBytes(file.size)}</span>
      )}
    </li>
  );
}
