import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, FolderPlusIcon, MoreHorizontalIcon, RotateCwIcon, UnlinkIcon, XCircleIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  type RequirementsProjectDto,
  type RequirementsWorkspaceMappingDto,
  type WorkspaceMappingVerification,
} from "../../../api/client.js";
import { invalidateMappingCaches } from "../../../app/mapping-cache.js";
import { projectsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { ConfirmDialog, EmptyState, InlineError, RegionError } from "../../../feedback/components/index.js";
import { needsConfirm } from "../../../feedback/confirm-policy.js";
import { reportFailure } from "../../../feedback/report.js";
import type { Failure } from "../../../feedback/types.js";
import { DirectoryPicker } from "../../requirements/components/DirectoryPicker.js";
import { ItemList, ItemRow, SettingsRow, SettingsSection } from "../components/kit.js";
import { shortenPath } from "../format.js";
import { workspaceMappingsQuery } from "../queries.js";
import { useQueryFailure } from "../use-query-failure.js";
import { currentLocale } from "../../../i18n/locale.js";
import { messagesFor, type Messages } from "../../../i18n/messages/index.js";
import { useT } from "../../../i18n/provider.js";

type VerifiedMapping = RequirementsWorkspaceMappingDto & { verification?: WorkspaceMappingVerification };

/** 目录不可用的人话原因。 */
export function availabilityText(
  verification: WorkspaceMappingVerification | undefined,
  t: Messages = messagesFor(currentLocale()),
): { ok: boolean; text: string } {
  const text = t.settingsConnection.workspace.availability;
  if (verification === undefined) return { ok: true, text: text.ok };
  if (verification.available) return { ok: true, text: text.ok };
  if (!verification.exists) return { ok: false, text: text.missing };
  if (!verification.readable || !verification.writable || !verification.executable) {
    return { ok: false, text: text.noPermission };
  }
  // 其他原因显示本机服务写的说明。
  return { ok: false, text: verification.message || text.unavailable };
}

/** 代码目录：每个项目在这台电脑上对应的代码目录；会话在这里读写代码。 */
export function WorkspaceSection() {
  const t = useT();
  const text = t.settingsConnection.workspace;
  const queryClient = useQueryClient();
  const mappings = useQuery(workspaceMappingsQuery);
  const mappingsFailure = useQueryFailure(mappings);
  const projects = useQuery(projectsQuery);
  const [editing, setEditing] = useState<{ projectId: string | null } | null>(null);
  const [removing, setRemoving] = useState<VerifiedMapping | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const projectName = useCallback(
    (mapping: RequirementsWorkspaceMappingDto) =>
      projects.data?.find((project) => project.id === mapping.remoteProjectId)?.name ?? mapping.localProjectName,
    [projects.data],
  );

  const refresh = useCallback(async () => {
    await invalidateMappingCaches(queryClient);
  }, [queryClient]);

  const remove = async (mapping: VerifiedMapping) => {
    setBusyId(mapping.remoteProjectId);
    try {
      await api.removeRequirementsMapping(mapping.remoteProjectId);
      await refresh();
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.unlinkFailed, retry: () => void remove(mapping) });
    } finally {
      setBusyId(null);
    }
  };

  const items = mappings.data ?? [];
  return (
    <SettingsSection
      id="workspace"
      description={text.description}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            loading={mappings.isFetching && !mappings.isPending}
            onClick={() => void mappings.refetch()}
          >
            <RotateCwIcon />
            {text.recheck}
          </Button>
          <Button ref={addRef} size="sm" variant="primary" type="button" onClick={() => setEditing({ projectId: null })}>
            <FolderPlusIcon />
            {text.link}
          </Button>
        </>
      }
    >
      <SettingsRow anchor="mappings" title={text.linkedProjects} stacked>
        {mappings.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label={text.loading}>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : mappings.isError ? (
          <RegionError
            kind={mappingsFailure?.kind ?? "unknown"}
            message={text.loadFailed(mappingsFailure?.message ?? "")}
            busy={mappings.isFetching}
            onRetry={() => void mappings.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            kind="prerequisite"
            title={text.empty.title}
            description={text.empty.description}
            action={{ label: text.link, onClick: () => setEditing({ projectId: null }) }}
          />
        ) : (
          <ItemList label={text.linkedProjects} data-testid="settings-mapping-list">
            {items.map((mapping) => {
              const name = projectName(mapping);
              const availability = availabilityText(mapping.verification, t);
              return (
                <ItemRow
                  key={mapping.remoteProjectId}
                  data-testid="settings-mapping-row"
                  data-available={availability.ok ? "true" : "false"}
                  aria-label={text.rowLabel(name, availability.text)}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] bg-primary-soft text-caption font-semibold text-primary-text"
                  >
                    {name.slice(0, 1)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-foreground">{name}</span>
                    <span className="truncate font-mono text-caption text-subtle-foreground" title={mapping.rootPath}>
                      {shortenPath(mapping.rootPath)}
                    </span>
                  </span>
                  <span
                    className={
                      availability.ok
                        ? "inline-flex shrink-0 items-center gap-1 text-small text-success"
                        : "inline-flex shrink-0 items-center gap-1 text-small text-danger"
                    }
                    data-testid="mapping-availability"
                  >
                    {availability.ok ? <CircleCheckIcon aria-hidden="true" className="size-4" /> : <XCircleIcon aria-hidden="true" className="size-4" />}
                    {availability.text}
                  </span>
                  <Button
                    size="sm"
                    variant={availability.ok ? "ghost" : "secondary"}
                    type="button"
                    onClick={() => setEditing({ projectId: mapping.remoteProjectId })}
                  >
                    {availability.ok ? text.change : text.reselect}
                  </Button>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" type="button" aria-label={text.moreActions(name)} disabled={busyId === mapping.remoteProjectId}>
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        variant="danger"
                        onSelect={() => {
                          if (needsConfirm("unlink-workspace-mapping")) setRemoving(mapping);
                          else void remove(mapping);
                        }}
                      >
                        <UnlinkIcon />
                        {text.unlink}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {availability.ok ? null : (
                    <p className="m-0 basis-full pl-[38px] text-caption text-muted-foreground">
                      {text.unavailableHint}
                    </p>
                  )}
                </ItemRow>
              );
            })}
          </ItemList>
        )}
      </SettingsRow>

      <MappingDialog
        open={editing !== null}
        presetProjectId={editing?.projectId ?? null}
        projects={projects.data ?? []}
        mappings={items}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={refresh}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={text.unlinkConfirm.title(removing === null ? "" : projectName(removing))}
        description={text.unlinkConfirm.description}
        confirmLabel={text.unlinkConfirm.confirm}
        onConfirm={() => {
          if (removing !== null) void remove(removing);
        }}
      />
    </SettingsSection>
  );
}

function MappingDialog({
  open,
  presetProjectId,
  projects,
  mappings,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  presetProjectId: string | null;
  projects: readonly RequirementsProjectDto[];
  mappings: readonly VerifiedMapping[];
  onOpenChange(open: boolean): void;
  onSaved(): Promise<void>;
}) {
  const text = useT().settingsConnection.workspace.dialog;
  const active = useMemo(() => projects.filter((project) => !project.isArchived), [projects]);
  const existing = presetProjectId === null ? undefined : mappings.find((item) => item.remoteProjectId === presetProjectId);
  const [projectId, setProjectId] = useState("");
  const [path, setPath] = useState("");
  const [valid, setValid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // 每次打开按入口重置：从某一行进来时项目固定，路径从原目录开始浏览。
  const key = open ? `${presetProjectId ?? ""}` : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (key !== null) {
      const unmapped = active.find((project) => !mappings.some((item) => item.remoteProjectId === project.id));
      setProjectId(presetProjectId ?? unmapped?.id ?? active[0]?.id ?? "");
      setPath(existing?.rootPath ?? "");
      setFailure(null);
    }
  }

  const [hint, setHint] = useState<string | null>(null);
  const projectLabel = projects.find((project) => project.id === projectId)?.name ?? "";
  const save = async () => {
    // 提交按钮不禁用（技术设计 §6.2）：点了再说哪里不对。
    const problem =
      projectId === "" ? text.projectRequired : path.trim() === "" ? text.pathRequired : !valid ? text.pathUnusable : null;
    setHint(problem);
    if (problem !== null) return;
    setSaving(true);
    setFailure(null);
    try {
      await api.saveRequirementsMapping(projectId, path.trim());
      await onSaved();
      onOpenChange(false);
    } catch (cause) {
      const reported = reportFailure(cause, { surface: "field" });
      setFailure(reported.route.outlet === "field" ? reported.failure : classifyFailure(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="settings-mapping-dialog">
        <DialogHeader>
          <DialogTitle>{presetProjectId === null ? text.titleLink : text.titleChange(projectLabel)}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        {presetProjectId === null ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="settings-map-project" className="text-small font-medium text-foreground">
              {text.project}
            </label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="settings-map-project" aria-label={text.project}>
                <SelectValue placeholder={text.projectPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {active.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                    {mappings.some((item) => item.remoteProjectId === project.id) ? text.alreadyLinked : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <DirectoryPicker value={path} onChange={setPath} onValidityChange={setValid} />
        {hint === null ? null : <InlineError kind="validation">{hint}</InlineError>}
        {failure === null ? null : <InlineError kind={failure.kind}>{failure.message}</InlineError>}
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {text.cancel}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={saving}
            onClick={() => void save()}
          >
            {presetProjectId === null ? text.link : text.useFolder}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
