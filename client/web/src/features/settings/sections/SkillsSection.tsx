import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { SkillCatalogEntry, SkillDto } from "@suduo/client-contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "../../../api/client.js";
import { ConfirmDialog, EmptyState, RegionError } from "../../../feedback/components/index.js";
import { needsConfirm } from "../../../feedback/confirm-policy.js";
import { reportFailure } from "../../../feedback/report.js";
import { FEEDBACK_TIMING_MS } from "../../../feedback/routes.js";
import { useT } from "../../../i18n/provider.js";
import type { Messages } from "../../../i18n/messages/index.js";
import {
  ItemList,
  ItemRow,
  LockNote,
  rowDescId,
  rowLabelId,
  SaveStatus,
  SettingsRow,
  SettingsSection,
  useSaveIndicator,
} from "../components/kit.js";
import {
  globalSkillsQuery,
  localSettingsQuery,
  settingsKeys,
  skillCatalogQuery,
  useUpdateLocalSettings,
  workspaceMappingsQuery,
} from "../queries.js";
import { defaultSkillProjectId, skillProjectOptions } from "../skill-project-context.js";
import { useQueryFailure } from "../use-query-failure.js";

function scopeLabel(text: Messages["settingsAgent"]["skills"], scope: string): string {
  const labels: Readonly<Record<string, string>> = text.scope;
  return labels[scope] ?? text.scopeOther;
}

/** Skills：个人 Skills 目录开关、安装 / 卸载、按项目启停。 */
export function SkillsSection() {
  const text = useT().settingsAgent.skills;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const local = useQuery(localSettingsQuery);
  const skills = useQuery(globalSkillsQuery);
  const mappings = useQuery(workspaceMappingsQuery);
  const update = useUpdateLocalSettings();
  const [globalSaved, trackGlobal] = useSaveIndicator();
  const skillsFailure = useQueryFailure(skills);

  const projects = useMemo(() => skillProjectOptions(mappings.data ?? []), [mappings.data]);
  const [localProjectId, setLocalProjectId] = useState<string | null>(() => defaultSkillProjectId(projects));
  useEffect(() => {
    setLocalProjectId((current) =>
      current !== null && projects.some((item) => item.localProjectId === current) ? current : defaultSkillProjectId(projects),
    );
  }, [projects]);
  const catalog = useQuery({ ...skillCatalogQuery(localProjectId ?? ""), enabled: localProjectId !== null });

  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [still, setStill] = useState(false);
  const [pendingUninstall, setPendingUninstall] = useState<SkillDto | null>(null);
  const [busySkill, setBusySkill] = useState<string | null>(null);
  const installRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!installing) {
      setStill(false);
      return;
    }
    const timer = window.setTimeout(() => setStill(true), FEEDBACK_TIMING_MS.stillProcessing);
    return () => window.clearTimeout(timer);
  }, [installing]);

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: settingsKeys.skills });
  };

  const [installError, setInstallError] = useState<string | null>(null);
  const install = async () => {
    setInstalling(true);
    try {
      await api.installSkill({ source: "folder", path: installPath.trim() });
      setInstallPath("");
      await reload();
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.install.failed });
    } finally {
      setInstalling(false);
    }
  };

  const uninstall = async (skill: SkillDto) => {
    setBusySkill(skill.path);
    try {
      await api.removeSkill(skill.path);
      await reload();
    } catch (cause) {
      reportFailure(cause, { surface: "action", title: text.list.uninstallFailed });
    } finally {
      setBusySkill(null);
    }
  };

  const toggle = async (entry: SkillCatalogEntry, enabled: boolean) => {
    if (localProjectId === null) return;
    const key = settingsKeys.skillCatalog(localProjectId);
    const before = queryClient.getQueryData<SkillCatalogEntry[]>(key);
    queryClient.setQueryData<SkillCatalogEntry[]>(key, (items) =>
      items?.map((item) => (item.name === entry.name ? { ...item, enabled } : item)),
    );
    try {
      await api.setSkillEnabled(entry.name, enabled);
    } catch (cause) {
      queryClient.setQueryData(key, before);
      reportFailure(cause, { surface: "action", title: text.list.toggleFailed, retry: () => void toggle(entry, enabled) });
    } finally {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const globalLocked = local.data?.globalSkillsLocked === true;

  return (
    <SettingsSection id="skills" description={text.description}>
      <SettingsRow
        anchor="global-skills"
        title={text.global.title}
        description={skills.data?.root === undefined ? text.global.description : text.global.folder(skills.data.root)}
        status={<SaveStatus state={globalSaved} />}
      >
        <div className="flex flex-col gap-2">
          <Switch
            aria-labelledby={rowLabelId("global-skills")}
            aria-describedby={rowDescId("global-skills")}
            checked={local.data?.globalSkills ?? true}
            disabled={local.data === undefined || globalLocked}
            data-testid="settings-global-skills"
            onCheckedChange={(checked) => trackGlobal(update.mutateAsync({ globalSkills: checked }))}
          />
          {globalLocked ? <LockNote>{text.global.locked}</LockNote> : null}
        </div>
      </SettingsRow>

      <SettingsRow anchor="skill-project" title={text.project.title} description={text.project.description}>
        {mappings.isPending ? (
          <Skeleton className="h-8 w-56" />
        ) : projects.length === 0 ? (
          <div data-testid="skills-project-context-empty">
            <EmptyState
              kind="prerequisite"
              size="inline"
              title={text.project.emptyTitle}
              action={{ label: text.project.emptyAction, onClick: () => void navigate({ to: "/settings/$section", params: { section: "workspace" } }) }}
            />
          </div>
        ) : projects.length === 1 ? (
          <span className="text-small text-foreground">{projects[0]?.localProjectName}</span>
        ) : (
          <Select value={localProjectId ?? ""} onValueChange={(value) => setLocalProjectId(value)}>
            <SelectTrigger className="max-w-64" aria-labelledby={rowLabelId("skill-project")} data-testid="skills-project-context">
              <SelectValue placeholder={text.project.placeholder} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.localProjectId} value={project.localProjectId}>
                  {project.localProjectName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>

      <SettingsRow anchor="install-skill" title={text.install.title} htmlFor="skill-install-path" description={text.install.description}>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            // 提交按钮不禁用（技术设计 §6.2）：空着点就说清楚要填什么。
            if (installPath.trim() === "") {
              setInstallError(text.install.pathRequired);
              installRef.current?.focus();
              return;
            }
            void install();
          }}
        >
          <Input
            ref={installRef}
            id="skill-install-path"
            data-testid="skill-install-path"
            className="font-mono"
            placeholder="/Users/you/skills/my-skill"
            value={installPath}
            aria-invalid={installError === null ? undefined : true}
            aria-describedby={installError === null ? undefined : "skill-install-error"}
            onChange={(event) => {
              setInstallPath(event.target.value);
              setInstallError(null);
            }}
          />
          <Button type="submit" loading={installing}>
            {text.install.submit}
          </Button>
        </form>
        {installError === null ? null : (
          <p id="skill-install-error" role="alert" className="m-0 text-caption text-danger">
            {installError}
          </p>
        )}
        {still ? (
          <p className="m-0 text-caption text-subtle-foreground" role="status">
            {text.install.stillWorking}
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow anchor="skill-list" title={text.list.title} stacked>
        {projects.length > 1 && localProjectId === null ? (
          <p className="m-0 rounded-md bg-muted px-3 py-2 text-small text-muted-foreground" data-testid="skills-project-context-required" role="status">
            {text.list.projectRequired}
          </p>
        ) : null}
        {localProjectId !== null && catalog.isError ? (
          <p className="m-0 text-small text-muted-foreground" role="status">
            {text.list.catalogUnavailable}
          </p>
        ) : null}
        {skills.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label={text.list.loading}>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : skills.isError ? (
          <div data-testid="skills-degraded-banner">
            <RegionError
              kind={skillsFailure?.kind ?? "unknown"}
              message={text.list.loadFailed(skillsFailure?.message ?? "")}
              busy={skills.isFetching}
              onRetry={() => void skills.refetch()}
            />
          </div>
        ) : skills.data.items.length === 0 ? (
          <EmptyState
            title={text.list.emptyTitle}
            description={text.list.emptyDescription}
            action={{ label: text.list.emptyAction, onClick: () => installRef.current?.focus() }}
          />
        ) : (
          <ItemList label={text.list.title} data-testid="skills-list">
            {skills.data.items.map((skill) => {
              const entry = catalog.data?.find((item) => item.name === skill.name);
              return (
                <ItemRow key={skill.path} data-testid="skill-row">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-body font-medium text-foreground">{skill.name}</span>
                      {entry === undefined ? null : (
                        <Badge variant="outline" data-testid="skill-scope">
                          {scopeLabel(text, entry.scope)}
                        </Badge>
                      )}
                      {skill.version === undefined ? null : (
                        <span className="text-caption text-subtle-foreground">{text.list.version(skill.version)}</span>
                      )}
                    </span>
                    <span className="truncate text-caption text-subtle-foreground">{skill.description ?? text.list.noDescription}</span>
                  </span>
                  {entry === undefined ? null : (
                    <Switch
                      aria-label={text.list.enable(skill.name)}
                      checked={entry.enabled}
                      onCheckedChange={(checked) => void toggle(entry, checked)}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    type="button"
                    loading={busySkill === skill.path}
                    onClick={() => {
                      if (needsConfirm("uninstall-skill")) setPendingUninstall(skill);
                      else void uninstall(skill);
                    }}
                  >
                    {text.list.uninstall}
                  </Button>
                </ItemRow>
              );
            })}
          </ItemList>
        )}
      </SettingsRow>

      <ConfirmDialog
        open={pendingUninstall !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUninstall(null);
        }}
        title={text.uninstallConfirm.title(pendingUninstall?.name ?? "")}
        description={text.uninstallConfirm.description}
        confirmLabel={text.uninstallConfirm.confirm}
        onConfirm={() => {
          if (pendingUninstall === null) return;
          const skill = pendingUninstall;
          setPendingUninstall(null);
          void uninstall(skill);
        }}
      />
    </SettingsSection>
  );
}
