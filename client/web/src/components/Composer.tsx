import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { SendMessageAccepted, SessionListItemDto, SkillDto } from "@suduo/client-contracts";
import { api } from "../api/client.js";
import { formatBytes, formatDuration, isSubPath, messageOf } from "../ui/format.js";
import { ArrowUpIcon, FileIcon, ImageIcon, MessagesSquareIcon, SquareIcon, XIcon, ZapIcon } from "lucide-react";
import { sessionLinkText } from "../features/sessions/session-links.js";
import type { SessionUiStatus } from "../ui/session-status.js";
import type { ContextUsage } from "../event-projection/timeline.js";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useCarried, useCarrySource, useLossCheck, useT } from "../i18n/provider.js";
import {
  buildMessageContent,
  type PausedReason,
  type QueueItem,
  type QueueStatus,
} from "../session/queue.js";

/**
 * 输入框里的附件草稿：只需要 id 就能发送；size 只用于 chip 显示，
 * 从队列取回时可能没有（不伪造 AttachmentDto，它的 size 必填）。
 */
export interface DraftAttachment {
  id: string;
  size?: number;
}

/** 排队的一份草稿（PR5）：与发送用同一套内容组装；skill 连 name 一起交出去。 */
export interface QueueDraft {
  text: string;
  skill: { name: string; path: string } | undefined;
  attachmentIds: string[];
}

/**
 * Composer 收到的队列视图与动作（PR5）。队列状态机与出队都在宿主（SessionRuntime），
 * Composer 只负责布局、入口与把项取回输入框。
 */
export interface ComposerQueue {
  items: readonly QueueItem[];
  status: QueueStatus;
  pausedReason: PausedReason | null;
  onEnqueue(draft: QueueDraft): void;
  onRemove(id: string): void;
  onUpdate(id: string, text: string): void;
  /** 取回：宿主从队列移除并把项交回；Composer 把它填进输入框。 */
  onTake(id: string): QueueItem | null;
  onResume(): void;
}

/**
 * 对话栏运行态（PR3）：状态行 + 停止控件的输入。判定来自 `sessionUiStatus`（与顶栏徽章同一函数），
 * 步骤与时长来自投影和本地计时锚点；这里只负责把它们说成人话，不做任何判定。
 */
export interface ComposerRunState {
  status: SessionUiStatus;
  /** 「正在执行 pnpm test」；没有步骤时为 null。 */
  stepText: string | null;
  /** 本页实时见过该回合开始时才有；null 表示只显示「运行中」，不显示时长。 */
  elapsedMs: number | null;
  pendingApprovals: number;
  /** 已点停止、终态未到：控件禁用并显示「停止中…」。 */
  stopping: boolean;
  onStop(): void;
  onJumpToApproval(): void;
}

/** "/" 与 "@" 触发的选择面板状态。 */
interface PaletteState {
  kind: "skill" | "file";
  query: string;
  tokenStart: number;
  caret: number;
  index: number;
}

interface FileIndexCache {
  status: "loading" | "ready" | "error";
  items: string[];
  truncated: boolean;
}

const PALETTE_LIMIT = 8;
/** 「@」面板里会话最多列几个（其余位置给文件）。 */
const SESSION_PALETTE_LIMIT = 4;

/**
 * 切换语言时带过重建的草稿（i18n/carry.ts）：输入框里的字与已传好的图片。
 * maybeSent：切换时正在直接发送、结果没等到的那一段（强制切换才会遇到；别的标签页的切换会等它发完）。
 * 重建后它还留在输入框里，消息却可能已经发出——不替人删（发失败时删掉就丢了），提示先核对再决定。
 */
interface ComposerCarry {
  text: string;
  attachments: DraftAttachment[];
  maybeSent: string | null;
}

export function Composer(props: {
  disabled: boolean;
  projectId: string;
  projectRoot: string;
  sessionId: string;
  skills: SkillDto[];
  skillPath: string;
  /** 外部动作只可预填草稿；发送仍只由用户点击或按 Enter 触发。 */
  initialDraft?: string;
  /** 同一草稿重复触发时递增，确保再次写入并聚焦。 */
  draftKey?: string | number;
  /** 右下角的模型切换器等扩展位（App 层组装，Composer 只管布局）。 */
  modelSlot?: ReactNode;
  onSkillPath(path: string): void;
  /** 当前页面新发消息的 turn，用于仅在该回合完成后解析受控 action 建议。 */
  onMessageAccepted?(accepted: SendMessageAccepted): void;
  onError(message: string): void;
  /** 运行态：不传或 idle/completed/error 时既无状态行也无停止控件。 */
  runState?: ComposerRunState;
  /** 队列（PR5）：不传则没有队列面板与排队入口。 */
  queue?: ComposerQueue;
  /** 底栏左侧的会话级设置（审批档等）。 */
  settingsSlot?: ReactNode;
  /** 上下文用量（用量环）；还没有用量事件时不显示。 */
  usage?: ContextUsage | null;
  /** 输入框为空时按 ↑ 取回的上一条消息。 */
  lastUserText?: string | null;
  /** 「@」面板列不列本机会话（会话有读会话的工具时才列，多 Agent 协作 S7）。 */
  referencesSessions?: boolean;
}) {
  const t = useT();
  const copy = t.workbench.composer;
  const carryKey = `composer:${props.sessionId}`;
  const carried = useCarried<ComposerCarry>(carryKey);
  const [text, setText] = useState(carried?.text ?? "");
  const [attachments, setAttachments] = useState<DraftAttachment[]>(carried?.attachments ?? []);
  const [maybeSent, setMaybeSent] = useState<string | null>(carried?.maybeSent ?? null);
  /** 正在直接发送的那一段（结果回来前）。 */
  const sendingText = useRef<string | null>(null);
  useCarrySource(carryKey, (): ComposerCarry => ({ text, attachments, maybeSent: sendingText.current ?? maybeSent }));
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  /** 发送按钮自己的 0ms 忙碌态；不影响 textarea 与其它按钮。 */
  const [sending, setSending] = useState(false);
  /** 图片上传自己的动作态；不影响 textarea 与发送。 */
  const [uploading, setUploading] = useState(false);
  // 发送或上传的请求还没回来时重建，结果会落空（发出去的字留在框里、传好的图丢掉）：别的标签页切语言时等它回来。
  useLossCheck(sending || uploading);
  /**
   * 在途发送回调的会话归属守卫：切会话后回调不得作用于新会话的草稿。
   * 用 ref 而不是闭包里的 props，闭包拿到的是发起那一刻的旧值。
   */
  const sessionRef = useRef(props.sessionId);
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [fileIndex, setFileIndex] = useState<FileIndexCache | null>(null);
  /** 「@」面板里可以引用的本机会话（多 Agent 协作 S7）：第一次打开面板时取一次。 */
  const [referable, setReferable] = useState<SessionListItemDto[] | null>(null);
  /** 上次取会话列表的时刻：失败或超过半分钟再打开面板时重取（会话随时在变）。 */
  const referableFetchedAt = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const indexProject = useRef("");

  useEffect(() => {
    const element = textareaRef.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${String(Math.min(element.scrollHeight, 220))}px`;
      if (pendingCaret.current !== null) {
        element.setSelectionRange(pendingCaret.current, pendingCaret.current);
        pendingCaret.current = null;
      }
    }
  }, [text]);

  useEffect(() => {
    sessionRef.current = props.sessionId;
    setPalette(null);
    setFileIndex(null);
    indexProject.current = "";
  }, [props.projectId, props.sessionId]);

  useEffect(() => {
    if (props.initialDraft === undefined) {
      return;
    }
    setText(props.initialDraft);
    setPalette(null);
    pendingCaret.current = props.initialDraft.length;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [props.draftKey, props.initialDraft]);

  const ensureFileIndex = () => {
    if (indexProject.current === props.projectId && fileIndex) {
      return;
    }
    indexProject.current = props.projectId;
    setFileIndex({ status: "loading", items: [], truncated: false });
    api
      .fileIndex(props.projectId)
      .then((response) =>
        setFileIndex({
          status: "ready",
          items: response.items,
          truncated: response.truncated,
        }),
      )
      .catch(() => setFileIndex({ status: "error", items: [], truncated: false }));
  };

  const detectPalette = (value: string, caret: number): PaletteState | null => {
    const before = value.slice(0, caret);
    const slash = /^\/(\S*)$/.exec(before);
    if (slash) {
      return { kind: "skill", query: slash[1] ?? "", tokenStart: 0, caret, index: 0 };
    }
    const at = /(^|[\s（(【"'`：:，,、])@([^\s@]*)$/.exec(before);
    if (at) {
      const query = at[2] ?? "";
      return {
        kind: "file",
        query,
        tokenStart: before.length - query.length - 1,
        caret,
        index: 0,
      };
    }
    return null;
  };

  const ensureReferable = () => {
    if (props.referencesSessions !== true) return;
    const fetchedAt = referableFetchedAt.current;
    if (fetchedAt !== null && Date.now() - fetchedAt < 30_000) return;
    referableFetchedAt.current = Date.now();
    api
      .listAllSessions({ state: "active", limit: 50 })
      .then((response) => setReferable(response.items))
      .catch(() => {
        referableFetchedAt.current = null;
      });
  };

  const onTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setText(value);
    const caret = event.target.selectionStart;
    const next = detectPalette(value, caret);
    setPalette(next);
    if (next?.kind === "file") {
      ensureFileIndex();
      ensureReferable();
    }
  };

  /** 可以引用的其他会话：标题或 Agent 名包含输入的字，当前项目的在前，最多 4 个（文件在后面）。 */
  const sessionMatches = (): SessionListItemDto[] => {
    if (referable === null || props.referencesSessions !== true) return [];
    const query = (palette?.query ?? "").toLowerCase();
    return referable
      .filter(
        (item) =>
          item.id !== props.sessionId &&
          (query === "" ||
            item.title.toLowerCase().includes(query) ||
            (item.agent?.displayName ?? item.agentId).toLowerCase().includes(query)),
      )
      .toSorted((left, right) => Number(right.project.id === props.projectId) - Number(left.project.id === props.projectId))
      .slice(0, SESSION_PALETTE_LIMIT);
  };

  const applySession = (item: SessionListItemDto) => {
    if (!palette) {
      return;
    }
    const inserted = `${sessionLinkText(item)} `;
    const nextText = text.slice(0, palette.tokenStart) + inserted + text.slice(palette.caret);
    setText(nextText);
    pendingCaret.current = palette.tokenStart + inserted.length;
    setPalette(null);
    textareaRef.current?.focus();
  };

  const skillMatches = (): SkillDto[] => {
    const query = (palette?.query ?? "").toLowerCase();
    return props.skills
      .filter(
        (skill) =>
          query === "" ||
          skill.name.toLowerCase().includes(query) ||
          (skill.description ?? "").toLowerCase().includes(query),
      )
      .slice(0, PALETTE_LIMIT);
  };

  const fileMatches = (): string[] => {
    if (!fileIndex || fileIndex.status !== "ready") {
      return [];
    }
    const query = (palette?.query ?? "").toLowerCase();
    if (query === "") {
      return fileIndex.items.slice(0, PALETTE_LIMIT);
    }
    const starts: string[] = [];
    const contains: string[] = [];
    for (const path of fileIndex.items) {
      const lower = path.toLowerCase();
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      if (base.startsWith(query) || lower.startsWith(query)) {
        starts.push(path);
      } else if (lower.includes(query)) {
        contains.push(path);
      }
      if (starts.length >= PALETTE_LIMIT) {
        break;
      }
    }
    return [...starts, ...contains].slice(0, PALETTE_LIMIT);
  };

  const applySkill = (skill: SkillDto) => {
    if (!palette) {
      return;
    }
    props.onSkillPath(skill.path);
    const after = text.slice(palette.caret);
    setText(after.trimStart());
    pendingCaret.current = 0;
    setPalette(null);
    textareaRef.current?.focus();
  };

  const applyFile = (path: string) => {
    if (!palette) {
      return;
    }
    const inserted = `@${path} `;
    const nextText =
      text.slice(0, palette.tokenStart) + inserted + text.slice(palette.caret);
    setText(nextText);
    pendingCaret.current = palette.tokenStart + inserted.length;
    setPalette(null);
    textareaRef.current?.focus();
  };

  const paletteItems: { key: string; node: ReactNode; apply(): void }[] =
    palette === null
      ? []
      : palette.kind === "skill"
        ? skillMatches().map((skill) => ({
            key: skill.path,
            node: (
              <>
                <ZapIcon size={14} />
                <span className="shrink-0 font-medium">{skill.name}</span>
                {!isSubPath(skill.path, props.projectRoot) && (
                  <span className="shrink-0 rounded-xs bg-muted px-1 text-caption text-muted-foreground">{copy.globalSkill}</span>
                )}
                {skill.description && (
                  <span className="min-w-0 truncate text-caption text-subtle-foreground">{skill.description}</span>
                )}
              </>
            ),
            apply: () => applySkill(skill),
          }))
        : [
            ...sessionMatches().map((item) => ({
              key: `session:${item.id}`,
              node: (
                <>
                  <MessagesSquareIcon size={14} />
                  <span className="min-w-0 truncate font-medium" data-testid="palette-session">{item.title}</span>
                  <span className="shrink-0 text-caption text-subtle-foreground">
                    {t.sessionLinks.palette.sessionMeta(item.agent?.displayName ?? item.agentId, item.project.name)}
                  </span>
                </>
              ),
              apply: () => applySession(item),
            })),
            ...fileMatches().map((path) => ({
            key: path,
            node: (
              <>
                <FileIcon size={14} />
                <span className="shrink-0 font-medium">{path.slice(path.lastIndexOf("/") + 1)}</span>
                <span className="min-w-0 truncate font-mono text-caption text-subtle-foreground">{path}</span>
              </>
            ),
            apply: () => applyFile(path),
          })),
          ];

  const canSend =
    !props.disabled &&
    Boolean(props.sessionId) &&
    (text.trim() !== "" || props.skillPath !== "" || attachments.length > 0);

  const send = async () => {
    if (!canSend) {
      return;
    }
    const skill = props.skills.find((item) => item.path === props.skillPath);
    const content = buildMessageContent({
      text,
      skill,
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
    if (content.length === 0) {
      return;
    }
    // 输入框在等响应期间不再禁用，用户随时可能改字或加图。发送成功只能移除
    // 「本次提交的那一份」，不能无条件清空——否则等待期间新打的字会被清掉。
    const submittedSessionId = props.sessionId;
    const submittedText = text;
    const submittedSkillPath = props.skillPath;
    const submittedAttachmentIds = new Set(attachments.map((item) => item.id));
    setSending(true);
    sendingText.current = submittedText;
    try {
      const accepted = await api.sendMessage(submittedSessionId, { content });
      if (sessionRef.current !== submittedSessionId) {
        // 会话已切走：这条回调属于上一个会话，不得改动新会话的草稿。
        return;
      }
      props.onMessageAccepted?.(accepted);
      setMaybeSent(null);
      setText((current) => (current === submittedText ? "" : current));
      if (props.skillPath === submittedSkillPath) {
        props.onSkillPath("");
      }
      setAttachments((current) =>
        current.filter((item) => !submittedAttachmentIds.has(item.id)),
      );
      setPalette(null);
    } catch (cause) {
      if (sessionRef.current !== submittedSessionId) {
        return;
      }
      props.onError(messageOf(cause));
    } finally {
      sendingText.current = null;
      setSending(false);
    }
  };

  /** 排队：把当前草稿整份交给队列，只清这一份（同发送的快照规则）。 */
  const enqueue = () => {
    if (!canSend || props.queue === undefined) {
      return;
    }
    const skill = props.skills.find((item) => item.path === props.skillPath);
    const draft: QueueDraft = {
      text: text.trim(),
      skill: skill === undefined ? undefined : { name: skill.name, path: skill.path },
      attachmentIds: attachments.map((attachment) => attachment.id),
    };
    if (draft.text === "" && draft.skill === undefined && draft.attachmentIds.length === 0) {
      return;
    }
    const submittedText = text;
    const submittedSkillPath = props.skillPath;
    const submittedAttachmentIds = new Set(draft.attachmentIds);
    props.queue.onEnqueue(draft);
    setText((current) => (current === submittedText ? "" : current));
    if (props.skillPath === submittedSkillPath) {
      props.onSkillPath("");
    }
    setAttachments((current) => current.filter((item) => !submittedAttachmentIds.has(item.id)));
    setPalette(null);
  };

  /** 取回输入框：文本回 textarea、skill 回选中、附件按 id 回 chip（大小可能未知）。 */
  const takeFromQueue = (id: string) => {
    const item = props.queue?.onTake(id) ?? null;
    if (item === null) {
      return;
    }
    setText((current) => (current.trim() === "" ? item.text : `${current}\n${item.text}`));
    if (item.skill !== undefined) {
      props.onSkillPath(item.skill.path);
    }
    setAttachments((current) => [
      ...current,
      ...item.attachmentIds
        .filter((attachmentId) => !current.some((entry) => entry.id === attachmentId))
        .map((attachmentId) => ({ id: attachmentId })),
    ]);
    pendingCaret.current = null;
    textareaRef.current?.focus();
  };

  const queueActive = props.runState !== undefined && isActiveRun(props.runState.status);

  const uploadFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (files.length > 0 && images.length === 0) {
      props.onError(copy.imagesOnly);
      return;
    }
    if (images.length === 0 || !props.projectId) {
      return;
    }
    setUploading(true);
    try {
      const uploaded = await Promise.all(
        images.map(async (file) =>
          api.uploadAttachment(
            props.projectId,
            file.type,
            arrayBufferToBase64(await file.arrayBuffer()),
          ),
        ),
      );
      setAttachments((current) => [
        ...current,
        ...uploaded.map((attachment) => ({ id: attachment.id, size: attachment.size })),
      ]);
    } catch (cause) {
      props.onError(messageOf(cause));
    } finally {
      setUploading(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    void uploadFiles(images);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (palette && !composing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = paletteItems.length;
        if (count > 0) {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setPalette({
            ...palette,
            index: (palette.index + delta + count) % count,
          });
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        paletteItems[palette.index]?.apply();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPalette(null);
        return;
      }
    }
    // 输入框为空时：Esc 停止正在跑的这一轮；↑ 取回上一条消息。
    if (!composing && !palette && text === "" && attachments.length === 0) {
      // 等你确认时 Esc 不停止整轮（那会让审批失效）：审批在审批卡上处理。
      if (event.key === "Escape" && props.runState !== undefined && props.runState.status === "running" && !props.runState.stopping) {
        event.preventDefault();
        props.runState.onStop();
        return;
      }
      if (event.key === "ArrowUp" && props.lastUserText !== undefined && props.lastUserText !== null && props.lastUserText !== "") {
        event.preventDefault();
        setText(props.lastUserText);
        pendingCaret.current = props.lastUserText.length;
        return;
      }
    }
    // PR5：补全面板关闭时，运行中按 Tab = 排队（面板打开时上面已把 Tab 当作接受候选）。
    if (event.key === "Tab" && !composing && !event.shiftKey && queueActive && canSend && props.queue !== undefined) {
      event.preventDefault();
      enqueue();
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    // IME 组合态的回车用于选字，不发送。
    if (composing) {
      return;
    }
    if (event.metaKey || event.ctrlKey || !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    void uploadFiles(files);
  };

  const selectedSkill = props.skills.find(
    (skill) => skill.path === props.skillPath,
  );

  return (
    <div
      className="relative mx-auto w-full max-w-[760px]"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          dragDepth.current += 1;
          setDragActive(true);
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setDragActive(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        void uploadFiles([...event.dataTransfer.files]);
      }}
    >
      {props.queue !== undefined && <QueuePanel sessionId={props.sessionId} queue={props.queue} onTake={takeFromQueue} />}
      {maybeSent !== null && (
        <div
          className="mb-2 flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-caption text-foreground"
          data-testid="composer-maybe-sent"
          role="status"
        >
          <span className="flex-1">{copy.maybeSent}</span>
          <button
            type="button"
            className="shrink-0 rounded-xs px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setMaybeSent(null)}
          >
            {copy.maybeSentDismiss}
          </button>
        </div>
      )}
      <RunStatusLine runState={props.runState} />
      <div
        className={cn(
          "relative rounded-lg border bg-card shadow-1 transition-colors focus-within:border-border-strong",
          dragActive ? "border-primary bg-primary-soft" : "border-border",
        )}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg text-small font-medium text-primary-text">
            {copy.dropImages}
          </div>
        )}
        {palette && (
          <div
            className="absolute right-2 bottom-[calc(100%+6px)] left-2 z-30 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-3"
            role="listbox"
            aria-label={copy.palette.label}
          >
            <div className="flex items-center justify-between px-2 py-1 text-caption text-subtle-foreground">
              <span className="font-medium text-muted-foreground">{palette.kind === "skill" ? copy.palette.skillTitle : copy.palette.fileTitle}</span>
              <span>{copy.palette.keys}</span>
            </div>
            {palette.kind === "file" && fileIndex?.status === "loading" && <PaletteNote>{copy.palette.indexing}</PaletteNote>}
            {palette.kind === "file" && fileIndex?.status === "error" && <PaletteNote>{copy.palette.indexFailed}</PaletteNote>}
            {paletteItems.length === 0 && palette.kind === "skill" && (
              <PaletteNote>
                {props.skills.length === 0 ? copy.palette.noSkills : copy.palette.noMatches}
              </PaletteNote>
            )}
            {paletteItems.length === 0 && palette.kind === "file" && fileIndex?.status === "ready" && <PaletteNote>{copy.palette.noMatches}</PaletteNote>}
            {paletteItems.map((item, itemIndex) => (
              <button
                key={item.key}
                type="button"
                role="option"
                data-testid="palette-item"
                aria-selected={itemIndex === palette.index}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-small text-foreground [&_svg]:shrink-0 [&_svg]:text-subtle-foreground",
                  itemIndex === palette.index && "bg-popover-hover",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  item.apply();
                }}
                onMouseEnter={() => setPalette({ ...palette, index: itemIndex })}
              >
                {item.node}
              </button>
            ))}
            {palette.kind === "file" && fileIndex?.truncated && <PaletteNote>{copy.palette.truncated}</PaletteNote>}
          </div>
        )}
        {(attachments.length > 0 || selectedSkill) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {selectedSkill && (
              <span className="inline-flex h-6 items-center gap-1 rounded-sm bg-primary-soft pr-1 pl-2 text-caption font-medium text-primary-text" data-testid="skill-chip">
                <ZapIcon size={12} />
                {selectedSkill.name}
                {!isSubPath(selectedSkill.path, props.projectRoot) && <span className="font-normal opacity-80">{copy.globalSkill}</span>}
                <ChipRemove label={copy.removeSkill} onClick={() => props.onSkillPath("")} />
              </span>
            )}
            {attachments.map((attachment) => (
              <span
                className="inline-flex h-6 items-center gap-1 rounded-sm bg-muted pr-1 pl-2 text-caption text-muted-foreground"
                data-testid="attachment-chip"
                data-attachment-id={attachment.id}
                key={attachment.id}
              >
                <ImageIcon size={12} />
                {attachment.size === undefined ? copy.image : copy.imageWithSize(formatBytes(attachment.size))}
                <ChipRemove
                  label={copy.removeImage}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                />
              </span>
            ))}
          </div>
        )}
        <label htmlFor={`composer-${props.sessionId}`} className="sr-only">{copy.messageLabel}</label>
        <textarea
          id={`composer-${props.sessionId}`}
          ref={textareaRef}
          rows={1}
          data-testid="message-input"
          value={text}
          disabled={props.disabled}
          onChange={onTextChange}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onBlur={() => setPalette(null)}
          className="block max-h-[220px] min-h-11 w-full resize-none overflow-y-auto border-0 bg-transparent px-3.5 pt-2.5 pb-1 text-body text-foreground outline-none placeholder:text-subtle-foreground"
          placeholder={
            selectedSkill
              ? copy.placeholder.withSkill(selectedSkill.name)
              : queueActive
                ? copy.placeholder.running
                : copy.placeholder.default
          }
        />
        <div className="flex items-center gap-1 px-2 pt-1 pb-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-small text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            data-testid="attach-image"
            disabled={props.disabled || uploading}
            title={copy.attachImage}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? <Spinner size="sm" /> : <ImageIcon size={15} />}
            {copy.image}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
          {props.settingsSlot}
          {props.modelSlot}
          <div className="flex-1" />
          {props.usage !== undefined && props.usage !== null && <ContextRing usage={props.usage} />}
          {props.queue !== undefined && queueActive && (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-sm px-2 text-small text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              data-testid="queue-message"
              disabled={!canSend}
              title={copy.queueTitle}
              onClick={enqueue}
            >
              {copy.queue}
            </button>
          )}
          {/* R2：运行中停止与发送并存、都可点；终态后停止控件整个消失（不是禁用）。 */}
          {props.runState !== undefined && isActiveRun(props.runState.status) && (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-border px-2 text-small font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              data-testid="interrupt-turn"
              disabled={props.runState.stopping}
              title={props.runState.stopping ? copy.stoppingTitle : copy.stopTitle}
              aria-label={props.runState.stopping ? copy.stoppingLabel : copy.stopLabel}
              onClick={props.runState.onStop}
            >
              {props.runState.stopping ? <Spinner size="sm" /> : <SquareIcon size={13} />}
              {props.runState.stopping ? copy.stopping : copy.stop}
            </button>
          )}
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring disabled:bg-muted-strong disabled:text-disabled-foreground"
            data-testid="send-message"
            disabled={!canSend}
            title={copy.sendTitle}
            aria-label={copy.send}
            onClick={() => void send()}
          >
            {sending ? <Spinner size="sm" /> : <ArrowUpIcon size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaletteNote({ children }: { children: ReactNode }) {
  return <div className="px-2 py-2 text-small text-subtle-foreground">{children}</div>;
}

function ChipRemove({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      type="button"
      className="inline-flex size-4 items-center justify-center rounded-xs opacity-70 outline-none hover:bg-black/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <XIcon size={11} />
    </button>
  );
}

/** 上下文用量环：最近一次请求占了模型上下文窗口的多少；超过八成变色提醒。 */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const t = useT();
  if (usage.contextWindow === null) return null;
  const ratio = Math.min(1, usage.usedTokens / usage.contextWindow);
  const percent = Math.round(ratio * 100);
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const tone = ratio >= 0.9 ? "text-danger" : ratio >= 0.8 ? "text-warning" : "text-primary-text";
  return (
    <span
      className="inline-flex h-7 items-center gap-1 px-1 text-caption text-subtle-foreground"
      title={t.workbench.composer.context.title(percent, formatTokens(usage.usedTokens), formatTokens(usage.contextWindow))}
      data-testid="context-ring"
    >
      <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden="true">
        <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-strong" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          className={tone}
        />
      </svg>
      <span className="sr-only">{t.workbench.composer.context.used}</span>
      {percent}%
    </span>
  );
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

function isActiveRun(status: SessionUiStatus): boolean {
  return status === "running" || status === "approval";
}

/**
 * 输入框上方的队列面板（PR5）：列出排队项，可编辑 / 删除 / 取回；暂停时说清理由并给「恢复」。
 * 只承诺当前标签页，标题里直说。
 */
function QueuePanel({ sessionId, queue, onTake }: { sessionId: string; queue: ComposerQueue; onTake(id: string): void }) {
  const t = useT();
  const copy = t.workbench.composer.queuePanel;
  // 正在改的那一项：切换语言时带过重建（i18n/carry.ts）。
  const carryKey = `queue-edit:${sessionId}`;
  const carried = useCarried<{ id: string; text: string } | null>(carryKey);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(carried ?? null);
  useCarrySource(carryKey, () => editing);
  if (queue.items.length === 0 && queue.status !== "paused") {
    return null;
  }
  const link =
    "rounded-xs px-1 text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="mb-2 rounded-md border border-border bg-card px-3 py-2" data-testid="queue-panel" data-status={queue.status}>
      <div className="flex items-center gap-2 text-caption">
        <b className="font-medium text-foreground">{copy.title(queue.items.length)}</b>
        <span className="text-subtle-foreground">{copy.scope}</span>
      </div>
      {queue.status === "paused" && queue.pausedReason !== null && (
        <div className="mt-1.5 flex items-center gap-2 rounded-sm bg-warning-soft px-2 py-1 text-caption text-foreground" data-testid="queue-paused" data-reason={queue.pausedReason} role="status">
          <span className="flex-1">{copy.paused(copy.pausedReasons[queue.pausedReason])}</span>
          {/* 每一种暂停都给恢复入口（需求 4.3）；没有可发项时恢复只是解除暂停，不会发任何东西。 */}
          <button type="button" className={link} data-testid="queue-resume" onClick={queue.onResume}>
            {copy.resume}
          </button>
        </div>
      )}
      <ol className="m-0 mt-1 flex list-none flex-col p-0">
        {queue.items.map((item, index) => (
          <li
            className="flex min-h-7 items-center gap-2 border-t border-border py-1 first:border-t-0"
            data-testid="queue-item"
            data-index={index}
            data-item-id={item.id}
            key={item.id}
            {...(item.unconfirmed === true ? { "data-unconfirmed": "true" } : {})}
          >
            {editing?.id === item.id ? (
              <div className="flex w-full flex-col gap-1.5">
                <textarea
                  rows={2}
                  aria-label={copy.editLabel}
                  className="w-full resize-none rounded-sm border border-border bg-background px-2 py-1 text-small text-foreground outline-none focus:border-primary"
                  value={editing.text}
                  onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                />
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    className={link}
                    onClick={() => {
                      queue.onUpdate(item.id, editing.text);
                      setEditing(null);
                    }}
                  >
                    {copy.save}
                  </button>
                  <button type="button" className={link} onClick={() => setEditing(null)}>{copy.cancel}</button>
                </div>
              </div>
            ) : (
              <>
                <span className="w-4 shrink-0 text-caption text-subtle-foreground">{index + 1}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-small text-foreground" title={item.text}>
                  {item.unconfirmed === true && <QueueTag>{copy.unconfirmed}</QueueTag>}
                  {item.skill !== undefined && (
                    <QueueTag>
                      <ZapIcon size={11} />
                      {item.skill.name}
                    </QueueTag>
                  )}
                  <span className="truncate">{item.text === "" ? copy.noText : item.text}</span>
                  {item.attachmentIds.length > 0 && (
                    <QueueTag>
                      <ImageIcon size={11} />
                      {item.attachmentIds.length}
                    </QueueTag>
                  )}
                </span>
                <span className="flex shrink-0 gap-0.5">
                  <button type="button" className={link} data-testid="queue-item-edit" onClick={() => setEditing({ id: item.id, text: item.text })}>
                    {copy.edit}
                  </button>
                  <button type="button" className={link} data-testid="queue-item-take" onClick={() => onTake(item.id)}>
                    {copy.take}
                  </button>
                  <button type="button" className={link} data-testid="queue-item-delete" onClick={() => queue.onRemove(item.id)}>
                    {copy.remove}
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function QueueTag({ children }: { children: ReactNode }) {
  return <span className="inline-flex shrink-0 items-center gap-0.5 rounded-xs bg-muted px-1 text-caption text-muted-foreground">{children}</span>;
}

/**
 * 输入框上方那一行：跑没跑、跑到哪、跑了多久；等审批时换成「等你确认」，不再转圈。
 * 状态语义与会话头徽章来自同一判定函数，这里只是多说了步骤与时长。
 */
function RunStatusLine({ runState }: { runState: ComposerRunState | undefined }) {
  const t = useT();
  const copy = t.workbench.composer;
  if (runState === undefined || !isActiveRun(runState.status)) {
    return null;
  }
  if (runState.status === "approval") {
    return (
      <div className="mb-1.5 flex items-center gap-2 px-1 text-caption" data-testid="run-status-line" data-status="approval" role="status">
        <span className="size-2 rounded-full bg-warning" aria-hidden="true" />
        <span className="font-medium text-foreground">{copy.run.waiting(runState.pendingApprovals)}</span>
        <button
          type="button"
          className="rounded-xs px-1 text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="run-status-approval-link"
          onClick={runState.onJumpToApproval}
        >
          {copy.run.review}
        </button>
      </div>
    );
  }
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2 px-1 text-caption text-muted-foreground" data-testid="run-status-line" data-status="running" role="status">
      <span className="relative flex size-2 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-50 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      <span className="shrink-0 font-medium text-foreground">{runState.stopping ? copy.stopping : copy.run.working}</span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate" data-testid="run-status-step">{runState.stepText ?? copy.run.running}</span>
      {runState.elapsedMs !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 font-mono" data-testid="run-status-elapsed">{formatDuration(runState.elapsedMs)}</span>
        </>
      )}
    </div>
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
