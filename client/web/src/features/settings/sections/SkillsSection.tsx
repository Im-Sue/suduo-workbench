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

const SCOPE_LABEL: Readonly<Record<string, string>> = {
  user: "个人",
  repo: "项目",
  system: "内置",
  admin: "管理员",
};

/** Skills：个人 Skills 目录开关、安装 / 卸载、按项目启停。 */
export function SkillsSection() {
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
      reportFailure(cause, { surface: "action", title: "没能安装" });
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
      reportFailure(cause, { surface: "action", title: "没能卸载" });
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
      reportFailure(cause, { surface: "action", title: "未能保存", retry: () => void toggle(entry, enabled) });
    } finally {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const globalLocked = local.data?.globalSkillsLocked === true;

  return (
    <SettingsSection id="skills" description="Skill 是给 Codex 的做事说明。可用的越多，每条说明能分到的篇幅越少——停用不常用的，常用的会被理解得更准。">
      <SettingsRow
        anchor="global-skills"
        title="使用个人 Skills 目录"
        description={skills.data?.root === undefined ? "关闭后，只使用项目里自带的 Skills。" : `目录：${skills.data.root}`}
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
          {globalLocked ? <LockNote>管理员已固定这个开关。需要调整时请联系管理员。</LockNote> : null}
        </div>
      </SettingsRow>

      <SettingsRow anchor="skill-project" title="查看的项目" description="不同项目能用的 Skills 和启用状态可能不同。">
        {mappings.isPending ? (
          <Skeleton className="h-8 w-56" />
        ) : projects.length === 0 ? (
          <div data-testid="skills-project-context-empty">
            <EmptyState
              kind="prerequisite"
              size="inline"
              title="还没有关联代码目录，只能看到已安装的 Skills"
              action={{ label: "去关联", onClick: () => void navigate({ to: "/settings/$section", params: { section: "workspace" } }) }}
            />
          </div>
        ) : projects.length === 1 ? (
          <span className="text-small text-foreground">{projects[0]?.localProjectName}</span>
        ) : (
          <Select value={localProjectId ?? ""} onValueChange={(value) => setLocalProjectId(value)}>
            <SelectTrigger className="max-w-64" aria-labelledby={rowLabelId("skill-project")} data-testid="skills-project-context">
              <SelectValue placeholder="选择项目" />
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

      <SettingsRow anchor="install-skill" title="安装 Skill" htmlFor="skill-install-path" description="填写本机上 Skill 文件夹的完整路径。">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            // 提交按钮不禁用（技术设计 §6.2）：空着点就说清楚要填什么。
            if (installPath.trim() === "") {
              setInstallError("先填写 Skill 文件夹的完整路径");
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
            安装
          </Button>
        </form>
        {installError === null ? null : (
          <p id="skill-install-error" role="alert" className="m-0 text-caption text-danger">
            {installError}
          </p>
        )}
        {still ? (
          <p className="m-0 text-caption text-subtle-foreground" role="status">
            仍在处理…
          </p>
        ) : null}
      </SettingsRow>

      <SettingsRow anchor="skill-list" title="已安装的 Skills" stacked>
        {projects.length > 1 && localProjectId === null ? (
          <p className="m-0 rounded-md bg-muted px-3 py-2 text-small text-muted-foreground" data-testid="skills-project-context-required" role="status">
            选择项目后，这里会显示每个 Skill 的来源和启用开关。
          </p>
        ) : null}
        {localProjectId !== null && catalog.isError ? (
          <p className="m-0 text-small text-muted-foreground" role="status">
            暂时读不到这个项目的启用状态，下面只列出已安装的 Skills。
          </p>
        ) : null}
        {skills.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="正在读取 Skills">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : skills.isError ? (
          <div data-testid="skills-degraded-banner">
            <RegionError
              kind={skillsFailure?.kind ?? "unknown"}
              message={`没能读取 Skills：${skillsFailure?.message ?? ""}`}
              busy={skills.isFetching}
              onRetry={() => void skills.refetch()}
            />
          </div>
        ) : skills.data.items.length === 0 ? (
          <EmptyState
            title="还没有安装任何 Skill"
            description="可以从本机的 Skill 文件夹安装。"
            action={{ label: "安装 Skill", onClick: () => installRef.current?.focus() }}
          />
        ) : (
          <ItemList label="已安装的 Skills" data-testid="skills-list">
            {skills.data.items.map((skill) => {
              const entry = catalog.data?.find((item) => item.name === skill.name);
              return (
                <ItemRow key={skill.path} data-testid="skill-row">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-body font-medium text-foreground">{skill.name}</span>
                      {entry === undefined ? null : (
                        <Badge variant="outline" data-testid="skill-scope">
                          {SCOPE_LABEL[entry.scope] ?? "其他"}
                        </Badge>
                      )}
                      {skill.version === undefined ? null : (
                        <span className="text-caption text-subtle-foreground">版本 {skill.version}</span>
                      )}
                    </span>
                    <span className="truncate text-caption text-subtle-foreground">{skill.description ?? "没有说明"}</span>
                  </span>
                  {entry === undefined ? null : (
                    <Switch
                      aria-label={`启用 ${skill.name}`}
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
                    卸载
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
        title={`卸载「${pendingUninstall?.name ?? ""}」？`}
        description="卸载会删除这个 Skill 的文件夹，之后需要重新安装才能使用。"
        confirmLabel="卸载"
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
