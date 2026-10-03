import { queryOptions, useQueries, useQuery } from "@tanstack/react-query";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import { api } from "../../api/client.js";
import { useProjects } from "../../app/project-context.js";
import { settingsQuery } from "../../app/queries.js";
import { requirementKeys } from "../requirements/keys.js";
import { attentionItems, mergeMyRequirements, type MyRequirement } from "./model.js";

/**
 * 我的工作的数据：页面与侧栏「我的工作」旁的待处理数共用同一批查询（同一份缓存）。
 * - 工作台聚合（等你确认、上一轮失败、开工后有变化、目录失效、我在做的需求）：页面上 15 秒刷新；
 * - 每个项目「指派给我」与「我提的、还没人负责」：30 秒刷新；需求变化、新评论等实时事件也会让它们重取。
 * 每个观察者各自计时：侧栏在我的工作页上时不另设间隔（见 Sidebar），免得同一查询被刷两遍。
 */
export const workbenchQuery = queryOptions({
  queryKey: ["my-work", "workbench"] as const,
  queryFn: () => api.getMyWorkbench(),
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
});

export function assignedToMeQuery(projectId: string) {
  return queryOptions({
    queryKey: [...requirementKeys.project(projectId), "assigned-to-me"] as const,
    queryFn: ({ signal }) => api.listRequirements(projectId, { assignee: "me", limit: 100 }, { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function createdUnassignedQuery(projectId: string) {
  return queryOptions({
    queryKey: [...requirementKeys.project(projectId), "created-unassigned"] as const,
    queryFn: ({ signal }) => api.listRequirements(projectId, { creator: "me", assignee: "none", limit: 50 }, { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

type Listed = RequirementListItemDto & { projectName: string | null };

export function useMyWorkData(
  options: { enabled?: boolean; workbenchInterval?: number | false; listInterval?: number | false } = {},
) {
  const enabled = options.enabled ?? true;
  const projects = (useProjects().data ?? []).filter((project) => !project.isArchived);
  const workbench = useQuery({
    ...workbenchQuery,
    enabled,
    ...(options.workbenchInterval === undefined ? {} : { refetchInterval: options.workbenchInterval }),
  });
  const interval = options.listInterval === undefined ? {} : { refetchInterval: options.listInterval };
  const assigned = useQueries({ queries: projects.map((project) => ({ ...assignedToMeQuery(project.id), enabled, ...interval })) });
  const created = useQueries({ queries: projects.map((project) => ({ ...createdUnassignedQuery(project.id), enabled, ...interval })) });

  const withProject = (pages: readonly { data?: { items: RequirementListItemDto[] } | undefined }[]): Listed[] =>
    pages.flatMap((query, index) => (query.data?.items ?? []).map((item) => ({ ...item, projectName: projects[index]?.name ?? null })));
  const working = workbench.data?.requirements.status === "ready" ? workbench.data.requirements.data : null;
  const actions = workbench.data?.actions.status === "ready" ? workbench.data.actions.data : null;
  // 旧版需求服务不认 creator 参数（会被悄悄丢掉，只剩「未指派」）：前端按创建人与负责人再筛一次。
  const meId = useQuery(settingsQuery).data?.session?.user.id ?? null;
  const createdByMe = withProject(created).filter((item) => meId !== null && item.createdBy.id === meId && item.assignee === null);
  const mine = mergeMyRequirements(withProject(assigned), working ?? [], createdByMe);
  return {
    workbench,
    /** 每个未归档项目各一组查询结果（与 projects 同序）。 */
    assigned,
    created,
    projects,
    /** 全部项目的「我的需求」（未按范围筛）。 */
    mine,
    /** 「需要你处理」：跨项目，不受范围影响。 */
    attention: attentionItems(actions, working, mine),
  };
}

export type MyWorkData = ReturnType<typeof useMyWorkData>;
export type { MyRequirement };
