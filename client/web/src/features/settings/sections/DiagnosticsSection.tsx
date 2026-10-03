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
import { showMessage } from "../../../ui/message.js";
import { configWarningOf, useCodexStatus } from "../codex-status.js";
import { ItemList, ItemRow, SettingsRow, SettingsSection } from "../components/kit.js";
import {
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

const STATUS_TEXT: Record<HealthStatus, string> = {
  ok: "正常",
  warn: "需要留意",
  fail: "有问题",
  checking: "检查中",
  unknown: "没能检查",
};

function probe<T>(query: { data: T | undefined; error: unknown; isPending: boolean }): Probe<T> {
  return { data: query.data, error: query.error, pending: query.isPending };
}

/** 诊断：一页看清哪一环有问题、怎么修；可以复制诊断信息发给同事或管理员。 */
export function DiagnosticsSection() {
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
    serviceHealth(settings, baseUrl === "" ? { pending: false } : probe(service)),
    loginHealth(settings),
    doctorHealth(probe(doctor), "codex"),
    modelHealth(probe(provider), probe(models), warning),
    networkHealth(probe(network)),
    mcpHealth(probe(mcp)),
    workspaceHealth(probe(mappings), projectName),
    doctorHealth(probe(doctor), "runtime"),
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
    const report = {
      生成时间: new Date().toISOString(),
      SuDuo版本: appVersion(),
      浏览器: navigator.userAgent,
      结论: items.map((item) => ({ 项: item.title, 状态: STATUS_TEXT[item.status], 说明: item.detail })),
      需求服务: { 地址: settings?.baseUrl ?? null, 已登录: settings?.session?.user.loginName ?? null, 连接: service.isSuccess ? "正常" : service.isError ? classifyFailure(service.error).message : "未检查" },
      本机设置: local.data ?? (local.error === null ? null : classifyFailure(local.error).message),
      审批上限说明: local.data?.approvalModeLocked === true ? "由部署环境变量 SUDUO_MAX_APPROVAL_MODE 限制" : null,
      个人Skills目录说明: local.data?.globalSkillsLocked === true ? "由部署环境变量 SUDUO_GLOBAL_SKILLS 固定" : null,
      模型服务: provider.data ?? (provider.error === null ? null : classifyFailure(provider.error).message),
      模型清单: models.data?.models ?? (models.error === null ? null : classifyFailure(models.error).message),
      网络: network.data ?? (network.error === null ? null : classifyFailure(network.error).message),
      Codex通知: codexStatus.entries,
      MCP服务:
        mcp.data?.items.map((item) => ({
          名称: item.name,
          方式: item.transport,
          启用: item.enabled,
          连接: item.status.startupState,
          登录: item.status.authenticationStatus,
          工具数: item.status.toolCount,
          原因: item.status.startupFailureReason,
        })) ?? null,
      代码目录:
        mappings.data?.map((item) => ({ 项目: projectName(item), 路径: item.rootPath, 可用: item.verification?.available ?? null, 说明: item.verification?.message ?? null })) ??
        null,
      本机自检: doctor.data ?? (doctor.error === null ? null : classifyFailure(doctor.error).message),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      showMessage("诊断信息已复制，可以直接发给同事或管理员", "success");
    } catch {
      showMessage("没能写入剪贴板，请检查浏览器是否允许复制", "warning");
    }
  };

  const problems = doctor.data?.checks.filter((check) => check.status !== "pass") ?? [];

  return (
    <SettingsSection
      id="diagnostics"
      description="一眼看清哪一环有问题，以及怎么修。"
      actions={
        <>
          <Button size="sm" type="button" data-testid="settings-copy-doctor" onClick={() => void copy()}>
            <CopyIcon />
            复制诊断信息
          </Button>
          <Button size="sm" variant="primary" type="button" loading={fetching && !checking} disabled={checking} data-testid="settings-run-doctor" onClick={recheck}>
            <RotateCwIcon />
            重新检查
          </Button>
        </>
      }
    >
      <SettingsRow anchor="health" title="健康检查" stacked>
        <ItemList label="健康检查" data-testid="settings-health-list" aria-busy={checking}>
          {items.map((item) => (
            <ItemRow key={item.key} data-testid="health-item" data-key={item.key} data-status={item.status}>
              {STATUS_ICON[item.status]}
              <span className="min-w-0 flex-1 text-small">
                <b className="font-medium text-foreground">{item.title}</b>
                <span className="sr-only">：{STATUS_TEXT[item.status]}</span>
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
        title="本机自检明细"
        description="逐项的原始检查结果与处理建议；排查问题时可以连同诊断信息一起发给管理员。"
        stacked
      >
        {doctor.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="正在自检">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : doctor.data === undefined ? (
          <p className="m-0 text-small text-danger">没能完成自检：{classifyFailure(doctor.error).message}</p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="settings-doctor-checks">
            {problems.length === 0 ? (
              <p className="m-0 flex items-center gap-1.5 text-small text-success">
                <CircleCheckIcon aria-hidden="true" className="size-4" />
                全部 {doctor.data.checks.length} 项检查都通过了
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="需要处理的检查项">
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
                        处理建议：{check.remediation}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Collapsible>
              <CollapsibleTrigger className="group inline-flex items-center gap-1 text-small text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDownIcon aria-hidden="true" className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                查看全部 {doctor.data.checks.length} 项检查
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
