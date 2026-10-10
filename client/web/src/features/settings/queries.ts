import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { McpServerDto, SettingsDto, UpdateSettingsRequest } from "@suduo/client-contracts";
import { api } from "../../api/client.js";
import { reportFailure } from "../../feedback/report.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor, type Messages } from "../../i18n/messages/index.js";
import { useT } from "../../i18n/provider.js";
import { showMessage } from "../../ui/message.js";

/**
 * 设置页的数据层（技术设计 §9.2：`['settings', section]`）。
 * 各分组共用同一份缓存：进入分组零等待，分组导航的异常红点也读同一份数据。
 * 开关类改动先改界面，失败回滚并提示「未能保存 · 重试」（§6.3）。
 */
export const settingsKeys = {
  local: ["settings", "local"] as const,
  model: ["settings", "model"] as const,
  codexModels: ["settings", "model", "list"] as const,
  codexAccount: ["settings", "model", "account"] as const,
  workspace: ["settings", "workspace"] as const,
  skills: ["settings", "skills"] as const,
  skillCatalog: (localProjectId: string) => ["settings", "skills", "catalog", localProjectId] as const,
  mcp: ["settings", "mcp"] as const,
  /** 与首启向导的环境检查共用。 */
  doctor: ["doctor"] as const,
  serviceHealth: (baseUrl: string) => ["settings", "diagnostics", "service", baseUrl] as const,
  networkHealth: ["settings", "diagnostics", "network"] as const,
};

/** 本机运行时设置：审批档、自动存档、个人 Skills 目录、出网代理。 */
export const localSettingsQuery = queryOptions({
  queryKey: settingsKeys.local,
  queryFn: () => api.getSettings(),
  staleTime: 30_000,
});

export const modelProviderQuery = queryOptions({
  queryKey: settingsKeys.model,
  queryFn: () => api.modelProvider(),
  staleTime: 30_000,
  retry: false,
});

/** Codex 官方模型清单；拿得到即说明当前保存的模型服务可用。 */
/** Codex 的登录方式（用 ChatGPT 账号登录，桌面应用 D2）。每次起一个临时 Codex 进程读，不频繁刷新。 */
export const codexAccountQuery = queryOptions({
  queryKey: settingsKeys.codexAccount,
  queryFn: () => api.codexAccount(),
  staleTime: 30_000,
  retry: false,
  // 每读一次要起一个 Codex 进程：从浏览器授权回来聚焦窗口时不重取，登录结果由轮询负责。
  refetchOnWindowFocus: false,
});

export const codexModelsQuery = queryOptions({
  queryKey: settingsKeys.codexModels,
  queryFn: () => api.codexModels(),
  staleTime: 60_000,
  retry: false,
});

/** 代码目录映射（带只读的可用性复验）。 */
export const workspaceMappingsQuery = queryOptions({
  queryKey: settingsKeys.workspace,
  queryFn: async () => (await api.listRequirementsMappingsVerified()).items,
  staleTime: 15_000,
});

export const globalSkillsQuery = queryOptions({
  queryKey: settingsKeys.skills,
  queryFn: () => api.globalSkills(),
  staleTime: 30_000,
  retry: false,
});

export function skillCatalogQuery(localProjectId: string) {
  return queryOptions({
    queryKey: settingsKeys.skillCatalog(localProjectId),
    queryFn: async () => (await api.skillCatalog(localProjectId)).items,
    staleTime: 30_000,
    retry: false,
  });
}

export const mcpServersQuery = queryOptions({
  queryKey: settingsKeys.mcp,
  queryFn: () => api.listMcpServers(),
  staleTime: 15_000,
  retry: false,
});

export const doctorQuery = queryOptions({
  queryKey: settingsKeys.doctor,
  queryFn: () => api.runDoctor(),
  staleTime: 60_000,
  retry: false,
});

export function serviceHealthQuery(baseUrl: string) {
  return queryOptions({
    queryKey: settingsKeys.serviceHealth(baseUrl),
    queryFn: () => api.testRequirementsSettings(baseUrl),
    staleTime: 30_000,
    retry: false,
  });
}

/** 用已保存的代理试连模型服务（不带草稿）。 */
export const networkHealthQuery = queryOptions({
  queryKey: settingsKeys.networkHealth,
  queryFn: () => api.testProxySettings({}),
  staleTime: 30_000,
  retry: false,
});

type LocalPatch = Pick<UpdateSettingsRequest, "globalSkills" | "gitAutoCheckpointDefault" | "defaultApprovalMode">;

/**
 * 即时生效的本机设置（开关、单选）：先改界面，失败回滚并提示，可一键重试。
 * 代理这类多字段表单走保存条，不用这条。
 */
const LOCAL_UPDATE_KEY = ["settings", "local", "update"] as const;

export function useUpdateLocalSettings() {
  const queryClient = useQueryClient();
  const t = useT();
  // 连着改两项时两次请求并行：先发的那次晚回来（成功或失败）都不能盖掉后一次的结果。
  // 只有「最后一个还在路上的」改动才写缓存 / 回滚；其余的只在失败时重读服务端。
  const isLast = () => queryClient.isMutating({ mutationKey: LOCAL_UPDATE_KEY }) <= 1;
  const mutation = useMutation({
    mutationKey: LOCAL_UPDATE_KEY,
    mutationFn: (patch: LocalPatch) => api.updateSettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.local });
      const before = queryClient.getQueryData<SettingsDto>(settingsKeys.local);
      if (before !== undefined) {
        queryClient.setQueryData<SettingsDto>(settingsKeys.local, { ...before, ...patch });
      }
      return { before };
    },
    onError: (cause, patch, context) => {
      if (!isLast()) void queryClient.invalidateQueries({ queryKey: settingsKeys.local });
      else if (context?.before !== undefined) queryClient.setQueryData(settingsKeys.local, context.before);
      reportFailure(cause, {
        surface: "action",
        id: "settings-local-update",
        title: t.settings.saveFailed,
        retry: () => mutation.mutate(patch),
      });
    },
    onSuccess: (next) => {
      if (isLast()) queryClient.setQueryData(settingsKeys.local, next);
    },
  });
  return mutation;
}

/** MCP 服务的启用开关：同样先改界面，失败回滚。 */
export function useToggleMcpServer() {
  const queryClient = useQueryClient();
  const t = useT();
  type Snapshot = { items: McpServerDto[]; statusAvailable: boolean };
  const mutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => api.updateMcpServer(name, { enabled }),
    onMutate: async ({ name, enabled }) => {
      await queryClient.cancelQueries({ queryKey: settingsKeys.mcp });
      const before = queryClient.getQueryData<Snapshot>(settingsKeys.mcp);
      if (before !== undefined) {
        queryClient.setQueryData<Snapshot>(settingsKeys.mcp, {
          ...before,
          items: before.items.map((item) => (item.name === name ? { ...item, enabled } : item)),
        });
      }
      return { before };
    },
    onError: (cause, variables, context) => {
      if (context?.before !== undefined) queryClient.setQueryData(settingsKeys.mcp, context.before);
      reportFailure(cause, {
        surface: "action",
        id: `mcp-toggle-${variables.name}`,
        title: t.settings.saveFailed,
        retry: () => mutation.mutate(variables),
      });
    },
    onSuccess: (result) => reportMcpWrite(result, t),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.mcp });
    },
  });
  return mutation;
}

/**
 * MCP 配置写入的结果告知：官方接口能一次写完时不打扰；
 * 改了连接方式时 Codex 只能分两步替换，需如实告诉用户出问题时怎么恢复。
 */
export function reportMcpWrite(result: { atomic: boolean }, t: Messages = messagesFor(currentLocale())): void {
  if (result.atomic) return;
  showMessage(t.settings.mcpWriteNotAtomic, "warning");
}
