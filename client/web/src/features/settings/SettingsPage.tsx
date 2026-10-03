import { useQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate, useRouterState } from "@tanstack/react-router";
import { SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { settingsQuery } from "../../app/queries.js";
import { useT } from "../../i18n/provider.js";
import { configWarningOf, useCodexStatus } from "./codex-status.js";
import { SettingsFrameContext, type SettingsFrameValue } from "./components/frame.js";
import { useNotifyState } from "./notify-preference.js";
import { codexModelsQuery, mcpServersQuery, modelProviderQuery, workspaceMappingsQuery } from "./queries.js";
import {
  rememberSection,
  searchSettings,
  sectionMeta,
  settingAnchorId,
  settingsSections,
  type SettingsSectionId,
} from "./sections.js";
import { AboutSection } from "./sections/AboutSection.js";
import { AccountSection } from "./sections/AccountSection.js";
import { AppearanceSection } from "./sections/AppearanceSection.js";
import { DiagnosticsSection } from "./sections/DiagnosticsSection.js";
import { ExecutionSection } from "./sections/ExecutionSection.js";
import { McpSection, troubledMcpServers } from "./sections/McpSection.js";
import { ModelSection } from "./sections/ModelSection.js";
import { NotificationsSection } from "./sections/NotificationsSection.js";
import { ProxySection } from "./sections/ProxySection.js";
import { ServiceSection } from "./sections/ServiceSection.js";
import { SkillsSection } from "./sections/SkillsSection.js";
import { WorkspaceSection } from "./sections/WorkspaceSection.js";

/**
 * 设置页（需求 §4.7，技术设计 §4.2 SettingsLayout）：左侧分组导航（图标、异常红点、搜索）｜ 内容（最宽 760）。
 * 分组即路由 `/settings/$section`；搜索结果带行锚点（`#theme`），跳过去后高亮那一行。
 * 表单分组有未保存的更改时，离开分组或页面前提醒（放弃 / 继续编辑）；关闭标签页时交给浏览器提醒。
 */
export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const t = useT();
  const text = t.settings.unsaved;
  const [host, setHost] = useState<HTMLElement | null>(null);
  const dirty = useRef(new Map<string, string>());
  const [, setDirtyVersion] = useState(0);
  const markDirty = useCallback((id: string, title: string | null) => {
    const map = dirty.current;
    if ((map.get(id) ?? null) === title) return;
    if (title === null) map.delete(id);
    else map.set(id, title);
    setDirtyVersion((version) => version + 1);
  }, []);
  const frame = useMemo<SettingsFrameValue>(() => ({ saveBarHost: host, markDirty }), [host, markDirty]);

  const blocker = useBlocker({
    // 登录失效或换了需求服务时由外壳带去登录页，这一跳不能被拦下。
    shouldBlockFn: ({ current, next }) =>
      dirty.current.size > 0 && current.pathname !== next.pathname && next.pathname !== "/login",
    enableBeforeUnload: () => dirty.current.size > 0,
    withResolver: true,
  });

  useEffect(() => rememberSection(section), [section]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hash = useRouterState({ select: (state) => state.location.hash });
  useEffect(() => {
    if (hash === "") {
      scrollRef.current?.scrollTo?.({ top: 0 });
      return;
    }
    return flashRow(hash);
  }, [hash, section]);

  const dirtyTitles = [...dirty.current.values()];
  return (
    <SettingsFrameContext.Provider value={frame}>
      <div className="flex min-h-0 min-w-0 flex-1" data-testid="settings-page">
        <SettingsNav section={section} />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div key={section} className="@container max-w-[760px] px-10 pt-7 pb-32 animate-in fade-in-0">
              <SectionView section={section} />
            </div>
          </div>
          <div ref={setHost} className="pointer-events-none absolute right-10 bottom-5 left-10 max-w-[680px]" />
        </div>
      </div>

      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <DialogContent
          size="sm"
          showCloseButton={false}
          data-testid="settings-unsaved-dialog"
          onCloseAutoFocus={(event) => {
            // 继续编辑：焦点落在保存条的「保存」上，改完直接保存。
            const save = host?.querySelector<HTMLButtonElement>('[data-testid="settings-save"]');
            if (save !== null && save !== undefined) {
              event.preventDefault();
              save.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
            <DialogDescription>{text.description(dirtyTitles)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" autoFocus onClick={() => blocker.reset?.()}>
              {text.keepEditing}
            </Button>
            <Button type="button" variant="danger" onClick={() => blocker.proceed?.()}>
              {text.discard}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsFrameContext.Provider>
  );
}

function SectionView({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case "appearance":
      return <AppearanceSection />;
    case "notifications":
      return <NotificationsSection />;
    case "account":
      return <AccountSection />;
    case "service":
      return <ServiceSection />;
    case "workspace":
      return <WorkspaceSection />;
    case "model":
      return <ModelSection />;
    case "execution":
      return <ExecutionSection />;
    case "skills":
      return <SkillsSection />;
    case "mcp":
      return <McpSection />;
    case "proxy":
      return <ProxySection />;
    case "diagnostics":
      return <DiagnosticsSection />;
    case "about":
      return <AboutSection />;
  }
}

/** 搜索结果跳转后滚到那一行并高亮一下；分组内容可能还在加载，稍等它出现。 */
function flashRow(anchor: string): () => void {
  let tries = 0;
  let timer = 0;
  let cleanup = 0;
  const attempt = () => {
    const row = document.getElementById(settingAnchorId(anchor));
    if (row === null) {
      if (tries++ < 30) timer = window.setTimeout(attempt, 100);
      return;
    }
    row.scrollIntoView?.({ block: "center" });
    row.dataset["flash"] = "false";
    void row.offsetWidth;
    row.dataset["flash"] = "true";
    const focusable = row.querySelector<HTMLElement>("input, button, [role=radio], [role=switch], textarea");
    focusable?.focus({ preventScroll: true });
    cleanup = window.setTimeout(() => {
      row.dataset["flash"] = "false";
    }, 2_000);
  };
  attempt();
  return () => {
    window.clearTimeout(timer);
    window.clearTimeout(cleanup);
  };
}

type Alert = "danger" | "warning";

/**
 * 分组导航上的异常红点：和各分组共用同一份查询缓存（进分组零等待）。
 * 打开设置页任意分组都会读这几项（模型配置与清单、代码目录复验、MCP 列表）；都是只读请求，缓存期内不重复发。
 */
function useSectionAlerts(): Partial<Record<SettingsSectionId, Alert>> {
  const settings = useQuery(settingsQuery).data;
  const mappings = useQuery(workspaceMappingsQuery);
  const provider = useQuery(modelProviderQuery);
  const models = useQuery(codexModelsQuery);
  const mcp = useQuery(mcpServersQuery);
  const warning = configWarningOf(useCodexStatus());
  const notify = useNotifyState();

  const alerts: Partial<Record<SettingsSectionId, Alert>> = {};
  if (settings !== undefined && !settings.configured) alerts.service = "danger";
  if (mappings.data?.some((item) => item.verification !== undefined && !item.verification.available) === true) {
    alerts.workspace = "danger";
  }
  if (
    provider.isError ||
    (provider.data !== undefined && (provider.data.baseUrl === "" || provider.data.apiKeyMasked === null)) ||
    models.isError
  ) {
    alerts.model = "danger";
  } else if (warning !== null) {
    alerts.model = "warning";
  }
  const troubled = troubledMcpServers(mcp.data?.items ?? []);
  if (troubled.length > 0) {
    alerts.mcp = troubled.some((item) => item.status.startupState === "failed") ? "danger" : "warning";
  }
  if (notify.enabled && notify.permission === "denied") alerts.notifications = "warning";
  return alerts;
}

function SettingsNav({ section }: { section: SettingsSectionId }) {
  const t = useT();
  const text = t.settings.nav;
  const navigate = useNavigate();
  const alerts = useSectionAlerts();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchSettings(query, t), [query, t]);
  const searching = query.trim() !== "";

  // 「/」聚焦设置搜索（输入时不抢）。
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"][data-state="open"]') !== null) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** ↑↓ / Home / End 在分组（或搜索结果）之间移动焦点。 */
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-settings-nav]") ?? [])];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(links.length - 1, index + 1);
    if (event.key === "ArrowUp") next = index <= 0 ? (searching ? -1 : 0) : index - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = links.length - 1;
    if (next === null) return;
    event.preventDefault();
    if (next < 0) searchRef.current?.focus();
    else links[next]?.focus();
  };

  let band = "";
  return (
    <nav
      aria-label={text.label}
      className="flex w-[232px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border px-2.5 py-3.5"
    >
      <h1 className="m-0 mb-2.5 ml-2 text-section font-semibold text-foreground">{text.title}</h1>
      <div className="relative mb-2.5 flex items-center">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 size-3.5 text-subtle-foreground" />
        <input
          ref={searchRef}
          type="search"
          aria-label={text.searchLabel}
          placeholder={text.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              setQuery("");
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              listRef.current?.querySelector<HTMLAnchorElement>("a[data-settings-nav]")?.focus();
            }
            if (event.key === "Enter" && results[0] !== undefined) {
              event.preventDefault();
              const first = results[0];
              void navigate({ to: "/settings/$section", params: { section: first.section }, hash: first.anchor });
            }
          }}
          className={cn(
            "h-[30px] w-full min-w-0 rounded-sm border border-input bg-card pr-7 pl-8 text-small text-foreground outline-none",
            "placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft",
            "[&::-webkit-search-cancel-button]:hidden",
          )}
        />
        {query === "" ? (
          <Kbd className="pointer-events-none absolute right-2">/</Kbd>
        ) : (
          <button
            type="button"
            aria-label={text.clearSearch}
            className="absolute right-1.5 inline-flex size-5 items-center justify-center rounded-xs text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      <div ref={listRef} className="flex flex-col gap-0.5" onKeyDown={onListKeyDown}>
        {searching ? (
          results.length === 0 ? (
            <p className="m-0 px-2.5 py-2 text-small text-subtle-foreground" role="status">
              {text.noResults}
            </p>
          ) : (
            <>
              <p className="m-0 px-2.5 pt-1 pb-1 text-caption text-subtle-foreground" role="status">
                {text.resultCount(results.length)}
              </p>
              {results.map((item) => {
                const meta = sectionMeta(item.section, t);
                const Icon = meta.icon;
                return (
                  <Link
                    key={`${item.section}-${item.anchor}`}
                    to="/settings/$section"
                    params={{ section: item.section }}
                    hash={item.anchor}
                    data-settings-nav=""
                    className={navItemClass(false)}
                  >
                    <Icon aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col py-1 leading-4">
                      <span className="truncate text-foreground" title={item.title}>{item.title}</span>
                      <span className="truncate text-caption font-normal text-subtle-foreground">{meta.title}</span>
                    </span>
                  </Link>
                );
              })}
            </>
          )
        ) : (
          settingsSections(t).map((item) => {
            const Icon = item.icon;
            const showBand = item.band !== band;
            band = item.band;
            const alert = alerts[item.id];
            const active = item.id === section;
            return (
              <div key={item.id} className="flex flex-col">
                {showBand ? <span className="px-2.5 pt-3 pb-1 text-caption text-subtle-foreground first:pt-1">{t.settings.bands[item.band]}</span> : null}
                <Link
                  to="/settings/$section"
                  params={{ section: item.id }}
                  aria-current={active ? "page" : undefined}
                  data-settings-nav=""
                  data-testid={`settings-nav-${item.id}`}
                  className={navItemClass(active)}
                >
                  <Icon aria-hidden="true" />
                  <span className="flex-1 truncate">{item.title}</span>
                  {alert === undefined ? null : (
                    <>
                      <span
                        aria-hidden="true"
                        data-alert={alert}
                        className={cn("size-1.5 shrink-0 rounded-full", alert === "danger" ? "bg-danger" : "bg-warning")}
                      />
                      <span className="sr-only">{text.alertNote(alert === "danger" ? t.settings.status.fail : t.settings.status.warn)}</span>
                    </>
                  )}
                </Link>
              </div>
            );
          })
        )}
      </div>
    </nav>
  );
}

function navItemClass(active: boolean): string {
  return cn(
    "flex min-h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-small no-underline outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4 [&>svg]:shrink-0",
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
}
