import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArchiveIcon, CheckIcon, ChevronsUpDownIcon, FolderCogIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { RequirementsProjectDto } from "../../api/client.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { rememberProjectId, useCurrentProject } from "../project-context.js";
import { requestProjectAction } from "./shell-actions.js";

/** 项目的方形标识：取名字首字，底色由名字稳定映射。 */
export function ProjectMark({ project, size = 26 }: { project: RequirementsProjectDto | null; size?: number }) {
  const tones = ["#3451d1", "#0f7a8a", "#8a4fb8", "#b5651d", "#2f6f5e", "#a3485f"];
  let hash = 0;
  for (const char of project?.name ?? "") hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-[7px] font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        backgroundColor: project === null ? "var(--muted-strong)" : tones[hash % tones.length],
      }}
    >
      {project === null ? "·" : Array.from(project.name)[0]}
    </span>
  );
}

/** 当前路径属于哪个项目分区：切换项目时保持在同一分区。 */
export function projectSectionOf(pathname: string): "requirements" | "overview" | "rooms" | null {
  const match = /^\/p\/[^/]+\/(requirements|overview|rooms)/.exec(pathname);
  return match === null ? null : (match[1] as "requirements" | "overview" | "rooms");
}

function sessionsFilterOnly(search: { filter?: string }): { filter?: "running" | "needs-me" | "room-tasks" } {
  const filter = search.filter;
  return filter === "running" || filter === "needs-me" || filter === "room-tasks" ? { filter } : {};
}

export function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { project, projects, isLoading } = useCurrentProject();
  const [open, setOpen] = useState(false);
  const active = projects.filter((item) => !item.isArchived);
  const archived = projects.filter((item) => item.isArchived);

  const select = (next: RequirementsProjectDto) => {
    setOpen(false);
    // 明确选了就记住：当前项目可能只是没记过时默认选中的第一个。
    rememberProjectId(next.id);
    if (next.id === project?.id) return;
    const section = projectSectionOf(pathname);
    if (section === "requirements") {
      void navigate({ to: "/p/$projectId/requirements", params: { projectId: next.id } });
    } else if (section === "overview") {
      void navigate({ to: "/p/$projectId/overview", params: { projectId: next.id } });
    } else if (section === "rooms") {
      void navigate({ to: "/p/$projectId/rooms", params: { projectId: next.id } });
    } else if (pathname.startsWith("/sessions/")) {
      // 会话列表只列当前项目：换了项目就收起打开着的（上一个项目的）会话，筛选保留。
      void navigate({ to: "/sessions", search: (previous: { filter?: string }) => sessionsFilterOnly(previous) });
    }
  };

  /** 新建项目与项目设置都由外壳对话框处理，在任何页面都能直接打开。 */
  const runAction = (action: "create" | "manage") => {
    setOpen(false);
    requestProjectAction(action);
  };

  const label = project === null ? (isLoading ? "正在加载项目" : "还没有项目") : project.name;

  const trigger = (
    <button
      type="button"
      aria-label={`切换项目：${label}`}
      data-testid="project-switcher"
      className={cn(
        "flex h-11 w-full items-center gap-2.5 rounded-sm px-2 text-left text-foreground outline-none transition-colors",
        "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted",
        collapsed && "justify-center px-0",
      )}
    >
      <ProjectMark project={project} />
      {collapsed ? null : (
        <>
          <span className="flex min-w-0 flex-1 flex-col leading-[18px]">
            <span className="truncate text-body font-semibold">{label}</span>
            <span className="text-caption text-subtle-foreground">SuDuo</span>
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-subtle-foreground" />
        </>
      )}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent align="start" className="w-[280px] p-0" side={collapsed ? "right" : "bottom"}>
        <Command>
          <CommandInput placeholder="搜索项目" />
          <CommandList>
            <CommandEmpty>没有匹配的项目</CommandEmpty>
            {active.length === 0 ? null : (
              <CommandGroup heading="项目">
                {active.map((item) => (
                  <CommandItem key={item.id} value={`${item.name} ${item.id}`} onSelect={() => select(item)}>
                    <ProjectMark project={item} size={20} />
                    <span className="flex-1 truncate">{item.name}</span>
                    {item.id === project?.id ? <CheckIcon className="size-4 text-primary-text!" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {archived.length === 0 ? null : (
              <CommandGroup heading={`已归档 · ${archived.length}`}>
                {archived.map((item) => (
                  <CommandItem key={item.id} value={`${item.name} ${item.id}`} onSelect={() => select(item)}>
                    <ArchiveIcon />
                    <span className="flex-1 truncate text-muted-foreground">{item.name}</span>
                    {item.id === project?.id ? <CheckIcon className="size-4 text-primary-text!" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="新建项目" onSelect={() => runAction("create")}>
                <PlusIcon />
                新建项目
              </CommandItem>
              {project === null ? null : (
                <CommandItem value="管理项目" onSelect={() => runAction("manage")}>
                  <FolderCogIcon />
                  管理项目
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
