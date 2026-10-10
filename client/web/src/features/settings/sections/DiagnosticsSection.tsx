import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, ChevronDownIcon, CircleCheckIcon, CircleHelpIcon, CopyIcon, RotateCwIcon, XCircleIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { RequirementsWorkspaceMappingDto } from "../../../api/client.js";
import { projectsQuery, queryKeys, settingsQuery } from "../../../app/queries.js";
import { classifyFailure } from "../../../feedback/classify.js";
import { useT } from "../../../i18n/provider.js";
import { showMessage } from "../../../ui/message.js";
import { configWarningOf, useCodexStatus } from "../codex-status.js";
import { ItemList, ItemRow, SettingsRow, SettingsSection } from "../components/kit.js";
import {
  agentHealthItems,
  doctorHealth,
  loginHealth,
  mcpHealth,
  modelHealth,
  networkHealth,
  serviceHealth,
  workspaceHealth,
  type HealthItem,
  type HealthStatus,
  type Probe,
} from "../health.js";
import {
  codexModelsQuery,
  doctorQuery,
  localSettingsQuery,
  mcpServersQuery,
  modelProviderQuery,
  networkHealthQuery,
  serviceHealthQuery,
  settingsKeys,
  workspaceMappingsQuery,
} from "../queries.js";
import { appVersion } from "../version.js";

const STATUS_ICON: Record<HealthStatus, ReactNode> = {
  ok: <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-success" />,
  warn: <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />,
  fail: <XCircleIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />,
  checking: <Spinner className="shrink-0 text-subtle-foreground" />,
  unknown: <CircleHelpIcon aria-hidden="true" className="size-4 shrink-0 text-subtle-foreground" />,
};

function probe<T>(query: { data: T | undefined; error: unknown; isPending: boolean }): Probe<T> {
  return { data: query.data, error: query.error, pending: query.isPending };
}

/** 诊断：一页看清哪一环有问题、怎么修；可以复制诊断信息发给同事或管理员。 */
export function DiagnosticsSection() {
  const t = useT();
  const text = t.settings.diagnostics;
  const statusText = t.settings.status;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const settings = useQuery(settingsQuery).data;
  const baseUrl = settings?.baseUrl ?? "";
  const service = useQuery({ ...serviceHealthQuery(baseUrl), enabled: baseUrl !== "" });
  const doctor = useQuery(doctorQuery);
  const provider = useQuery(modelProviderQuery);
  const models = useQuery(codexModelsQuery);
  const network = useQuery(networkHealthQuery);
  const mcp = useQuery(mcpServersQuery);
  const mappings = useQuery(workspaceMappingsQuery);
  const projects = useQuery(projectsQuery);
  const local = useQuery(localSettingsQuery);
  const codexStatus = useCodexStatus();
  const warning = configWarningOf(codexStatus);

  const projectName = useCallback(
    (mapping: RequirementsWorkspaceMappingDto) =>
      projects.data?.find((project) => project.id === mapping.remoteProjectId)?.name ?? mapping.localProjectName,
    [projects.data],
  );

  const items: HealthItem[] = [
    serviceHealth(settings, baseUrl === "" ? { pending: false } : probe(service), t),
    loginHealth(settings, t),
    doctorHealth(probe(doctor), "codex", t),
    ...agentHealthItems(probe(doctor), t),
    modelHealth(probe(provider), probe(models), warning, t),
    networkHealth(probe(network), t),
    mcpHealth(probe(mcp), t),
    workspaceHealth(probe(mappings), projectName, t),
    doctorHealth(probe(doctor), "runtime", t),
  ];
  const checking = items.some((item) => item.status === "checking");
  const fetching = [service, doctor, provider, models, network, mcp, mappings].some((query) => query.isFetching);

  const recheck = () => {
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    void queryClient.invalidateQueries({ queryKey: settingsKeys.doctor });
    // 「登录」一项读的是需求服务设置（含登录态），一起重读。
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  };

  const copy = async () => {
    // 诊断信息是发给人看的：键名与说明都按界面语言。
    const key = text.report;
    const report = {
      [key.generatedAt]: new Date().toISOString(),
      [key.appVersion]: appVersion(t),
      [key.browser]: navigator.userAgent,
      [key.conclusions]: items.map((item) => ({ [key.item]: item.title, [key.status]: statusText[item.status], [key.detail]: item.detail })),
      [key.service]: { [key.address]: settings?.baseUrl ?? null, [key.signedInAs]: settings?.session?.user.loginName ?? null, [key.connection]: service.isSuccess ? key.connectionOk : service.isError ? classifyFailure(service.error).message : key.notChecked },
      [key.localSettings]: local.data ?? (local.error === null ? null : classifyFailure(local.error).message),
      [key.approvalLockNote]: local.data?.approvalModeLocked === true ? key.approvalLocked : null,
      [key.globalSkillsLockNote]: local.data?.globalSkillsLocked === true ? key.globalSkillsLocked : null,
      [key.modelService]: provider.data ?? (provider.error === null ? null : classifyFailure(provider.error).message),
      [key.modelList]: models.data?.models ?? (models.error === null ? null : classifyFailure(models.error).message),
      [key.network]: network.data ?? (network.error === null ? null : classifyFailure(network.error).message),
      [key.codexNotices]: codexStatus.entries,
      [key.mcpServers]:
        mcp.data?.items.map((item) => ({
          [key.mcp.name]: item.name,
          [key.mcp.transport]: item.transport,
          [key.mcp.enabled]: item.enabled,
          [key.mcp.connection]: item.status.startupState,
          [key.mcp.login]: item.status.authenticationStatus,
          [key.mcp.toolCount]: item.status.toolCount,
          [key.mcp.reason]: item.status.startupFailureReason,
        })) ?? null,
      [key.workspaces]:
        mappings.data?.map((item) => ({ [key.workspace.project]: projectName(item), [key.workspace.path]: item.rootPath, [key.workspace.available]: item.verification?.available ?? null, [key.workspace.detail]: item.verification?.message ?? null })) ??
        null,
      [key.selfCheck]: doctor.data ?? (doctor.error === null ? null : classifyFailure(doctor.error).message),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      showMessage(text.copied, "success");
    } catch {
      showMessage(text.copyFailed, "warning");
    }
  };

  const problems = doctor.data?.checks.filter((check) => check.status !== "pass") ?? [];

  return (
    <SettingsSection
      id="diagnostics"
      description={text.description}
      actions={
        <>
          <Button size="sm" type="button" data-testid="settings-copy-doctor" onClick={() => void copy()}>
            <CopyIcon />
            {text.copy}
          </Button>
          <Button size="sm" variant="primary" type="button" loading={fetching && !checking} disabled={checking} data-testid="settings-run-doctor" onClick={recheck}>
            <RotateCwIcon />
            {text.recheck}
          </Button>
        </>
      }
    >
      <SettingsRow anchor="health" title={text.healthTitle} stacked>
        <ItemList label={text.healthTitle} data-testid="settings-health-list" aria-busy={checking}>
          {items.map((item) => (
            <ItemRow key={item.key} data-testid="health-item" data-key={item.key} data-status={item.status}>
              {STATUS_ICON[item.status]}
              <span className="min-w-0 flex-1 text-small">
                <b className="font-medium text-foreground">{item.title}</b>
                <span className="sr-only">{text.statusNote(statusText[item.status])}</span>
                <span className="text-muted-foreground"> · {item.detail}</span>
              </span>
              {item.fix === undefined ? null : (
                <Button
                  size="sm"
                  type="button"
                  onClick={() => {
                    const fix = item.fix;
                    if (fix === undefined) return;
                    if ("login" in fix) void navigate({ to: "/login" });
                    else void navigate({ to: "/settings/$section", params: { section: fix.section } });
                  }}
                >
                  {item.fix.label}
                </Button>
              )}
            </ItemRow>
          ))}
        </ItemList>
      </SettingsRow>

      <SettingsRow
        anchor="all-checks"
        title={text.checksTitle}
        description={text.checksDescription}
        stacked
      >
        {doctor.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label={text.checksLoading}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : doctor.data === undefined ? (
          <p className="m-0 text-small text-danger">{text.checksFailed(classifyFailure(doctor.error).message)}</p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="settings-doctor-checks">
            {problems.length === 0 ? (
              <p className="m-0 flex items-center gap-1.5 text-small text-success">
                <CircleCheckIcon aria-hidden="true" className="size-4" />
                {text.allPassed(doctor.data.checks.length)}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={text.problemsLabel}>
                {problems.map((check, index) => (
                  <li
                    key={`${check.name}-${index}`}
                    className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2"
                    data-testid="doctor-check"
                    data-status={check.status}
                  >
                    <span className="flex items-center gap-1.5 text-small font-medium text-foreground">
                      {check.status === "fail" ? STATUS_ICON.fail : STATUS_ICON.warn}
                      <span className="font-mono">{check.name}</span>
                    </span>
                    <span className="text-caption text-muted-foreground">{check.message}</span>
                    {check.remediation === undefined || check.remediation === null || check.remediation === "" ? null : (
                      <span className="text-caption text-warning" data-testid="doctor-remediation">
                        {text.remediation(check.remediation)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Collapsible>
              <CollapsibleTrigger className="group inline-flex items-center gap-1 text-small text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDownIcon aria-hidden="true" className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                {text.showAll(doctor.data.checks.length)}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="m-0 mt-2 flex max-h-72 list-none flex-col gap-1 overflow-y-auto rounded-md bg-code-bg p-3 font-mono text-caption text-muted-foreground">
                  {doctor.data.checks.map((check, index) => (
                    <li key={`${check.name}-${index}`}>
                      [{check.status}] {check.name} · {check.message}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
