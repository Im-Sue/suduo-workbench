import { QueryClient, queryOptions } from "@tanstack/react-query";
import { api, ApiClientError, type RequirementsProjectDto } from "../api/client.js";

/**
 * 服务端状态统一由 TanStack Query 管理（技术设计 §9.2）。
 * 本文件只放外壳级查询；各模块的查询随 P2–P4 重做迁入 features/*。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) =>
          failureCount < 1 && !(error instanceof ApiClientError && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}

export const queryKeys = {
  settings: ["requirements-settings"] as const,
  projects: ["requirements-projects"] as const,
  session: (sessionId: string) => ["session", sessionId] as const,
};

export const settingsQuery = queryOptions({
  queryKey: queryKeys.settings,
  queryFn: () => api.requirementsSettings(),
  staleTime: 60_000,
});

/** 全部项目（含已归档），按服务端游标翻完。 */
export const projectsQuery = queryOptions({
  queryKey: queryKeys.projects,
  queryFn: async (): Promise<RequirementsProjectDto[]> => {
    const all: RequirementsProjectDto[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.listRequirementsProjects({
        includeArchived: true,
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return all;
  },
});
