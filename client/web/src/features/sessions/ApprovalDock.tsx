import type {
  ApprovalDto,
  ApprovalKind,
  JsonValue,
  SuDuoToolConfirmationDto,
} from "@suduo/client-contracts";
import { ChevronDownIcon, FileDiffIcon, FileIcon, HandIcon, InfoIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FileChangeEntry } from "../../event-projection/timeline.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { describePermissions } from "../../event-projection/shared.js";
import {
  duplicateNotice,
  publishFileSource,
  suDuoToolConfirmationOf,
  suDuoToolConfirmationTitle,
} from "../../event-projection/suduo-tools.js";
import { formatBytes } from "../../ui/format.js";

/**
 * 审批坞（需求 §4.5）：固定在输入框上方，一次处理一个，多个时显示 1/3。
 * ⏎ 批准、Esc 拒绝只在审批卡获焦（或页面上没有任何焦点）时生效（技术设计 §6.5）：
 * 焦点在任何按钮、链接、输入框上时按键交给那个元素，绝不会把「拒绝」上的回车当成批准。
 * 审批出现时若你没在打字，焦点移到审批卡上；更多里有「本会话都允许」「拒绝并中断」。
 *
 * SuDuo 写工具（发评论、发布确认版）的确认卡也在这里（需求 4.3）：逐字展示评论全文或待发布文件，
 * 按钮是「发出 / 不发」「发布 / 不发布」。它们对外且不能撤回（ADR-0004 红线），所以只能点按钮确认，
 * 回车不会替你发出；Esc 仍是「不发」。
 */
export type ApprovalDecisionInput = "accept" | "acceptForSession" | "decline" | "cancel";

const QUESTION: Record<ApprovalKind, string> = {
  command: "Codex 想运行命令",
  "file-change": "Codex 想修改文件",
  permissions: "Codex 想变更权限",
  other: "Codex 请你确认后继续",
};

export function ApprovalDock({
  approvals,
  onDecide,
  changesFor,
  onViewPatch,
  displayPath = (path) => path,
}: {
  approvals: ApprovalDto[];
  onDecide(approval: ApprovalDto, decision: ApprovalDecisionInput): Promise<void>;
  /** 文件改动审批要改的文件（从同一 item 的改动卡取；v2 审批请求本身不带文件列表）。 */
  changesFor?(approval: ApprovalDto): FileChangeEntry[];
  /** 在检查面板查看还没写入的改动。 */
  onViewPatch?(change: FileChangeEntry): void;
  displayPath?(path: string): string;
}) {
  const ordered = [...approvals].sort((left, right) => left.requestedAt - right.requestedAt);
  const current = ordered[0];
  const [deciding, setDeciding] = useState<ApprovalDecisionInput | null>(null);
  const dockRef = useRef<HTMLElement>(null);

  const decide = (decision: ApprovalDecisionInput) => {
    // 已经在执行的卡（刷新后看到 deciding）不再接受决定，键盘也一样。
    if (current === undefined || deciding !== null || current.status === "deciding") return;
    setDeciding(decision);
    void onDecide(current, decision).finally(() => setDeciding(null));
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const currentId = current?.id ?? null;

  // 新审批出现时，若焦点不在输入类元素上，把焦点移到审批卡（打字时不抢焦点）。
  useEffect(() => {
    if (currentId === null) return;
    const active = document.activeElement;
    const typing =
      active instanceof HTMLElement && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
    if (!typing) dockRef.current?.focus({ preventScroll: true });
  }, [currentId]);

  useEffect(() => {
    if (current === undefined) return undefined;
    const externalWrite = suDuoToolConfirmationOf(current.request) !== null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      const target = event.target;
      const onDock = target === dockRef.current;
      const onNothing = target === document.body || target === document.documentElement;
      if (!onDock && !onNothing) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"]') !== null) return;
      if (event.key === "Enter") {
        if (externalWrite) return;
        event.preventDefault();
        decideRef.current("accept");
      } else if (event.key === "Escape") {
        event.preventDefault();
        decideRef.current("decline");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current]);

  if (current === undefined) return null;
  const toolConfirmation = suDuoToolConfirmationOf(current.request);
  if (toolConfirmation !== null) {
    return (
      <section
        ref={dockRef}
        tabIndex={-1}
        className="group/dock mx-auto mb-2 w-full max-w-[760px] rounded-lg border border-warning/40 bg-card shadow-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="等你确认"
        data-testid="approval-card"
        data-status={current.status === "deciding" ? "deciding" : "pending"}
        data-variant="suduo-tool"
        data-tool={toolConfirmation.tool}
      >
        <ToolConfirmationCard
          key={current.id}
          executing={current.status === "deciding"}
          confirmation={toolConfirmation}
          position={ordered.length > 1 ? ordered.length : null}
          deciding={deciding}
          onDecide={decide}
        />
      </section>
    );
  }
  const subject = current.kind === "file-change" ? "" : approvalSubject(current.request);
  const reason = approvalReason(current.request);
  const cwd = approvalCwd(current.request);
  const pending = current.kind === "file-change" ? (changesFor?.(current) ?? []) : [];
  const legacyFiles = current.kind === "file-change" && pending.length === 0 ? approvalFiles(current.request) : [];
  const busy = deciding !== null;

  return (
    <section
      ref={dockRef}
      tabIndex={-1}
      className="group/dock mx-auto mb-2 w-full max-w-[760px] rounded-lg border border-warning/40 bg-card shadow-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="等你确认"
      data-testid="approval-card"
      data-status="pending"
    >
      <header className="flex items-center gap-2 px-3.5 pt-3 text-small">
        <HandIcon className="size-4 text-warning" aria-hidden="true" />
        <span className="font-medium text-foreground">
          {current.kind === "file-change" && pending.length > 0 ? `Codex 想修改 ${pending.length} 个文件` : approvalQuestion(current.kind, current.request)}
        </span>
        {ordered.length > 1 ? (
          <span className="ml-auto text-caption text-subtle-foreground" aria-label={`第 1 个，共 ${ordered.length} 个`}>
            1/{ordered.length}
          </span>
        ) : null}
      </header>
      <div className="flex flex-col gap-1.5 px-3.5 pt-2">
        {subject === "" ? null : (
          <pre className="m-0 max-h-32 overflow-auto rounded-sm bg-code-bg px-2.5 py-2 font-mono text-caption whitespace-pre-wrap text-foreground">
            {subject}
          </pre>
        )}
        {reason === null ? null : <p className="m-0 text-small text-muted-foreground">{reason}</p>}
        {cwd === null ? null : <p className="m-0 truncate font-mono text-caption text-subtle-foreground">在 {cwd}</p>}
        {pending.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {pending.map((change) => (
              <li key={change.path}>
                <button
                  type="button"
                  className="flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent"
                  disabled={onViewPatch === undefined}
                  onClick={() => onViewPatch?.(change)}
                  title={`查看 ${displayPath(change.path)} 的改动`}
                >
                  <FileDiffIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-left font-mono text-caption text-foreground" dir="rtl">
                    <bdi>{displayPath(change.path)}</bdi>
                  </span>
                  <span className="shrink-0 font-mono text-caption">
                    <span className="text-diff-add-fg">+{change.additions}</span> <span className="text-diff-del-fg">−{change.deletions}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {legacyFiles.length > 0 ? (
          <pre className="m-0 max-h-32 overflow-auto rounded-sm bg-code-bg px-2.5 py-2 font-mono text-caption whitespace-pre-wrap text-foreground">
            {legacyFiles.map(displayPath).join("\n")}
          </pre>
        ) : null}
      </div>
      <footer className="flex items-center gap-2 px-3.5 py-3">
        <span className="invisible text-caption text-subtle-foreground group-focus/dock:visible" aria-hidden="true">
          <Kbd>⏎</Kbd> 批准 · <Kbd>Esc</Kbd> 拒绝
        </span>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" loading={deciding === "decline"} disabled={busy} data-testid="approval-decline" onClick={() => decide("decline")}>
          拒绝
        </Button>
        <div className="flex">
          <Button
            variant="primary"
            size="sm"
            className="rounded-r-none"
            loading={deciding === "accept" || deciding === "acceptForSession"}
            disabled={busy}
            data-testid="approval-accept"
            onClick={() => decide("accept")}
          >
            批准
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="primary"
                size="sm"
                className="rounded-l-none border-l border-primary-foreground/25 px-1.5"
                aria-label="更多批准选项"
                disabled={busy}
                data-testid="approval-more"
              >
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem data-testid="approval-accept-session" onSelect={() => decide("acceptForSession")}>
                <span className="flex flex-col">
                  <span>本会话都允许</span>
                  <span className="text-caption text-subtle-foreground">同类操作不再询问</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="approval-cancel" variant="danger" onSelect={() => decide("cancel")}>
                <span className="flex flex-col">
                  <span>拒绝并中断</span>
                  <span className="text-caption text-subtle-foreground">停止 Codex 当前这一轮</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </footer>
    </section>
  );
}

/**
 * SuDuo 写工具的确认卡：标题说清发到哪条需求，正文逐字展示要发出去的东西，底部说清后果。
 * 加载 / 失败反馈与普通审批一致（按钮转圈；失败由会话页的 onDecide 报错）。
 */
function ToolConfirmationCard({
  confirmation,
  executing,
  position,
  deciding,
  onDecide,
}: {
  confirmation: SuDuoToolConfirmationDto;
  /** 已经点了「发出」、本机服务正在执行（刷新页面后看到的就是这个状态）。 */
  executing: boolean;
  /** 多个待确认时显示「1/N」。 */
  position: number | null;
  deciding: ApprovalDecisionInput | null;
  onDecide(decision: ApprovalDecisionInput): void;
}) {
  const comment = confirmation.tool === "comment_submit";
  const duplicate = duplicateNotice(confirmation);
  // 卡片刚出现的一小会儿按钮不可点：前一张卡上的双击不会落到这张不可撤回的卡上。
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), TOOL_CARD_ARM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const busy = deciding !== null || executing || !armed;
  const files = confirmation.publish?.files ?? [];
  const note = confirmation.publish?.note ?? null;
  return (
    <>
      <header className="flex items-center gap-2 px-3.5 pt-3 text-small">
        <SendIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 font-medium text-foreground" data-testid="tool-confirm-title">{suDuoToolConfirmationTitle(confirmation)}</span>
        {position === null ? null : (
          <span className="ml-auto shrink-0 text-caption text-subtle-foreground" aria-label={`第 1 个，共 ${position} 个`}>
            1/{position}
          </span>
        )}
      </header>
      <div className="flex flex-col gap-1.5 px-3.5 pt-2">
        {comment ? (
          <div
            className="max-h-60 overflow-auto rounded-sm bg-code-bg px-2.5 py-2 text-small break-words whitespace-pre-wrap text-foreground"
            data-testid="tool-confirm-comment"
          >
            {confirmation.comment?.body ?? ""}
          </div>
        ) : (
          <>
            {files.length === 0 ? (
              <p className="m-0 text-small text-muted-foreground">没有列出要发布的文件。</p>
            ) : (
              <ul className="m-0 flex max-h-48 list-none flex-col gap-0.5 overflow-auto p-0" data-testid="tool-confirm-files">
                {files.map((file, index) => (
                  <li key={`${file.source}:${file.ref}:${String(index)}`} className="flex min-h-7 items-center gap-2 px-1.5 text-small" data-testid="tool-confirm-file">
                    <FileIcon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-foreground" title={file.name}>{file.name}</span>
                    <span className="shrink-0 text-caption text-subtle-foreground">{file.sizeBytes === null ? "大小未知" : formatBytes(file.sizeBytes)}</span>
                    <span className="max-w-[45%] shrink-0 truncate text-caption text-subtle-foreground" title={publishFileSource(file)}>
                      {publishFileSource(file)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="text-small text-muted-foreground" data-testid="tool-confirm-note">
              {note === null ? (
                "没有填写发布说明。"
              ) : (
                <>
                  <span className="text-caption text-subtle-foreground">发布说明</span>
                  <p className="m-0 mt-0.5 max-h-32 overflow-auto break-words whitespace-pre-wrap text-foreground">{note}</p>
                </>
              )}
            </div>
          </>
        )}
        {duplicate === null ? null : (
          <p className="m-0 flex items-center gap-1.5 text-small text-foreground" role="note" data-testid="tool-confirm-duplicate">
            <InfoIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
            {duplicate}
          </p>
        )}
      </div>
      <footer className="flex items-center gap-2 px-3.5 py-3">
        <span className="min-w-0 flex-1 text-caption text-subtle-foreground">
          {executing ? (comment ? "正在发出…" : "正在发布…") : comment ? "发出后不能撤回" : "发布后全组可见，不能撤回"}
          <span className="invisible group-focus/dock:visible" aria-hidden="true">
            {" "}· <Kbd>Esc</Kbd> {comment ? "不发" : "不发布"}
          </span>
        </span>
        <Button variant="secondary" size="sm" loading={deciding === "decline"} disabled={busy} data-testid="approval-decline" onClick={() => onDecide("decline")}>
          {comment ? "不发" : "不发布"}
        </Button>
        <Button variant="primary" size="sm" loading={deciding === "accept" || executing} disabled={busy} data-testid="approval-accept" onClick={() => onDecide("accept")}>
          {comment ? "发出" : "发布"}
        </Button>
      </footer>
    </>
  );
}

/** 工具确认卡出现后多久才能点（防止上一张卡的连击落到这张不可撤回的卡上）。 */
const TOOL_CARD_ARM_DELAY_MS = 400;

function requestOf(payload: JsonValue): Record<string, JsonValue> {
  const outer = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const inner = outer["request"];
  return inner !== null && inner !== undefined && typeof inner === "object" && !Array.isArray(inner) ? inner : {};
}

/** 审批卡的标题。命令审批里 kind=writeStdin 是向已在运行的命令（终端）输入内容，不是运行新命令。 */
export function approvalQuestion(kind: ApprovalKind, payload: JsonValue): string {
  if (kind === "command" && requestOf(payload)["kind"] === "writeStdin") return "Codex 想向正在运行的命令输入内容";
  return QUESTION[kind];
}

/** 审批要确认的对象：命令原文，或要改的文件。 */
export function approvalSubject(payload: JsonValue): string {
  const request = requestOf(payload);
  const command = request["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof request["path"] === "string") return request["path"];
  const permissions = describePermissions(request["permissions"]);
  if (permissions !== "") return permissions;
  const files = approvalFiles(payload);
  return files.length === 0 ? "" : files.join("\n");
}

function approvalFiles(payload: JsonValue): string[] {
  const request = requestOf(payload);
  const changes = request["changes"];
  if (changes !== null && changes !== undefined && typeof changes === "object" && !Array.isArray(changes)) return Object.keys(changes);
  return typeof request["path"] === "string" ? [request["path"]] : [];
}

function approvalReason(payload: JsonValue): string | null {
  const reason = requestOf(payload)["reason"];
  return typeof reason === "string" && reason.trim() !== "" ? reason : null;
}

function approvalCwd(payload: JsonValue): string | null {
  const cwd = requestOf(payload)["cwd"];
  return typeof cwd === "string" && cwd !== "" ? cwd : null;
}
