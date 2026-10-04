import type { SystemOpenTarget } from "@suduo/client-contracts";
import { FileDiffIcon, PanelRightCloseIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { WorkspaceChange } from "../api/client.js";
import { DiffStat } from "../features/sessions/stream/TurnView.js";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EnvPanel } from "./EnvPanel.js";
import { useT } from "../i18n/provider.js";

/**
 * 会话检查面板（需求 §4.5）：改动 / 需求 / 环境 / 文件 四个标签。
 * - 改动：相对会话开始前新建、修改、删除的文件，点开看 diff；
 * - 需求：关联需求的开工基线、附件与评论（由调用方传入）；
 * - 环境：目录、分支、检查点时间线与恢复；
 * - 文件：项目文件树，点开预览。
 */
export type SidePanelTab = "changes" | "requirement" | "env" | "files";

const GROUPS = ["created", "modified", "deleted"] as const;

export function ChangesPanel(props: {
  fileTree?: ReactNode;
  requirementPanel?: ReactNode;
  tab?: SidePanelTab;
  onTabChange?(tab: SidePanelTab): void;
  changes: WorkspaceChange[];
  additions: number;
  deletions: number;
  projectId: string;
  projectRoot: string;
  running: boolean;
  openTargets: SystemOpenTarget[];
  onOpen(path: string): void;
  onCollapse(): void;
  onSystemOpen(path: string, mode: SystemOpenTarget): void;
  onError(message: string): void;
}) {
  const t = useT();
  const [innerTab, setInnerTab] = useState<SidePanelTab>("changes");
  const tab = props.tab ?? innerTab;
  const setTab = (next: SidePanelTab) => {
    setInnerTab(next);
    props.onTabChange?.(next);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label={t.workbench.inspector.label}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as SidePanelTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
          {/*
            面板最窄 320px：英文四个标签放不下默认间距。标签之间用可收缩的间隔代替固定 gap（宽度够时仍是 20px），
            间隔收到最小后，只让「需求」「环境」两个长标签截断，短标签与收起按钮始终完整。
          */}
          <TabsList className="h-full min-w-0 gap-0 border-0">
            <TabsTrigger value="changes" data-testid="side-tab-changes" className="shrink-0">
              {t.workbench.inspector.tabs.changes}{props.changes.length > 0 ? <span className="ml-1 text-subtle-foreground">{props.changes.length}</span> : null}
            </TabsTrigger>
            {props.requirementPanel === undefined ? null : (
              <>
                <TabGap />
                <TabsTrigger value="requirement" data-testid="side-tab-requirement" className="min-w-0">
                  <span className="truncate">{t.workbench.inspector.tabs.requirement}</span>
                </TabsTrigger>
              </>
            )}
            <TabGap />
            <TabsTrigger value="env" data-testid="side-tab-env" className="min-w-0">
              <span className="truncate">{t.workbench.inspector.tabs.env}</span>
            </TabsTrigger>
            {props.fileTree === undefined ? null : (
              <>
                <TabGap />
                <TabsTrigger value="files" data-testid="side-tab-files" className="shrink-0">{t.workbench.inspector.tabs.files}</TabsTrigger>
              </>
            )}
          </TabsList>
          <div className="flex-1" />
          <Button size="icon-sm" variant="ghost" aria-label={t.workbench.inspector.collapse} title={t.workbench.inspector.collapseTitle} onClick={props.onCollapse}>
            <PanelRightCloseIcon />
          </Button>
        </div>
        {/* 只渲染当前标签的面板；面板与标签按钮互相关联（aria-controls / aria-labelledby）。 */}
        <TabsContent value={tab} className="mt-0 min-h-0 flex-1 overflow-y-auto">
          {tab === "requirement" && props.requirementPanel !== undefined ? (
            <div className="p-4">{props.requirementPanel}</div>
          ) : tab === "files" && props.fileTree !== undefined ? (
            <div className="p-1.5" data-testid="side-file-tree">{props.fileTree}</div>
          ) : tab === "env" ? (
            <div className="p-4">
              <EnvPanel
                projectId={props.projectId}
                projectRoot={props.projectRoot}
                additions={props.additions}
                deletions={props.deletions}
                changedFiles={props.changes.length}
                refreshKey={`${String(props.changes.length)}|${String(props.additions)}|${props.running ? "r" : "i"}`}
                running={props.running}
                openTargets={props.openTargets}
                onSystemOpen={props.onSystemOpen}
                onError={props.onError}
              />
            </div>
          ) : (
            <ChangeList changes={props.changes} additions={props.additions} deletions={props.deletions} onOpen={props.onOpen} />
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/** 标签之间的间隔：默认 20px（原 gap-5），空间不够时几乎由它独自收缩，最小 4px。 */
function TabGap() {
  return <span aria-hidden="true" className="w-5 min-w-1 [flex-shrink:100000]" />;
}

function ChangeList({
  changes,
  additions,
  deletions,
  onOpen,
}: {
  changes: WorkspaceChange[];
  additions: number;
  deletions: number;
  onOpen(path: string): void;
}) {
  const t = useT();
  const text = t.workbench.changes;
  if (changes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <FileDiffIcon className="size-5 text-subtle-foreground" aria-hidden="true" />
        <p className="m-0 text-small text-muted-foreground">{text.emptyTitle}</p>
        <p className="m-0 text-caption text-subtle-foreground">{text.emptyDescription}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="change-list">
      <div className="flex items-center gap-2 px-1 text-small">
        <span className="font-medium text-foreground">{text.summary(changes.length)}</span>
        <DiffStat additions={additions} deletions={deletions} />
      </div>
      {GROUPS.map((kind) => {
        const items = changes.filter((change) => change.kind === kind);
        if (items.length === 0) return null;
        return (
          <section key={kind} className="flex flex-col gap-0.5">
            <h3 className="m-0 px-1 text-caption font-medium text-subtle-foreground">
              {text.kind[kind]} {items.length}
            </h3>
            <ul className="m-0 flex list-none flex-col p-0">
              {items.map((change) => (
                <li key={change.path}>
                  <button
                    type="button"
                    className="flex h-8 w-full items-center gap-2 rounded-sm px-1.5 text-left text-small outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="change-item"
                    title={change.path}
                    onClick={() => onOpen(change.path)}
                  >
                    <span className="w-8 shrink-0 text-caption text-subtle-foreground">{text.tag[kind]}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-foreground" dir="rtl">
                      <bdi>{change.path}</bdi>
                    </span>
                    <DiffStat additions={change.additions} deletions={change.deletions} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
