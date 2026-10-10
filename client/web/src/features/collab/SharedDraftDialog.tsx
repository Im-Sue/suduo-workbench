import type { SecretHitDto, SharedDraftDto } from "@suduo/client-contracts";
import type { HandoffContent } from "@suduo/cloud-contracts";
import { ShieldAlertIcon, UploadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClientError, api } from "../../api/client.js";
import { classifyFailure } from "../../feedback/classify.js";
import { InlineError } from "../../feedback/components/index.js";
import { reportFailure } from "../../feedback/report.js";
import { useT } from "../../i18n/provider.js";
import { showMessage } from "../../ui/message.js";
import { SharedContentView } from "./SharedContentView.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

type ListKey = "decisions" | "todo" | "risks" | "files";
const items = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
const hitKey = (hit: SecretHitDto) => `${hit.field}\u0000${hit.kind}\u0000${hit.excerpt}`;
const isConflict = (cause: unknown) => cause instanceof ApiClientError && cause.status === 409;

/** 交接包在对话框里的编辑态：列表框保留原文（逐字输入不被吃掉空格、回车），保存与比较时再拆行。 */
interface HandoffForm {
  summary: string;
  branch: string;
  lists: Record<ListKey, string>;
}

function formOf(content: HandoffContent): HandoffForm {
  return {
    summary: content.summary,
    branch: content.branch ?? "",
    lists: { decisions: content.decisions.join("\n"), todo: content.todo.join("\n"), risks: content.risks.join("\n"), files: content.files.join("\n") },
  };
}

function contentOf(form: HandoffForm): HandoffContent {
  return {
    summary: form.summary,
    decisions: items(form.lists.decisions),
    todo: items(form.lists.todo),
    risks: items(form.lists.risks),
    branch: form.branch.trim() === "" ? null : form.branch.trim(),
    files: items(form.lists.files),
  };
}

/**
 * 发布共享对象到需求（多 Agent 协作 S11，需求 4.7 / 4.13）：本人预览、编辑（交接包各字段可改，评审报告与快照只读预览、
 * 可改标题；预览与需求里看到的是同一份），列出本机扫到的疑似密钥由人决定——有命中时按钮写「仍然发布」，不拦截。
 * 打开期间 Agent 又交了一版：保存时说明并给「载入最新 / 用我的覆盖」，发布时不发、载入最新请人再看（发布不可逆）。
 * 不用 useQuery：会话页的部分外壳不包 QueryClientProvider。
 */
export function SharedDraftDialog({ draftId, onClose }: { draftId: string; onClose(): void }) {
  const t = useT();
  const text = t.collab.share;
  const [draft, setDraft] = useState<SharedDraftDto | null>(null);
  const [loadError, setLoadError] = useState<ReturnType<typeof classifyFailure> | null>(null);
  const [title, setTitle] = useState("");
  const [form, setForm] = useState<HandoffForm | null>(null);
  /** 人已经看过的疑似密钥（保存后出现没看过的就停下给人看）。 */
  const [seenHits, setSeenHits] = useState<ReadonlySet<string>>(new Set());
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState<"save" | "publish" | "discard" | null>(null);

  const adopt = (next: SharedDraftDto) => {
    setDraft(next);
    setTitle(next.title);
    setForm(next.kind === "handoff" ? formOf(next.content as HandoffContent) : null);
    setConflict(false);
  };
  const reload = async () => {
    const latest = await api.getSharedDraft(draftId);
    adopt(latest);
    return latest;
  };
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.getSharedDraft(draftId))
      .then((loaded) => {
        if (cancelled) return;
        adopt(loaded);
        setSeenHits(new Set(loaded.secretHits.map(hitKey)));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(classifyFailure(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const edited = form === null ? null : contentOf(form);
  const dirty = draft !== null && (title.trim() !== draft.title || (edited !== null && JSON.stringify(edited) !== JSON.stringify(draft.content)));
  const save = async (overwrite: boolean): Promise<SharedDraftDto | null> => {
    if (draft === null) return null;
    if (!dirty) return draft;
    const saved = await api.updateSharedDraft(draft.id, {
      title: title.trim(),
      ...(edited === null ? {} : { content: edited }),
      ...(overwrite ? {} : { expectedUpdatedAt: draft.updatedAt }),
    });
    adopt(saved);
    return saved;
  };
  const run = async (kind: "save" | "publish" | "discard", overwrite = false) => {
    if (draft === null) return;
    setBusy(kind);
    try {
      if (kind === "save") {
        await save(overwrite);
        showMessage(text.dialog.saved, "success");
      } else if (kind === "discard") {
        await api.discardSharedDraft(draft.id);
        onClose();
      } else {
        const saved = await save(false);
        if (saved === null) return;
        // 保存后疑似密钥重新扫过：出现人还没看过的命中就停下给人看，不直接发出去。
        const unseen = saved.secretHits.filter((hit) => !seenHits.has(hitKey(hit)));
        setSeenHits(new Set(saved.secretHits.map(hitKey)));
        if (unseen.length > 0) return;
        await api.publishSharedDraft(saved.id, saved.updatedAt);
        showMessage(text.dialog.published, "success");
        onClose();
      }
    } catch (cause) {
      if (isConflict(cause) && kind === "publish" && !dirty) {
        // 预览之后草稿变了：没发出去，载入最新的请人再看一遍。
        const latest = await reload().catch(() => null);
        if (latest !== null) setSeenHits(new Set(latest.secretHits.map(hitKey)));
        showMessage(text.dialog.changedSincePreview, "warning");
      } else if (isConflict(cause)) {
        setConflict(true);
      } else {
        reportFailure(cause, { surface: "action", title: text.dialog.failures[kind] });
      }
    } finally {
      setBusy(null);
    }
  };

  const kind = draft === null ? "" : (text.kinds[draft.kind] ?? draft.kind);
  const hits = draft?.secretHits ?? [];
  return (
    <Dialog open onOpenChange={(open) => (!open && busy === null ? onClose() : undefined)}>
      <DialogContent size="lg" data-testid="shared-draft-dialog">
        <DialogHeader>
          <DialogTitle>{text.dialog.title(kind)}</DialogTitle>
          <DialogDescription>{text.dialog.description}</DialogDescription>
        </DialogHeader>
        {loadError !== null ? (
          <InlineError kind={loadError.kind}>
            {text.dialog.failures.load} · {loadError.message}
          </InlineError>
        ) : draft === null ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {draft.status === "published" ? <p className="m-0 text-small text-muted-foreground">{text.dialog.republishHint}</p> : null}
            {conflict ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-small text-foreground" data-testid="shared-draft-conflict">
                <span className="min-w-0 flex-1">{text.dialog.conflict}</span>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void reload()} data-testid="shared-draft-load-latest">
                  {text.dialog.loadLatest}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run("save", true)} data-testid="shared-draft-overwrite">
                  {text.dialog.overwrite}
                </Button>
              </div>
            ) : null}
            {hits.length === 0 ? null : (
              <div className="rounded-md bg-warning-soft px-3 py-2 text-small text-foreground" data-testid="shared-draft-secrets">
                <p className="m-0 flex items-center gap-1.5 font-medium">
                  <ShieldAlertIcon className="size-3.5 text-warning" aria-hidden="true" />
                  {text.dialog.secretsTitle(hits.length)}
                </p>
                <ul className="m-0 mt-1 list-none p-0 font-mono text-caption">
                  {hits.map((hit, index) => (
                    <li key={`${hit.field}-${String(index)}`}>
                      {hit.field} · {hit.kind} · {hit.excerpt}
                    </li>
                  ))}
                </ul>
                <p className="m-0 mt-1 text-caption text-muted-foreground">{text.dialog.secretsHint}</p>
              </div>
            )}
            <label className="flex flex-col gap-1 text-small">
              <span className="font-medium text-foreground">{text.dialog.titleLabel}</span>
              <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} data-testid="shared-draft-title" />
            </label>
            {form === null ? (
              <div data-testid="shared-draft-preview">
                <SharedContentView kind={draft.kind} content={draft.content} />
              </div>
            ) : (
              <HandoffEditor value={form} onChange={setForm} />
            )}
          </div>
        )}
        {draft === null || draft.status === "discarded" ? null : (
          <DialogFooter>
            {draft.status === "draft" ? (
              <Button variant="ghost" disabled={busy !== null} loading={busy === "discard"} onClick={() => void run("discard")} data-testid="shared-draft-discard">
                {text.dialog.discard}
              </Button>
            ) : null}
            {dirty ? (
              <Button variant="secondary" disabled={busy !== null} loading={busy === "save"} onClick={() => void run("save")} data-testid="shared-draft-save">
                {text.dialog.save}
              </Button>
            ) : null}
            <Button
              variant={hits.length === 0 ? "primary" : "danger"}
              disabled={busy !== null || title.trim() === "" || conflict || (form !== null && form.summary.trim() === "")}
              loading={busy === "publish"}
              onClick={() => void run("publish")}
              data-testid="shared-draft-publish"
            >
              <UploadIcon />
              {hits.length > 0 ? text.dialog.publishAnyway : draft.status === "published" ? text.dialog.republish : text.dialog.publish}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HandoffEditor({ value, onChange }: { value: HandoffForm; onChange(next: HandoffForm): void }) {
  const text = useT().collab.share.dialog;
  const setList = (key: ListKey, raw: string) => onChange({ ...value, lists: { ...value.lists, [key]: raw } });
  return (
    <>
      <label className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">{text.summary}</span>
        <Textarea rows={5} value={value.summary} onChange={(event) => onChange({ ...value, summary: event.target.value })} data-testid="shared-draft-summary" />
      </label>
      <label className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">{text.decisions}</span>
        <Textarea rows={3} value={value.lists.decisions} onChange={(event) => setList("decisions", event.target.value)} data-testid="shared-draft-decisions" />
      </label>
      <label className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">{text.todo}</span>
        <Textarea rows={3} value={value.lists.todo} onChange={(event) => setList("todo", event.target.value)} data-testid="shared-draft-todo" />
      </label>
      <label className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">{text.risks}</span>
        <Textarea rows={3} value={value.lists.risks} onChange={(event) => setList("risks", event.target.value)} data-testid="shared-draft-risks" />
      </label>
      <label className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">{text.branch}</span>
        <Input value={value.branch} className="font-mono" onChange={(event) => onChange({ ...value, branch: event.target.value })} data-testid="shared-draft-branch" />
      </label>
      <label className="flex flex-col gap-1 text-small">
        <span className="font-medium text-foreground">{text.files}</span>
        <Textarea rows={3} value={value.lists.files} onChange={(event) => setList("files", event.target.value)} data-testid="shared-draft-files" />
      </label>
    </>
  );
}
