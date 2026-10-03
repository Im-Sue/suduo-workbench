import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChartColumnIcon,
  FolderPlusIcon,
  InboxIcon,
  KanbanSquareIcon,
  KeyboardIcon,
  MessageCircleIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { useDeferredValue, useState } from "react";
import { api } from "../../api/client.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { StatusIcon } from "@/components/ui/status-icon";
import { applyThemePreference } from "../../ui/theme.js";
import { rememberProjectId, useCurrentProject } from "../project-context.js";
import { ProjectMark } from "./ProjectSwitcher.js";
import { requirementCode } from "../../features/requirements/format.js";
import { requirementKeys } from "../../features/requirements/keys.js";
import { useSessionLauncher } from "./SessionLauncher.js";
import { keyLabel } from "../shortcuts.js";
import { requestProjectAction, setCommandPaletteOpen, setShortcutsOpen, useCommandPaletteOpen } from "./shell-actions.js";

/** ⌘K 命令面板：跳转、搜需求（按标题）、切项目、常用动作。 */
export function CommandPalette({ onToggleSidebar }: { onToggleSidebar(): void }) {
  const open = useCommandPaletteOpen();
  const navigate = useNavigate();
  const { project, projects } = useCurrentProject();
  const launcher = useSessionLauncher();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());

  const search = useQuery({
    queryKey: requirementKeys.search(project?.id ?? "", deferred),
    queryFn: ({ signal }) =>
      api.listRequirements(project?.id ?? "", { search: deferred, limit: 8 }, { signal }),
    enabled: open && project !== null && deferred.length > 0,
    staleTime: 15_000,
  });

  const close = () => {
    setCommandPaletteOpen(false);
    setQuery("");
  };
  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setCommandPaletteOpen(true) : close())}>
      <DialogContent
        showCloseButton={false}
        size="md"
        className="top-[18vh] translate-y-0 gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">搜索或执行命令</DialogTitle>
        <Command loop>
          <CommandInput value={query} onValueChange={setQuery} placeholder="搜索需求标题或编号、页面、命令" />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>
              {search.isFetching ? (
                <span className="inline-flex items-center gap-2"><Spinner />正在搜索…</span>
              ) : (
                "没有匹配的结果"
              )}
            </CommandEmpty>

            {project !== null && deferred.length > 0 && (search.data?.items.length ?? 0) > 0 ? (
              <CommandGroup heading={`需求 · ${project.name}`}>
                {search.data?.items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${query} ${requirementCode(item.number)} ${item.title} ${item.id}`}
                    onSelect={run(() =>
                      void navigate({
                        to: "/p/$projectId/requirements/$number",
                        params: { projectId: project.id, number: String(item.number) },
                      }),
                    )}
                  >
                    <StatusIcon status={item.status} />
                    <span className="w-16 shrink-0 font-mono text-caption text-subtle-foreground">{requirementCode(item.number)}</span>
                    <span className="flex-1 truncate">{item.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            <CommandGroup heading="跳转">
              <CommandItem value="我的工作 my" onSelect={run(() => void navigate({ to: "/my" }))}>
                <InboxIcon />我的工作
              </CommandItem>
              {project === null ? null : (
                <CommandItem
                  value="需求 看板 requirements"
                  onSelect={run(() => void navigate({ to: "/p/$projectId/requirements", params: { projectId: project.id } }))}
                >
                  <KanbanSquareIcon />需求
                </CommandItem>
              )}
              {project === null ? null : (
                <CommandItem
                  value="讨论 房间 群聊 rooms chat"
                  onSelect={run(() => void navigate({ to: "/p/$projectId/rooms", params: { projectId: project.id } }))}
                >
                  <MessageCircleIcon />讨论
                </CommandItem>
              )}
              <CommandItem value="会话 sessions" onSelect={run(() => void navigate({ to: "/sessions" }))}>
                <MessagesSquareIcon />会话
              </CommandItem>
              {project === null ? null : (
                <CommandItem
                  value="概览 overview"
                  onSelect={run(() => void navigate({ to: "/p/$projectId/overview", params: { projectId: project.id } }))}
                >
                  <ChartColumnIcon />概览
                </CommandItem>
              )}
              <CommandItem value="设置 settings" onSelect={run(() => void navigate({ to: "/settings" }))}>
                <SettingsIcon />设置
              </CommandItem>
            </CommandGroup>

            {projects.length > 1 ? (
              <CommandGroup heading="切换项目">
                {projects
                  .filter((item) => item.id !== project?.id && !item.isArchived)
                  .map((item) => (
                    <CommandItem
                      key={item.id}
                      value={`切换项目 ${item.name}`}
                      onSelect={run(() => {
                        rememberProjectId(item.id);
                        void navigate({ to: "/p/$projectId/requirements", params: { projectId: item.id } });
                      })}
                    >
                      <ProjectMark project={item} size={18} />
                      {item.name}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ) : null}

            <CommandGroup heading="操作">
              {project === null ? null : (
                <CommandItem
                  value="新建项目会话 本机"
                  disabled={launcher.launching}
                  onSelect={run(() => void launcher.launch({ kind: "project", remoteProjectId: project.id }))}
                >
                  <MessageSquarePlusIcon />在本机开始项目会话
                </CommandItem>
              )}
              <CommandItem value="新建项目" onSelect={run(() => requestProjectAction("create"))}>
                <FolderPlusIcon />新建项目
              </CommandItem>
              <CommandItem value="切换到浅色主题 light" onSelect={run(() => applyThemePreference("light"))}>
                <SunIcon />切换到浅色主题
              </CommandItem>
              <CommandItem value="切换到深色主题 dark" onSelect={run(() => applyThemePreference("dark"))}>
                <MoonIcon />切换到深色主题
              </CommandItem>
              <CommandItem value="主题跟随系统 system" onSelect={run(() => applyThemePreference("system"))}>
                <MonitorIcon />主题跟随系统
              </CommandItem>
              <CommandItem value="收起展开侧栏 sidebar" onSelect={run(onToggleSidebar)}>
                <PanelLeftIcon />收起 / 展开侧栏<CommandShortcut>{keyLabel("mod")}\</CommandShortcut>
              </CommandItem>
              <CommandItem value="快捷键一览 shortcuts keyboard" onSelect={run(() => setShortcutsOpen(true))}>
                <KeyboardIcon />快捷键一览<CommandShortcut>?</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
