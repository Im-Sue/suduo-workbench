import type { SystemOpenTarget } from "@suduo/client-contracts";
import { ChevronDownIcon, CodeIcon, FileIcon, FolderIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TARGET_META: {
  mode: SystemOpenTarget;
  label: string;
  testid: string;
  icon: typeof FileIcon;
}[] = [
  { mode: "open", label: "系统默认应用", testid: "open-with-system", icon: FileIcon },
  { mode: "reveal", label: "文件管理器", testid: "reveal-in-folder", icon: FolderIcon },
  { mode: "vscode", label: "VS Code", testid: "open-in-vscode", icon: CodeIcon },
  { mode: "terminal", label: "终端", testid: "open-in-terminal", icon: TerminalIcon },
];

/** 「用…打开」下拉：按本机探测到的可用目标显示；一个都没有时不显示。 */
export function OpenMenu(props: {
  path: string;
  targets: SystemOpenTarget[];
  onOpen(path: string, mode: SystemOpenTarget): void;
  label?: string;
}) {
  const entries = TARGET_META.filter((meta) => props.targets.includes(meta.mode));
  if (entries.length === 0) {
    return null;
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="open-menu">
          {props.label ?? "打开位置"}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {entries.map((meta) => {
          const Icon = meta.icon;
          return (
            <DropdownMenuItem key={meta.mode} data-testid={meta.testid} onSelect={() => props.onOpen(props.path, meta.mode)}>
              <Icon />
              {meta.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
