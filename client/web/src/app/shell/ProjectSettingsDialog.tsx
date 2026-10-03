import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, ArchiveRestoreIcon, FolderGit2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type RequirementsProjectDto } from "../../api/client.js";
import { invalidateMappingCaches } from "../mapping-cache.js";
import { classifyFailure } from "../../feedback/classify.js";
import { ConfirmDialog, InlineError } from "../../feedback/components/index.js";
import type { Failure } from "../../feedback/types.js";
import { DirectoryPicker } from "../../features/requirements/components/DirectoryPicker.js";
import { requirementKeys } from "../../features/requirements/keys.js";
import { useT } from "../../i18n/provider.js";
import { showMessage } from "../../ui/message.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { queryKeys, settingsQuery } from "../queries.js";

/**
 * 项目设置：改名、本机代码目录（更改 / 解除关联）、归档与恢复。
 * 名称后写生效：不带版本号直接保存；打开对话框后有别人改过名，照常保存，只在保存后说明覆盖了谁的修改（ADR-0004）。
 */
export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: RequirementsProjectDto | null;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const queryClient = useQueryClient();
  const t = useT();
  const text = t.shell.projectSettings;
  const settings = useQuery(settingsQuery);
  const meId = settings.data?.session?.user.id ?? null;
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  // 打开时看到的项目：保存后拿它对照，判断期间有没有别人改过名。之后实时推来的变化不重置正在输入的名称。
  const opened = useRef<RequirementsProjectDto | null>(null);

  useEffect(() => {
    if (!open) {
      opened.current = null;
      return;
    }
    if (project !== null && opened.current === null) {
      opened.current = project;
      setName(project.name);
      setFailure(null);
    }
  }, [open, project]);

  if (project === null) return null;
  const trimmed = name.trim();

  const patch = async (body: { name: string } | { isArchived: boolean }, success: string) => {
    setSaving(true);
    setFailure(null);
    try {
      // 只用来检测、不拦截：取不到就不说明，照常保存。
      const before = "name" in body ? await api.getRequirementsProject(project.id).catch(() => null) : null;
      const saved = await api.updateRequirementsProject(project.id, body);
      const base = opened.current;
      opened.current = saved;
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      const overwrote =
        before !== null && base !== null && before.version !== base.version && before.name !== base.name && before.updatedBy.id !== meId
          ? text.overwrote(before.updatedBy.displayName, before.name)
          : "";
      showMessage(`${success}${overwrote}`, "success");
      return true;
    } catch (cause) {
      setFailure(classifyFailure(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="md" data-testid="project-settings-dialog">
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>{text.description}</DialogDescription>
          </DialogHeader>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmed === "" || trimmed === project.name) return;
              void patch({ name: trimmed }, text.nameSaved);
            }}
          >
            <Field label={text.nameLabel} className="flex-1" error={trimmed === "" ? text.nameEmpty : undefined}>
              <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" loading={saving} disabled={trimmed === "" || trimmed === project.name}>
              {text.save}
            </Button>
          </form>
          {failure === null ? null : <InlineError kind={failure.kind}>{failure.message}</InlineError>}
          <Separator />
          <LocalDirectorySetting projectId={project.id} />
          <Separator />
          <section className="flex items-start gap-3">
            <div className="flex flex-1 flex-col gap-0.5">
              <h3 className="m-0 text-small font-semibold">{project.isArchived ? text.archive.headingArchived : text.archive.heading}</h3>
              <p className="m-0 text-caption text-muted-foreground">
                {project.isArchived ? text.archive.hintArchived : text.archive.hint}
              </p>
            </div>
            {project.isArchived ? (
              <Button variant="secondary" loading={saving} onClick={() => void patch({ isArchived: false }, text.archive.restored)}>
                <ArchiveRestoreIcon />
                {text.archive.restore}
              </Button>
            ) : (
              <Button variant="danger-ghost" onClick={() => setConfirmArchive(true)}>
                <ArchiveIcon />
                {text.archive.archive}
              </Button>
            )}
          </section>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{text.done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={text.archive.confirmTitle(project.name)}
        description={text.archive.confirmDescription}
        confirmLabel={text.archive.confirm}
        onConfirm={() => void patch({ isArchived: true }, text.archive.archived)}
      />
    </>
  );
}

function LocalDirectorySetting({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const text = useT().shell.projectSettings.localFolder;
  const mappings = useQuery({
    queryKey: requirementKeys.mappings,
    queryFn: () => api.listRequirementsMappings(),
    staleTime: 60_000,
  });
  const mapping = mappings.data?.items.find((item) => item.remoteProjectId === projectId);
  const [changing, setChanging] = useState(false);
  const [path, setPath] = useState("");
  const [valid, setValid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const refresh = async () => {
    await Promise.all([
      invalidateMappingCaches(queryClient),
      queryClient.invalidateQueries({ queryKey: requirementKeys.sessions(projectId) }),
    ]);
  };

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.saveRequirementsMapping(projectId, path.trim());
      await refresh();
      setChanging(false);
      showMessage(text.updated, "success");
    } catch (cause) {
      setFailure(classifyFailure(cause));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.removeRequirementsMapping(projectId);
      await refresh();
      showMessage(text.unlinked, "success");
    } catch (cause) {
      setFailure(classifyFailure(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="m-0 text-small font-semibold">{text.heading}</h3>
          {mapping === undefined ? (
            <p className="m-0 text-caption text-muted-foreground">{text.notLinked}</p>
          ) : (
            <p className="m-0 flex items-center gap-1.5 font-mono text-caption text-foreground" title={mapping.rootPath}>
              <FolderGit2Icon className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
              <span className="truncate">{mapping.rootPath}</span>
            </p>
          )}
        </div>
        {changing ? null : (
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setPath(mapping?.rootPath ?? "");
                setChanging(true);
              }}
            >
              {mapping === undefined ? text.choose : text.change}
            </Button>
            {mapping === undefined ? null : (
              <Button size="sm" variant="danger-ghost" loading={busy} onClick={() => setConfirmUnlink(true)}>
                {text.unlink}
              </Button>
            )}
          </div>
        )}
      </div>
      {changing ? (
        <div className="flex flex-col gap-2">
          <DirectoryPicker value={path} onChange={setPath} onValidityChange={setValid} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setChanging(false)}>{text.cancel}</Button>
            <Button size="sm" variant="primary" loading={busy} disabled={!valid} disabledReason={text.pickFirst} onClick={() => void save()}>
              {text.use}
            </Button>
          </div>
        </div>
      ) : null}
      {failure === null ? null : <InlineError kind={failure.kind}>{failure.message}</InlineError>}
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title={text.confirmTitle}
        description={text.confirmDescription}
        confirmLabel={text.confirm}
        onConfirm={() => void unlink()}
      />
    </section>
  );
}
