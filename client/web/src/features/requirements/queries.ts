import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  type ListRequirementItemsResponse,
  type RequirementListItemDto,
} from "@suduo/client-contracts";
import {
  type CommentFileDto,
  REQUIREMENT_PRIORITY_FILTER_NONE,
  parseRequirementNumberQuery,
  parseRequirementPriorityFilter,
  requirementPriorityRank,
  type CreateRequirementRequest,
  type RequirementStatus,
  type UpdateRequirementRequest,
} from "@suduo/cloud-contracts";
import { useEffect } from "react";
import { api, ApiClientError } from "../../api/client.js";
import { reportFailure } from "../../feedback/report.js";
import { currentLocale } from "../../i18n/locale.js";
import { messagesFor } from "../../i18n/messages/index.js";
import { requirementKeys, type RequirementListFilters } from "./keys.js";
import { markLocalChange } from "./highlight.js";
import { isRealtimeLive } from "./realtime-status.js";

/**
 * 需求模块的数据层（技术设计 §6.3 / §9.2）。
 * - 看板与列表共用「每个状态一列」的分页查询；速览与详情共用同一条详情查询。
 * - 改状态 / 负责人 / 标题：先改界面，失败回滚并提示「未能保存 · 重试」；成功后以服务端结果为准。
 * - 他人的修改由实时事件失效查询带回（realtime.tsx）。
 */

const COLUMN_PAGE_SIZE = 50;
const ACTIVITY_PAGE_SIZE = 30;

type ColumnData = InfiniteData<ListRequirementItemsResponse, string | undefined>;

/** 一列（一个状态）的载入结果。 */
export interface ColumnState {
  count: number;
  hasMore: boolean;
  loaded: boolean;
}

export function columnQuery(projectId: string, status: RequirementStatus, filters: RequirementListFilters) {
  return infiniteQueryOptions({
    queryKey: requirementKeys.column(projectId, status, filters),
    queryFn: ({ pageParam, signal }) =>
      api.listRequirements(
        projectId,
        {
          status,
          limit: COLUMN_PAGE_SIZE,
          ...(filters.search === undefined || filters.search === "" ? {} : { search: filters.search }),
          ...(filters.assignee === undefined ? {} : { assignee: filters.assignee }),
          ...(filters.priority === undefined ? {} : { priority: filters.priority }),
          ...(filters.sort === undefined ? {} : { sort: filters.sort }),
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

/**
 * 一列各页拼起来。翻页之间有人改了排序依据（更新时间、优先级），同一条可能在相邻两页各出现一次：
 * 只留第一次出现的那条，等实时事件让整列重取后自然校正。
 */
export function columnItems(data: { pages: readonly ListRequirementItemsResponse[] } | undefined): RequirementListItemDto[] {
  const seen = new Set<string>();
  const items: RequirementListItemDto[] = [];
  for (const page of data?.pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

export function requirementQuery(requirementId: string) {
  return queryOptions({
    queryKey: requirementKeys.detail(requirementId),
    queryFn: ({ signal }) => api.getRequirement(requirementId, { signal }),
    staleTime: 30_000,
  });
}

export function attachmentsQuery(requirementId: string) {
  return queryOptions({
    queryKey: requirementKeys.attachments(requirementId),
    queryFn: () => api.listRequirementAttachments(requirementId),
    staleTime: 30_000,
  });
}

export function artifactsQuery(requirementId: string) {
  return queryOptions({
    queryKey: requirementKeys.artifacts(requirementId),
    queryFn: () => api.listArtifactVersions(requirementId),
    staleTime: 30_000,
  });
}

export function artifactVersionQuery(requirementId: string, versionId: string) {
  return queryOptions({
    queryKey: [...requirementKeys.artifacts(requirementId), versionId] as const,
    queryFn: () => api.getArtifactVersion(versionId),
    // 已发布的版本不可变。
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function activityQuery(requirementId: string) {
  return infiniteQueryOptions({
    queryKey: requirementKeys.activity(requirementId),
    queryFn: ({ pageParam, signal }) =>
      api.listRequirementActivity(
        requirementId,
        { limit: ACTIVITY_PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export const usersQuery = queryOptions({
  queryKey: requirementKeys.users,
  queryFn: () => api.listUsers(),
  staleTime: 5 * 60_000,
});

/** 项目在本机的会话；尚未关联代码目录时视为没有会话，而不是错误。 */
export function localSessionsQuery(projectId: string) {
  return queryOptions({
    queryKey: requirementKeys.sessions(projectId),
    queryFn: async () => {
      try {
        return (await api.listRequirementsSessions(projectId)).items;
      } catch (cause) {
        if (cause instanceof ApiClientError && cause.code === "WORKSPACE_MAPPING_REQUIRED") return [];
        throw cause;
      }
    },
    staleTime: 30_000,
  });
}

/**
 * 需求本体：详情查询有数据用详情；否则先用看板 / 列表缓存里的条目（进速览零等待），详情到了再替换。
 */
export function useRequirement(requirementId: string | null) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    ...requirementQuery(requirementId ?? ""),
    enabled: requirementId !== null,
  });
  const cached = requirementId === null || detail.data !== undefined ? undefined : findCachedItem(queryClient, requirementId);
  return {
    requirement: (detail.data as RequirementListItemDto | undefined) ?? cached,
    detail,
  };
}

/**
 * 按编号找到需求 id（URL 里用编号）：先查看板 / 列表缓存，没有再请求；取到后顺手写入详情缓存，避免再请求一次。
 * 旧链接里的 UUID 也接受，直接当 id 用。
 * 解析结果记进编号缓存：之后看板缓存被回收、或这条移出了已加载的列，id 仍在，页面不会闪回骨架屏、草稿不丢。
 */
export function useRequirementIdByRef(projectId: string, ref: string | null) {
  const queryClient = useQueryClient();
  const number = ref === null ? null : parseRequirementNumberQuery(ref);
  const isUuid = ref !== null && number === null && UUID_PATTERN.test(ref);
  const numberKey = requirementKeys.byNumber(projectId, number ?? 0);
  const cached = number === null ? undefined : findCachedItem(queryClient, (item) => item.projectId === projectId && item.number === number);
  const cachedId = cached?.id;
  useEffect(() => {
    if (number !== null && cachedId !== undefined && queryClient.getQueryData(numberKey) !== cachedId) {
      queryClient.setQueryData(numberKey, cachedId);
    }
    // numberKey 由 projectId、number 决定。
  }, [cachedId, number, projectId, queryClient]);
  const lookup = useQuery({
    queryKey: numberKey,
    queryFn: async () => {
      const found = await api.getRequirementByNumber(projectId, number ?? 0);
      queryClient.setQueryData(requirementKeys.detail(found.id), found);
      return found.id;
    },
    enabled: number !== null && cachedId === undefined,
    staleTime: Number.POSITIVE_INFINITY,
    // 找不到就是找不到；网络问题再试两次。
    retry: (count, error) => !isNotFound(error) && count < 2,
  });
  return {
    id: isUuid ? ref : (cachedId ?? lookup.data ?? null),
    number,
    invalid: ref !== null && number === null && !isUuid,
    notFound: lookup.isError && isNotFound(lookup.error),
    lookup,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 404;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function findCachedItem(
  queryClient: QueryClient,
  match: string | ((item: RequirementListItemDto) => boolean),
): RequirementListItemDto | undefined {
  const test = typeof match === "string" ? (item: RequirementListItemDto) => item.id === match : match;
  for (const [, data] of queryClient.getQueriesData<ColumnData>({ queryKey: requirementKeys.all })) {
    if (data === undefined || typeof data !== "object" || !("pages" in data)) continue;
    for (const page of data.pages) {
      const found = page.items.find(test);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** 项目下的看板列、列表、搜索重取；本机会话不在其内（它每次都要在本机校验目录，改需求时不必重查）。 */
export function invalidateProjectLists(queryClient: QueryClient, projectId: string) {
  return queryClient.invalidateQueries({
    queryKey: requirementKeys.project(projectId),
    predicate: (query) => query.queryKey[3] !== "local-sessions",
  });
}

/**
 * 评论、材料、确认版变了：只重取这一条，把计数与更新人 / 时间写回看板 / 列表里那张卡（位置不动）。
 * 看板上没有这一条就什么都不做；详情本身由调用方失效重取。
 * 每条事件各发一次请求、只认最后发出的那次：连着来两条事件时，先发的请求可能读到旧状态，不能让它覆盖。
 */
let cardRefreshCounter = 0;
/** 每条需求最后发出的那次请求；只有它能写回。 */
const latestCardRefresh = new Map<string, number>();

export async function refreshCardCounts(queryClient: QueryClient, requirementId: string): Promise<void> {
  if (findCachedItem(queryClient, requirementId) === undefined) return;
  cardRefreshCounter += 1;
  const ticket = cardRefreshCounter;
  latestCardRefresh.set(requirementId, ticket);
  let fresh: RequirementListItemDto;
  try {
    fresh = await api.getRequirement(requirementId);
  } catch {
    if (latestCardRefresh.get(requirementId) === ticket) latestCardRefresh.delete(requirementId);
    return;
  }
  if (latestCardRefresh.get(requirementId) !== ticket) return; // 之后又发过一次，由它写回。
  latestCardRefresh.delete(requirementId);
  for (const [queryKey, data] of queryClient.getQueriesData<ColumnData>({ queryKey: requirementKeys.project(fresh.projectId) })) {
    if (columnStatusOf(queryKey) === null || data === undefined) continue;
    if (!data.pages.some((page) => page.items.some((entry) => entry.id === fresh.id))) continue;
    queryClient.setQueryData<ColumnData>(queryKey, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((entry) =>
          entry.id === fresh.id
            ? {
                ...entry,
                commentCount: fresh.commentCount,
                attachmentCount: fresh.attachmentCount,
                updatedAt: fresh.updatedAt,
                updatedBy: fresh.updatedBy,
              }
            : entry,
        ),
      })),
    });
  }
}

// ---------- 乐观更新的缓存改写 ----------

function columnStatusOf(queryKey: readonly unknown[]): RequirementStatus | null {
  return queryKey[3] === "column" ? (queryKey[4] as RequirementStatus) : null;
}

function columnFiltersOf(queryKey: readonly unknown[]): RequirementListFilters {
  const filters = queryKey[5];
  return typeof filters === "object" && filters !== null ? (filters as RequirementListFilters) : {};
}

/** 列带着优先级筛选时，改完不在筛选里的条目不再放回这一列。 */
function matchesPriorityFilter(item: RequirementListItemDto, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  const values = parseRequirementPriorityFilter(filter);
  return values === null || values.includes(item.priority ?? REQUIREMENT_PRIORITY_FILTER_NONE);
}

/** 按优先级排序时 a 是否排在 b 前面：与需求服务一致，(优先级权重, 更新时间, id) 都从大到小。 */
function sortsBefore(a: RequirementListItemDto, b: RequirementListItemDto): boolean {
  const rankA = requirementPriorityRank(a.priority);
  const rankB = requirementPriorityRank(b.priority);
  if (rankA !== rankB) return rankA > rankB;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.id > b.id;
}

/**
 * 把一条需求写进本项目所有看板列缓存：先从各列移除，再放进所属状态列。
 * 按最近更新排的列放在最前（刚改过的就是最新的）；按优先级排的列放到它该在的位置，
 * 落在已载入的最后一条之后且还有下一页时先不放，等重取（否则会出现在不该出现的位置）。
 */
export function placeInColumns(queryClient: QueryClient, item: RequirementListItemDto): void {
  const queries = queryClient.getQueriesData<ColumnData>({ queryKey: requirementKeys.project(item.projectId) });
  for (const [queryKey, data] of queries) {
    const status = columnStatusOf(queryKey);
    if (status === null || data === undefined) continue;
    const filters = columnFiltersOf(queryKey);
    const pages = data.pages.map((page) => ({ ...page, items: page.items.filter((entry) => entry.id !== item.id) }));
    if (status === item.status && pages[0] !== undefined && matchesPriorityFilter(item, filters.priority)) {
      if (filters.sort === "priority") {
        insertByPriority(pages, item);
      } else {
        pages[0] = { ...pages[0], items: [item, ...pages[0].items] };
      }
    }
    queryClient.setQueryData<ColumnData>(queryKey, { ...data, pages });
  }
}

function insertByPriority(pages: ListRequirementItemsResponse[], item: RequirementListItemDto): void {
  for (const [index, page] of pages.entries()) {
    const position = page.items.findIndex((entry) => sortsBefore(item, entry));
    if (position !== -1) {
      pages[index] = { ...page, items: [...page.items.slice(0, position), item, ...page.items.slice(position)] };
      return;
    }
  }
  const last = pages.at(-1);
  if (last !== undefined && last.nextCursor === null) {
    pages[pages.length - 1] = { ...last, items: [...last.items, item] };
  }
}

function patchItem(item: RequirementListItemDto, patch: UpdateRequirementRequest, assignee: RequirementListItemDto["assignee"] | undefined) {
  return {
    ...item,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(assignee === undefined ? {} : { assignee }),
    updatedAt: new Date().toISOString(),
  };
}

export interface UpdateVariables {
  requirement: RequirementListItemDto;
  patch: UpdateRequirementRequest;
  /** 改负责人时附上被选中的用户，界面立即显示头像。 */
  assignee?: RequirementListItemDto["assignee"];
}

export function useUpdateRequirement() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ requirement, patch }: UpdateVariables) => api.updateRequirement(requirement.id, patch),
    onMutate: async ({ requirement, patch, assignee }) => {
      markLocalChange(requirement.id);
      // 只取消整列刷新，不打断正在进行的「加载更多」。
      await queryClient.cancelQueries({
        queryKey: requirementKeys.project(requirement.projectId),
        predicate: (query) => query.queryKey[3] === "column" && query.state.fetchMeta?.fetchMore === undefined,
      });
      await queryClient.cancelQueries({ queryKey: requirementKeys.detail(requirement.id) });
      const detailBefore = queryClient.getQueryData(requirementKeys.detail(requirement.id));
      const next = patchItem(requirement, patch, assignee);
      placeInColumns(queryClient, next);
      queryClient.setQueryData(requirementKeys.detail(requirement.id), (current: object | undefined) =>
        current === undefined ? current : { ...current, ...next },
      );
      return { detailBefore };
    },
    onError: (cause, variables, context) => {
      // 只回滚这一条：同时进行的其他修改不受影响；位置以服务端为准，随后重取。
      placeInColumns(queryClient, variables.requirement);
      if (context?.detailBefore !== undefined) {
        queryClient.setQueryData(requirementKeys.detail(variables.requirement.id), context.detailBefore);
      }
      void invalidateProjectLists(queryClient, variables.requirement.projectId);
      reportFailure(cause, {
        surface: "action",
        id: `requirement-update-${variables.requirement.id}`,
        title: messagesFor(currentLocale()).requirementDetail.page.saveFailed,
        retry: () => mutation.mutate(variables),
      });
    },
    onSuccess: (saved) => {
      // 以服务端结果为准；看板上的排序、筛选通常由随后到达的实时回声校正，不再整板重取一遍。
      // 例外：实时连接不在线（回声到不了），或有「加载更多」正在进行（它完成时会用发起时的旧页覆盖这次放置）。
      markLocalChange(saved.id);
      placeInColumns(queryClient, saved);
      queryClient.setQueryData(requirementKeys.detail(saved.id), (current: object | undefined) =>
        current === undefined ? current : { ...current, ...saved },
      );
      const loadingMore = queryClient
        .getQueryCache()
        .findAll({ queryKey: requirementKeys.project(saved.projectId) })
        .some((query) => query.state.fetchStatus === "fetching" && query.state.fetchMeta?.fetchMore !== undefined);
      if (!isRealtimeLive() || loadingMore) void invalidateProjectLists(queryClient, saved.projectId);
    },
    onSettled: (_saved, _error, { requirement }) => {
      void queryClient.invalidateQueries({ queryKey: requirementKeys.activity(requirement.id) });
    },
  });
  return mutation;
}

export function useCreateRequirement(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequirementRequest) => api.createRequirement(projectId, body),
    onSuccess: (created) => {
      markLocalChange(created.id);
      placeInColumns(queryClient, created);
      void invalidateProjectLists(queryClient, projectId);
    },
  });
}

/** 发评论的变量：正文可以为空（只带文件时）；files 只给发送中的占位显示用。 */
export interface CreateCommentVariables {
  body: string;
  fileIds: readonly string[];
  files: readonly CommentFileDto[];
}

export function useCreateComment(requirementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, fileIds }: CreateCommentVariables) =>
      api.createRequirementComment(requirementId, {
        ...(body === "" ? {} : { body }),
        ...(fileIds.length === 0 ? {} : { fileIds: [...fileIds] }),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: requirementKeys.activity(requirementId) });
      void queryClient.invalidateQueries({ queryKey: requirementKeys.detail(requirementId) });
    },
  });
}
