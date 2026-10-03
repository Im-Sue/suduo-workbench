import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpServerDto } from "@suduo/client-contracts";
import {
  AlertTriangleIcon,
  CircleCheckIcon,
  CircleOffIcon,
  CircleSlashIcon,
  LogInIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "../../../api/client.js";
import { ConfirmDialog, EmptyState, FormDialog, InlineError, RegionError } from "../../../feedback/components/index.js";
import { needsConfirm } from "../../../feedback/confirm-policy.js";
import { reportFailure } from "../../../feedback/report.js";
import type { Failure } from "../../../feedback/types.js";
import { useT } from "../../../i18n/provider.js";
import type { Messages } from "../../../i18n/messages/index.js";
import { showMessage } from "../../../ui/message.js";
import { ItemList, ItemRow, SettingsRow, SettingsSection } from "../components/kit.js";
import { formatMs, TestConnection, timed, type TestOutcome } from "../components/TestConnection.js";
import { buildMcpUpdate, draftFor, parseArgs, splitEnvVars, type McpDraft } from "../mcp-edit.js";
import { mcpServersQuery, reportMcpWrite, settingsKeys, useToggleMcpServer } from "../queries.js";
import { useQueryFailure } from "../use-query-failure.js";

/**
 * 连接状态与登录状态的文字见字典 settingsAgent.mcp（startup / auth）。
 * 列表里拿不到连接信息（unknown）：可能没启动成功，也可能还没启动。不断言失败，但要让人注意到。
 * 失败原因：有官方原文（Codex 状态列表的 toolsError）就显示原文；Codex 没给时如实说没有，不编造原因。
 */
function authLabel(
  text: Messages["settingsAgent"]["mcp"],
  status: McpServerDto["status"]["authenticationStatus"],
): string | null {
  return status === "unsupported" ? null : text.auth[status];
}

function StartupIcon({ server }: { server: McpServerDto }): ReactNode {
  if (!server.enabled) return <CircleOffIcon aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />;
  switch (server.status.startupState) {
    case "ready":
      return <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-success" />;
    case "starting":
      return <Spinner className="shrink-0 text-warning" />;
    case "failed":
      return <XCircleIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />;
    case "cancelled":
      return <CircleSlashIcon aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />;
    default:
      return <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />;
  }
}

/** 启用了但没连上的服务（分组红点与诊断共用）。 */
export function troubledMcpServers(items: readonly McpServerDto[]): McpServerDto[] {
  return items.filter((item) => item.enabled && (item.status.startupState === "failed" || item.status.startupState === "unknown"));
}

/** MCP 服务：给 Codex 接上外部工具。能看出「没配、没登录、还是没连上」，并当场修。 */
export function McpSection() {
  const text = useT().settingsAgent.mcp;
  const queryClient = useQueryClient();
  const servers = useQuery(mcpServersQuery);
  const failure = useQueryFailure(servers);
  const toggle = useToggleMcpServer();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerDto | "new" | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<McpServerDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const reload = () => queryClient.invalidateQueries({ queryKey: settingsKeys.mcp });

  const run = async (name: string, work: () => Promise<void>, title: string) => {
    setBusy(name);
    try {
      await work();
    } catch (cause) {
      reportFailure(cause, { surface: "action", title });
    } finally {
      setBusy(null);
    }
  };

  const test = async (): Promise<TestOutcome> => {
    const { value, ms } = await timed(() => api.refreshMcpServers());
    queryClient.setQueryData(settingsKeys.mcp, value);
    if (!value.statusAvailable) {
      return { ok: false, reason: text.test.statusUnavailable, suggestion: text.test.statusUnavailableSuggestion };
    }
    const enabled = value.items.filter((item) => item.enabled);
    if (enabled.length === 0) return { ok: true, text: value.items.length === 0 ? text.test.noServers : text.test.noneEnabled };
    const troubled = troubledMcpServers(value.items);
    if (troubled.length === 0) return { ok: true, text: text.test.allConnected(enabled.length, formatMs(ms)) };
    return {
      ok: false,
      reason: text.test.troubled(troubled.map((item) => item.name)),
      suggestion: text.test.troubledSuggestion,
    };
  };

  const items = servers.data?.items ?? [];
  return (
    <SettingsSection
      id="mcp"
      description={text.description}
      actions={
        <Button size="sm" variant="primary" type="button" data-testid="mcp-add" onClick={() => setEditing("new")}>
          <PlusIcon />
          {text.addServer}
        </Button>
      }
    >
      <SettingsRow anchor="mcp-test" title={text.test.title} description={text.test.description}>
        <TestConnection run={test} onTestingChange={setTesting} />
      </SettingsRow>

      <SettingsRow anchor="mcp-servers" title={text.list.title} stacked>
        <div className="flex flex-col gap-2" data-testid="mcp-panel" aria-busy={testing || busy !== null}>
          {servers.data?.statusAvailable === false ? (
            <Banner tone="warning" data-testid="mcp-degraded-banner">
              {text.list.statusUnavailable}
            </Banner>
          ) : null}
          {servers.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label={text.list.loading}>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : servers.isError ? (
            <RegionError
              kind={failure?.kind ?? "unknown"}
              message={text.list.loadFailed(failure?.message ?? "")}
              busy={servers.isFetching}
              onRetry={() => void servers.refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              title={text.list.emptyTitle}
              description={text.list.emptyDescription}
              action={{ label: text.addServer, onClick: () => setEditing("new") }}
            />
          ) : (
            <ItemList label={text.list.label} data-testid="mcp-server-list">
              {items.map((server) => {
                const state = server.status.startupState;
                const troubled = server.enabled && (state === "failed" || state === "unknown");
                const auth = authLabel(text, server.status.authenticationStatus);
                return (
                  <ItemRow
                    key={server.name}
                    data-testid="mcp-server-row"
                    data-server-name={server.name}
                    data-startup={state}
                  >
                    <StartupIcon server={server} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-body font-medium text-foreground">{server.name}</span>
                        <Badge variant="outline">{text.transport[server.transport]}</Badge>
                      </span>
                      <span className="truncate text-caption text-subtle-foreground">
                        <span data-testid="mcp-startup-state">{server.enabled ? text.startup[state] : text.disabled}</span>
                        {auth === null ? null : ` · ${auth}`}
                        {state === "ready" ? ` · ${text.toolCount(server.status.toolCount)}` : null}
                      </span>
                    </span>
                    {troubled ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        data-testid="mcp-diagnose"
                        aria-expanded={expanded === server.name}
                        onClick={() => setExpanded((current) => (current === server.name ? null : server.name))}
                      >
                        {text.list.diagnose}
                      </Button>
                    ) : null}
                    {server.status.authenticationStatus === "notLoggedIn" ? (
                      <Button
                        size="sm"
                        type="button"
                        data-testid="mcp-login"
                        loading={busy === server.name}
                        onClick={() =>
                          void run(
                            server.name,
                            async () => {
                              const { authorizationUrl } = await api.loginMcpServer(server.name);
                              window.open(authorizationUrl, "_blank", "noopener");
                              // 内网没有浏览器的机器上，把地址交给用户自己打开。
                              showMessage(text.list.signInUrl(authorizationUrl), "info");
                            },
                            text.list.signInFailed,
                          )
                        }
                      >
                        <LogInIcon />
                        {text.list.signIn}
                      </Button>
                    ) : null}
                    <Switch
                      aria-label={text.list.enable(server.name)}
                      data-testid="mcp-enabled"
                      checked={server.enabled}
                      onCheckedChange={(checked) => toggle.mutate({ name: server.name, enabled: checked })}
                    />
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" type="button" aria-label={text.list.moreActions(server.name)}>
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onSelect={() => setEditing(server)}>
                          <PencilIcon />
                          {text.list.edit}
                        </DropdownMenuItem>
                        {server.status.authenticationStatus === "oAuth" ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              void run(server.name, async () => {
                                await api.logoutMcpServer(server.name);
                                await reload();
                              }, text.list.signOutFailed)
                            }
                          >
                            <LogOutIcon />
                            {text.list.signOut}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="danger"
                          onSelect={() => {
                            if (needsConfirm("delete-mcp-server")) setPendingRemoval(server);
                            else
                              void run(server.name, async () => {
                                await api.removeMcpServer(server.name);
                                await reload();
                              }, text.list.removeFailed);
                          }}
                        >
                          <Trash2Icon />
                          {text.list.remove}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {expanded === server.name ? (
                      <div
                        className="flex basis-full flex-col gap-1 rounded-md bg-muted px-3 py-2 text-small"
                        data-testid="mcp-failure-detail"
                      >
                        <span className={state === "failed" ? "font-medium text-danger" : "font-medium text-warning"}>
                          {text.startup[state]}
                        </span>
                        <span className="text-muted-foreground" data-testid="mcp-failure-reason">
                          {server.status.startupFailureReason ?? text.detail.noReason}
                        </span>
                        {server.transport === "stdio" ? (
                          <span className="font-mono text-caption text-subtle-foreground">
                            {text.detail.command([server.command ?? "", ...server.args].join(" "))}
                          </span>
                        ) : (
                          <span className="font-mono text-caption text-subtle-foreground">{text.detail.url(server.url ?? "")}</span>
                        )}
                        {server.envVars.length > 0 ? (
                          <span className="text-caption text-subtle-foreground">
                            {text.detail.envVars(server.envVars)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </ItemRow>
                );
              })}
            </ItemList>
          )}
        </div>
      </SettingsRow>

      <McpServerDialog
        target={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={async () => {
          setEditing(null);
          await reload();
        }}
      />
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title={text.removeConfirm.title(pendingRemoval?.name ?? "")}
        description={text.removeConfirm.description}
        confirmLabel={text.removeConfirm.confirm}
        onConfirm={() => {
          if (pendingRemoval === null) return;
          const server = pendingRemoval;
          setPendingRemoval(null);
          void run(server.name, async () => {
            await api.removeMcpServer(server.name);
            await reload();
          }, text.list.removeFailed);
        }}
      />
    </SettingsSection>
  );
}

/** 添加 / 编辑 MCP 服务。只收变量名、不收密钥值：Codex 没有代管密钥的官方能力，不在界面里自建。 */
function McpServerDialog({
  target,
  onOpenChange,
  onSaved,
}: {
  target: McpServerDto | "new" | null;
  onOpenChange(open: boolean): void;
  onSaved(): Promise<void>;
}) {
  const t = useT();
  const text = t.settingsAgent.mcp.form;
  const transportLabel = t.settingsAgent.mcp.transport;
  const [draft, setDraft] = useState<McpDraft>(() => draftFor(target));
  const [openedFor, setOpenedFor] = useState(target);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  if (openedFor !== target) {
    setOpenedFor(target);
    setDraft(draftFor(target));
    setAttempted(false);
    setFailure(null);
  }
  const creating = target === "new";
  const initial = draftFor(target);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const set = (field: keyof McpDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }));

  const errors: Partial<Record<keyof McpDraft, string>> = {};
  if (creating && draft.name.trim() === "") errors.name = text.nameRequired;
  else if (creating && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(draft.name.trim())) errors.name = text.nameInvalid;
  if (draft.transport === "stdio" && draft.command.trim() === "") errors.command = text.commandRequired;
  if (draft.transport === "http") {
    try {
      const url = new URL(draft.url.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") errors.url = text.urlProtocol;
    } catch {
      errors.url = text.urlInvalid;
    }
  }
  if (draft.transport === "stdio") {
    const parsed = parseArgs(draft.args);
    if (!parsed.ok) errors.args = parsed.message;
  }
  const shown = attempted ? errors : {};
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0) {
      // 焦点落到第一个出错的字段（错误提示已经通过 aria-describedby 关联）。
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    let request: () => ReturnType<typeof api.updateMcpServer>;
    if (target === "new" || target === null) {
      const parsed = parseArgs(draft.args);
      const transport =
        draft.transport === "stdio"
          ? { type: "stdio" as const, command: draft.command.trim(), args: parsed.ok ? parsed.args : [], envVars: splitEnvVars(draft.envVars) }
          : { type: "http" as const, url: draft.url.trim(), bearerTokenEnvVar: draft.bearerEnv.trim() === "" ? null : draft.bearerEnv.trim() };
      request = () => api.createMcpServer({ name: draft.name.trim(), transport });
    } else {
      const update = buildMcpUpdate(target, draft);
      if (!update.ok) return;
      // 什么都没改：直接关掉，不发请求（也不会把原配置按界面文本重写一遍）。
      if (update.body === null) {
        onOpenChange(false);
        return;
      }
      const body = update.body;
      request = () => api.updateMcpServer(target.name, body);
    }
    setSaving(true);
    setFailure(null);
    try {
      const result = await request();
      reportMcpWrite(result);
      await onSaved();
    } catch (cause) {
      const reported = reportFailure(cause, { surface: "field" });
      if (reported.route.outlet === "field") setFailure(reported.failure);
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={target !== null}
      onOpenChange={onOpenChange}
      title={creating ? text.addTitle : text.editTitle(typeof target === "object" && target !== null ? target.name : "")}
      description={text.description}
      hasUnsavedChanges={dirty}
    >
      <form
        ref={formRef}
        className="flex flex-col gap-4"
        data-testid="mcp-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span id="mcp-transport-label" className="text-small font-medium text-foreground">
            {text.transport}
          </span>
          <SegmentedControl
            aria-labelledby="mcp-transport-label"
            value={draft.transport}
            options={[
              { value: "stdio", label: transportLabel.stdio },
              { value: "http", label: transportLabel.http },
            ]}
            onValueChange={(value) => set("transport", value)}
          />
          {!creating && typeof target === "object" && target !== null && target.transport !== draft.transport ? (
            <p className="m-0 text-caption text-warning">{text.transportChange}</p>
          ) : null}
        </div>

        {creating ? (
          <Field label={text.name} required error={shown.name} hint={text.nameHint}>
            <Input data-testid="mcp-name" value={draft.name} onChange={(event) => set("name", event.target.value)} />
          </Field>
        ) : null}

        {draft.transport === "stdio" ? (
          <>
            <Field label={text.command} required error={shown.command}>
              <Input
                data-testid="mcp-command"
                className="font-mono"
                placeholder="/opt/db-mcp/server"
                value={draft.command}
                onChange={(event) => set("command", event.target.value)}
              />
            </Field>
            <Field label={text.args} hint={text.argsHint} error={shown.args}>
              <Input data-testid="mcp-args" className="font-mono" value={draft.args} onChange={(event) => set("args", event.target.value)} />
            </Field>
            <Field label={text.envVars} hint={text.envVarsHint}>
              <Input
                data-testid="mcp-env-vars"
                className="font-mono"
                placeholder="DB_TOKEN"
                value={draft.envVars}
                onChange={(event) => set("envVars", event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={text.url} required error={shown.url}>
              <Input
                data-testid="mcp-url"
                className="font-mono"
                placeholder="https://mcp.example.com/sse"
                value={draft.url}
                onChange={(event) => set("url", event.target.value)}
              />
            </Field>
            <Field label={text.bearerEnv} hint={text.bearerEnvHint}>
              <Input className="font-mono" value={draft.bearerEnv} onChange={(event) => set("bearerEnv", event.target.value)} />
            </Field>
          </>
        )}

        <p className="m-0 rounded-md bg-warning-soft px-3 py-2 text-small text-foreground">
          {text.secretsNote}
        </p>

        {failure === null ? null : <InlineError kind={failure.kind}>{failure.message}</InlineError>}

        <div className="flex justify-end gap-2">
          <Button type="button" disabled={saving} onClick={() => onOpenChange(false)}>
            {text.cancel}
          </Button>
          <Button type="submit" variant="primary" loading={saving} data-testid="mcp-create-submit">
            {creating ? text.add : text.save}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
