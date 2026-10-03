import { LOCALES } from "@suduo/client-contracts";
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
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { useT } from "../../i18n/provider.js";
import { rememberProjectId, useCurrentProject } from "../project-context.js";
import { ProjectMark } from "./ProjectSwitcher.js";
import { requirementCode } from "../../features/requirements/format.js";
import { requirementKeys } from "../../features/requirements/keys.js";
import { useSessionLauncher } from "./SessionLauncher.js";
import { keyLabel } from "../shortcuts.js";
import { requestProjectAction, setCommandPaletteOpen, setShortcutsOpen, useCommandPaletteOpen } from "./shell-actions.js";

/**
 * 命令的搜索文本：所有语言的显示名与搜索词拼在一起，中文、英文都能搜到同一条命令；
 * 显示仍用当前语言（中英双语技术设计 §4.3）。
 */
function searchText(pick: (messages: Messages) => string): string {
  return LOCALES.map((locale) => pick(messagesFor(locale)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

type NavCommand = "myWork" | "requirements" | "rooms" | "sessions" | "overview" | "settings";
type ActionCommand = keyof Messages["shell"]["commandPalette"]["actions"];

const navSearch = (key: NavCommand) =>
  searchText((m) => `${m.shell.nav[key]} ${m.shell.commandPalette.keywords[key]}`);
const actionSearch = (key: ActionCommand) =>
  searchText((m) => `${m.shell.commandPalette.actions[key]} ${m.shell.commandPalette.keywords[key]}`);

/** ⌘K 命令面板：跳转、搜需求（按标题）、切项目、常用动作。 */
export function CommandPalette({ onToggleSidebar }: { onToggleSidebar(): void }) {
  const open = useCommandPaletteOpen();
  const t = useT();
  const nav = t.shell.nav;
  const text = t.shell.commandPalette;
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
        <DialogTitle className="sr-only">{text.title}</DialogTitle>
        <Command loop>
          <CommandInput value={query} onValueChange={setQuery} placeholder={text.placeholder} />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>
              {search.isFetching ? (
                <span className="inline-flex items-center gap-2"><Spinner />{text.searching}</span>
              ) : (
                text.noMatch
              )}
            </CommandEmpty>

            {project !== null && deferred.length > 0 && (search.data?.items.length ?? 0) > 0 ? (
              <CommandGroup heading={text.requirementsIn(project.name)}>
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

            <CommandGroup heading={text.groups.goTo}>
              <CommandItem value={navSearch("myWork")} onSelect={run(() => void navigate({ to: "/my" }))}>
                <InboxIcon />{nav.myWork}
              </CommandItem>
              {project === null ? null : (
                <CommandItem
                  value={navSearch("requirements")}
                  onSelect={run(() => void navigate({ to: "/p/$projectId/requirements", params: { projectId: project.id } }))}
                >
                  <KanbanSquareIcon />{nav.requirements}
                </CommandItem>
              )}
              {project === null ? null : (
                <CommandItem
                  value={navSearch("rooms")}
                  onSelect={run(() => void navigate({ to: "/p/$projectId/rooms", params: { projectId: project.id } }))}
                >
                  <MessageCircleIcon />{nav.rooms}
                </CommandItem>
              )}
              <CommandItem value={navSearch("sessions")} onSelect={run(() => void navigate({ to: "/sessions" }))}>
                <MessagesSquareIcon />{nav.sessions}
              </CommandItem>
              {project === null ? null : (
                <CommandItem
                  value={navSearch("overview")}
                  onSelect={run(() => void navigate({ to: "/p/$projectId/overview", params: { projectId: project.id } }))}
                >
                  <ChartColumnIcon />{nav.overview}
                </CommandItem>
              )}
              <CommandItem value={navSearch("settings")} onSelect={run(() => void navigate({ to: "/settings" }))}>
                <SettingsIcon />{nav.settings}
              </CommandItem>
            </CommandGroup>

            {projects.length > 1 ? (
              <CommandGroup heading={text.groups.switchProject}>
                {projects
                  .filter((item) => item.id !== project?.id && !item.isArchived)
                  .map((item) => (
                    <CommandItem
                      key={item.id}
                      value={`${searchText((m) => m.shell.commandPalette.groups.switchProject)} ${item.name}`}
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

            <CommandGroup heading={text.groups.actions}>
              {project === null ? null : (
                <CommandItem
                  value={actionSearch("startProjectSession")}
                  disabled={launcher.launching}
                  onSelect={run(() => void launcher.launch({ kind: "project", remoteProjectId: project.id }))}
                >
                  <MessageSquarePlusIcon />{text.actions.startProjectSession}
                </CommandItem>
              )}
              <CommandItem value={actionSearch("newProject")} onSelect={run(() => requestProjectAction("create"))}>
                <FolderPlusIcon />{text.actions.newProject}
              </CommandItem>
              <CommandItem value={actionSearch("lightTheme")} onSelect={run(() => applyThemePreference("light"))}>
                <SunIcon />{text.actions.lightTheme}
              </CommandItem>
              <CommandItem value={actionSearch("darkTheme")} onSelect={run(() => applyThemePreference("dark"))}>
                <MoonIcon />{text.actions.darkTheme}
              </CommandItem>
              <CommandItem value={actionSearch("systemTheme")} onSelect={run(() => applyThemePreference("system"))}>
                <MonitorIcon />{text.actions.systemTheme}
              </CommandItem>
              <CommandItem value={actionSearch("toggleSidebar")} onSelect={run(onToggleSidebar)}>
                <PanelLeftIcon />{text.actions.toggleSidebar}<CommandShortcut>{keyLabel("mod")}\</CommandShortcut>
              </CommandItem>
              <CommandItem value={actionSearch("shortcuts")} onSelect={run(() => setShortcutsOpen(true))}>
                <KeyboardIcon />{text.actions.shortcuts}<CommandShortcut>?</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
