import { CheckIcon, CircleIcon, MessageSquareIcon, MessageSquarePlusIcon, RotateCwIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDto } from "@suduo/client-contracts";
import { api, ApiClientError, type RequirementsSessionReferenceDto } from "../../../api/client.js";
import { invalidateMappingCaches } from "../../../app/mapping-cache.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { InlineError, RegionError } from "../../../feedback/components/index.js";
import { reportFailure } from "../../../feedback/report.js";
import type { Failure } from "../../../feedback/types.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { formatRelativeTime } from "../../../ui/format.js";
import { useT } from "../../../i18n/provider.js";
import type { Messages } from "../../../i18n/messages/index.js";

/**
 * 分步的「开始会话」（需求 §4.4 / 技术设计 §6.3）：
 * 检查 → （已有会话时）选「继续 / 新开」→ （未关联目录、或目录已不可用时）选代码目录 → 准备（显示耗时，失败可重试）→ 就绪即进入。
 * 准备中关掉对话框不会中断：会话建好后用提示告知，并给「进入」。
 */
export type LaunchRequest =
  | { kind: "project"; remoteProjectId: string }
  | { kind: "requirement"; remoteProjectId: string; requirementId: string };

type Step =
  | { name: "checking" }
  | { name: "choose"; existing: RequirementsSessionReferenceDto[] }
  | { name: "directory"; initialPath: string; notice: DirectoryNotice | null }
  | { name: "preparing"; startedAt: number; rootPath: string | null }
  | { name: "failed"; failure: Failure; retry: "check" | "create" };

const SLOW_AFTER_MS = 15_000;

/** 为什么要重新选目录。文案在本地拼，不直接显示服务端原话。 */
type DirectoryNotice = { reason: "missing" | "unusable" | "unlinked"; path: string | null };

function noticeText({ reason, path }: DirectoryNotice, t: Messages): string {
  const text = t.requirements.startSession.directory;
  switch (reason) {
    case "missing":
      return text.missing(path);
    case "unusable":
      return text.unusable(path);
    case "unlinked":
      return text.unlinked;
  }
}

type Inspection = Awaited<ReturnType<typeof api.inspectLocalDir>>;

/** 目录可用返回 null，否则返回原因；检查本身失败时当作可用，交给后续步骤报错。 */
function directoryProblem(inspection: Inspection | null): DirectoryNotice["reason"] | null {
  if (inspection === null) return null;
  if (!inspection.exists || !inspection.isDirectory) return "missing";
  if (!inspection.readable || !inspection.writable) return "unusable";
  return null;
}

export function StartSessionDialog({
  request,
  subject,
  onClose,
  onReady,
  onBackgroundFailed,
}: {
  request: LaunchRequest;
  /** 标题下一行的主体说明：需求编号与标题，或项目名。 */
  subject: string;
  /** background=true：准备中被关掉，会话仍在后台准备。 */
  onClose(background: boolean): void;
  /** 转到后台后准备失败（失败提示已由这里给出）。 */
  onBackgroundFailed?(): void;
  /** 会话已就绪。detached=true 表示用户已关掉对话框，由调用方决定如何告知。 */
  onReady(session: SessionDto, detached: boolean): void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>({ name: "checking" });
  const [open, setOpen] = useState(true);
  const stepRef = useRef<Step>(step);
  // open：对话框开着；cancelled：用户放弃，后续不再推进；detached：准备中被关掉，建好后由调用方告知。
  const ended = useRef<"open" | "cancelled" | "detached">("open");
  const rootPath = useRef<string | null>(null);

  const update = useCallback((next: Step) => {
    if (ended.current !== "open") return;
    stepRef.current = next;
    setStep(next);
  }, []);

  const close = useCallback(() => {
    if (ended.current === "open") {
      ended.current = stepRef.current.name === "preparing" ? "detached" : "cancelled";
    }
    setOpen(false);
    onClose(ended.current === "detached");
  }, [onClose]);

  const fail = useCallback(
    (cause: unknown, retry: "check" | "create") => {
      if (ended.current === "cancelled") return;
      if (ended.current === "detached") {
        reportFailure(cause, { surface: "action", title: t.requirements.startSession.backgroundFailed });
        onBackgroundFailed?.();
        return;
      }
      if (cause instanceof ApiClientError && cause.code === "WORKSPACE_MAPPING_REQUIRED") {
        update({ name: "directory", initialPath: "", notice: { reason: "unlinked", path: rootPath.current } });
        return;
      }
      const failure = classifyFailure(cause);
      if (failure.kind === "auth_expired") {
        // 登录过期：放弃这次开始会话（不是转到后台），由根路由带去登录页。
        ended.current = "cancelled";
        reportFailure(cause, { surface: "action" });
        close();
        return;
      }
      // 本机服务校验目录不通过时回的是参数错误：再看一眼目录，确实不可用就回到选目录，而不是停在「重试也没用」的失败页。
      if (cause instanceof ApiClientError && cause.code === "VALIDATION_ERROR" && rootPath.current !== null) {
        const path = rootPath.current;
        void api
          .inspectLocalDir(path)
          .catch(() => null)
          .then((inspection) => {
            const state = readEnded(ended);
            if (state === "cancelled") return;
            if (state === "detached") {
              // 复查期间用户把对话框转到了后台：照常告知失败，让调用方撤掉「后台准备中」。
              reportFailure(cause, { surface: "action", title: t.requirements.startSession.backgroundFailed });
              onBackgroundFailed?.();
              return;
            }
            const problem = directoryProblem(inspection);
            update(
              problem === null
                ? { name: "failed", failure, retry }
                : { name: "directory", initialPath: "", notice: { reason: problem, path } },
            );
          });
        return;
      }
      update({ name: "failed", failure, retry });
    },
    [close, onBackgroundFailed, t, update],
  );

  const create = useCallback(async () => {
    if (ended.current !== "open") return;
    update({ name: "preparing", startedAt: Date.now(), rootPath: rootPath.current });
    try {
      const session =
        request.kind === "project"
          ? await api.createRequirementsProjectSession(request.remoteProjectId)
          : await api.createRequirementsSession(request.requirementId);
      // await 期间用户可能已把对话框转到后台；重新读取，不用进入函数时的收窄结果。
      onReady(session, readEnded(ended) === "detached");
    } catch (cause) {
      fail(cause, "create");
    }
  }, [fail, onReady, request, update]);

  const check = useCallback(async () => {
    update({ name: "checking" });
    try {
      const mappings = await api.listRequirementsMappings();
      if (ended.current !== "open") return;
      const mapping = mappings.items.find((item) => item.remoteProjectId === request.remoteProjectId);
      if (mapping === undefined) {
        update({ name: "directory", initialPath: "", notice: null });
        return;
      }
      rootPath.current = mapping.rootPath;
      // 关联过的目录可能已被移动、删除或失去权限：先确认，不行就直接请用户重新选。
      const problem = directoryProblem(await api.inspectLocalDir(mapping.rootPath).catch(() => null));
      if (readEnded(ended) !== "open") return;
      if (problem !== null) {
        update({ name: "directory", initialPath: "", notice: { reason: problem, path: mapping.rootPath } });
        return;
      }
      if (request.kind === "requirement") {
        const sessions = await api.listRequirementsSessions(request.remoteProjectId);
        if (ended.current !== "open") return;
        const existing = sessions.items
          .filter((item) => item.requirement?.remoteRequirementId === request.requirementId)
          .sort((a, b) => sessionActivity(b.session) - sessionActivity(a.session));
        if (existing.length > 0) {
          update({ name: "choose", existing });
          return;
        }
      }
      await create();
    } catch (cause) {
      fail(cause, "check");
    }
  }, [create, fail, request, update]);

  const started = useRef(false);
  useEffect(() => {
    // 只在打开时检查一次（StrictMode 下 effect 会跑两遍，不能因此建出两个会话）；之后由各步骤的按钮推进。
    if (started.current) return;
    started.current = true;
    void check();
  }, [check]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent size={step.name === "directory" ? "lg" : "md"} data-testid="start-session-dialog">
        <DialogHeader>
          <DialogTitle>{step.name === "directory" ? t.requirements.startSession.directoryTitle : t.requirements.startSession.title}</DialogTitle>
          <DialogDescription className="truncate">{subject}</DialogDescription>
        </DialogHeader>

        {step.name === "checking" ? <CheckingBody /> : null}
        {step.name === "choose" ? (
          <ChooseBody
            existing={step.existing}
            onResume={(session) => {
              ended.current = "cancelled";
              onReady(session, false);
            }}
            onCreate={() => void create()}
            onCancel={close}
          />
        ) : null}
        {step.name === "directory" ? (
          <DirectoryBody
            initialPath={step.initialPath}
            notice={step.notice}
            remoteProjectId={request.remoteProjectId}
            onCancel={close}
            onSaved={(path) => {
              rootPath.current = path;
              void check();
            }}
          />
        ) : null}
        {step.name === "preparing" ? (
          <PreparingBody
            startedAt={step.startedAt}
            rootPath={step.rootPath}
            forRequirement={request.kind === "requirement"}
            onHide={close}
          />
        ) : null}
        {step.name === "failed" ? (
          <>
            <RegionError
              kind={step.failure.kind}
              message={t.requirements.startSession.failed(step.failure.message)}
            />
            <DialogFooter>
              <Button variant="secondary" onClick={close}>{t.feedback.dialog.close}</Button>
              <Button variant="primary" onClick={() => void (step.retry === "check" ? check() : create())}>
                <RotateCwIcon />
                {t.feedback.retry}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function readEnded<T>(ref: { current: T }): T {
  return ref.current;
}

function sessionActivity(session: SessionDto): number {
  return session.lastActivityAt ?? session.updatedAt;
}

function CheckingBody() {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 py-2" aria-busy="true" aria-label={t.requirements.startSession.checking}>
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-4 w-2/5" />
    </div>
  );
}

function ChooseBody({
  existing,
  onResume,
  onCreate,
  onCancel,
}: {
  existing: RequirementsSessionReferenceDto[];
  onResume(session: SessionDto): void;
  onCreate(): void;
  onCancel(): void;
}) {
  const t = useT();
  const text = t.requirements.startSession.choose;
  const shown = existing.slice(0, 3);
  return (
    <>
      <p className="m-0 text-small text-muted-foreground">{text.intro(existing.length)}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={text.listLabel}>
        {shown.map(({ session }, index) => (
          <li key={session.id}>
            <button
              type="button"
              autoFocus={index === 0}
              className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left outline-none hover:border-border-strong hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onResume(session)}
            >
              <MessageSquareIcon className="size-4 shrink-0 text-subtle-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-medium">{session.title || text.untitled}</span>
                <span className="text-caption text-subtle-foreground">
                  {text.activity(formatRelativeTime(sessionActivity(session)), index === 0)}
                </span>
              </span>
              <span className="text-small font-medium text-primary-text">{text.resume}</span>
            </button>
          </li>
        ))}
      </ul>
      {existing.length > shown.length ? (
        <p className="m-0 text-caption text-subtle-foreground">{text.more(existing.length - shown.length)}</p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{t.feedback.dialog.cancel}</Button>
        <Button variant="secondary" onClick={onCreate}>
          <MessageSquarePlusIcon />
          {text.createNew}
        </Button>
      </DialogFooter>
    </>
  );
}

function DirectoryBody({
  initialPath,
  notice,
  remoteProjectId,
  onCancel,
  onSaved,
}: {
  initialPath: string;
  notice: DirectoryNotice | null;
  remoteProjectId: string;
  onCancel(): void;
  onSaved(path: string): void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [path, setPath] = useState(initialPath);
  const [valid, setValid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  async function save() {
    const target = path.trim();
    if (target === "" || saving) return;
    setSaving(true);
    setError(null);
    try {
      const mapping = await api.saveRequirementsMapping(remoteProjectId, target);
      void invalidateMappingCaches(queryClient);
      onSaved(mapping.rootPath);
    } catch (cause) {
      const failure = classifyFailure(cause);
      if (failure.kind === "auth_expired") {
        reportFailure(cause, { surface: "action" });
        return;
      }
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="m-0 text-small text-muted-foreground">
        {notice === null ? t.requirements.startSession.directory.intro : noticeText(notice, t)}
      </p>
      <DirectoryPicker value={path} onChange={setPath} onValidityChange={setValid} />
      {error === null ? null : <InlineError kind={error.kind}>{error.message}</InlineError>}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>{t.feedback.dialog.cancel}</Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={!valid}
          disabledReason={t.requirements.startSession.directory.useDisabledReason}
          onClick={() => void save()}
        >
          {t.requirements.startSession.directory.use}
        </Button>
      </DialogFooter>
    </>
  );
}

function PreparingBody({
  startedAt,
  rootPath,
  forRequirement,
  onHide,
}: {
  startedAt: number;
  rootPath: string | null;
  forRequirement: boolean;
  onHide(): void;
}) {
  const t = useT();
  const text = t.requirements.startSession.preparing;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const slow = now - startedAt > SLOW_AFTER_MS;

  return (
    <>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        <Stage state="done" title={text.directoryReady} detail={rootPath} />
        <Stage state="active" title={forRequirement ? text.syncAndStart : text.start} detail={text.elapsed(elapsed)} />
        <Stage state="pending" title={text.enter} detail={null} />
      </ol>
      {slow ? (
        <p className="m-0 text-caption text-subtle-foreground" role="status">
          {text.slow}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onHide}>{text.background}</Button>
      </DialogFooter>
    </>
  );
}

function Stage({
  state,
  title,
  detail,
}: {
  state: "done" | "active" | "pending";
  title: string;
  detail: string | null;
}) {
  return (
    <li className="flex items-start gap-3" aria-current={state === "active" ? "step" : undefined}>
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
        {state === "done" ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-success-soft text-success">
            <CheckIcon className="size-3.5" />
          </span>
        ) : null}
        {state === "active" ? <Spinner className="text-primary-text" /> : null}
        {state === "pending" ? <CircleIcon className="size-4 text-disabled-foreground" /> : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={cn("text-body", state === "pending" ? "text-subtle-foreground" : "font-medium text-foreground")}>
          {title}
        </span>
        {detail === null ? null : (
          <span className={cn("truncate text-caption text-subtle-foreground", state === "done" && "font-mono")}>{detail}</span>
        )}
      </span>
    </li>
  );
}
