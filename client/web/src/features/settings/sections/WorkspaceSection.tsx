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

type VerifiedMapping = RequirementsWorkspaceMappingDto & { verification?: WorkspaceMappingVerification };

/** 目录不可用的人话原因。 */
export function availabilityText(verification: WorkspaceMappingVerification | undefined): { ok: boolean; text: string } {
  if (verification === undefined) return { ok: true, text: "可用" };
  if (verification.available) return { ok: true, text: "可用" };
  if (!verification.exists) return { ok: false, text: "目录已不存在" };
  if (!verification.readable || !verification.writable || !verification.executable) {
    return { ok: false, text: "SuDuo 没有权限读写这个目录" };
  }
  return { ok: false, text: verification.message || "目录暂时不可用" };
}

/** 代码目录：每个项目在这台电脑上对应的代码目录；会话在这里读写代码。 */
export function WorkspaceSection() {
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
      reportFailure(cause, { surface: "action", title: "没能解除关联", retry: () => void remove(mapping) });
    } finally {
      setBusyId(null);
    }
  };

  const items = mappings.data ?? [];
  return (
    <SettingsSection
      id="workspace"
      description="每个项目在你电脑上对应的代码目录。会话会在这里读写代码，代码不会上传到需求服务。"
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
            重新检查
          </Button>
          <Button ref={addRef} size="sm" variant="primary" type="button" onClick={() => setEditing({ projectId: null })}>
            <FolderPlusIcon />
            关联代码目录
          </Button>
        </>
      }
    >
      <SettingsRow anchor="mappings" title="已关联的项目" stacked>
        {mappings.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="正在读取代码目录">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : mappings.isError ? (
          <RegionError
            kind={mappingsFailure?.kind ?? "unknown"}
            message={`没能读取代码目录：${mappingsFailure?.message ?? ""}`}
            busy={mappings.isFetching}
            onRetry={() => void mappings.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            kind="prerequisite"
            title="还没有关联代码目录"
            description="关联后才能在本机开始会话。第一次开始会话时也会请你选择。"
            action={{ label: "关联代码目录", onClick: () => setEditing({ projectId: null }) }}
          />
        ) : (
          <ItemList label="已关联的项目" data-testid="settings-mapping-list">
            {items.map((mapping) => {
              const name = projectName(mapping);
              const availability = availabilityText(mapping.verification);
              return (
                <ItemRow
                  key={mapping.remoteProjectId}
                  data-testid="settings-mapping-row"
                  data-available={availability.ok ? "true" : "false"}
                  aria-label={`${name}：${availability.text}`}
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
                    {availability.ok ? "更改目录" : "重新选择"}
                  </Button>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" type="button" aria-label={`「${name}」的更多操作`} disabled={busyId === mapping.remoteProjectId}>
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
                        解除关联
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {availability.ok ? null : (
                    <p className="m-0 basis-full pl-[38px] text-caption text-muted-foreground">
                      目录可能被移动、删除或改了权限。点「重新选择」换一个目录；把原目录恢复后，点「重新检查」。
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
        title={`解除「${removing === null ? "" : projectName(removing)}」的代码目录？`}
        description="解除后，开始这个项目的会话前需要重新选择目录。目录里的代码不会被删除。"
        confirmLabel="解除关联"
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
      projectId === "" ? "先选择项目" : path.trim() === "" ? "先选一个代码目录" : !valid ? "这个目录现在用不了，换一个可以读写的目录" : null;
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
          <DialogTitle>{presetProjectId === null ? "关联代码目录" : `更改「${projectLabel}」的代码目录`}</DialogTitle>
          <DialogDescription>选择这个项目的代码在你电脑上的目录。SuDuo 需要能读写这个目录。</DialogDescription>
        </DialogHeader>
        {presetProjectId === null ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="settings-map-project" className="text-small font-medium text-foreground">
              项目
            </label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="settings-map-project" aria-label="项目">
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                {active.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                    {mappings.some((item) => item.remoteProjectId === project.id) ? "（已关联，会替换原目录）" : ""}
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
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={saving}
            onClick={() => void save()}
          >
            {presetProjectId === null ? "关联" : "使用这个目录"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
