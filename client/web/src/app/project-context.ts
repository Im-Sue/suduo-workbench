import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import type { RequirementsProjectDto } from "../api/client.js";
import { projectsQuery } from "./queries.js";

/**
 * 项目上下文：URL 是唯一真相（/p/$projectId/...）；
 * 不在项目路由下时（我的工作、会话、设置）沿用「上次使用的项目」。
 * localStorage 只用于这类回落与旧链接重定向，不参与判断项目页属于哪个项目。
 */
const LAST_PROJECT_KEY = "suduo.v2.remoteProjectId";
const listeners = new Set<() => void>();

export function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function rememberProjectId(projectId: string): void {
  if (readLastProjectId() === projectId) return;
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // 存储不可用时不影响当前页面。
  }
  for (const listener of listeners) listener();
}

function useLastProjectId(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readLastProjectId,
    readLastProjectId,
  );
}

/** 从项目列表里挑一个可用项目：优先指定 id，其次上次使用，最后第一个未归档项目。 */
export function pickProject(
  projects: readonly RequirementsProjectDto[],
  preferredId: string | null | undefined,
  lastId: string | null = readLastProjectId(),
): RequirementsProjectDto | null {
  const byId = (id: string | null | undefined) =>
    id === null || id === undefined ? undefined : projects.find((project) => project.id === id);
  return (
    byId(preferredId) ??
    byId(lastId) ??
    projects.find((project) => !project.isArchived) ??
    projects[0] ??
    null
  );
}

export function useProjects() {
  return useQuery(projectsQuery);
}

/** 当前项目：路由参数优先，否则上次使用的项目。项目列表未加载完时返回 null。 */
export function useCurrentProject(): {
  project: RequirementsProjectDto | null;
  projects: RequirementsProjectDto[];
  isLoading: boolean;
} {
  const params = useParams({ strict: false }) as { projectId?: string };
  const lastId = useLastProjectId();
  const projectsResult = useProjects();
  const projects = projectsResult.data ?? [];
  return {
    project:
      projectsResult.data === undefined ? null : pickProject(projects, params.projectId, lastId),
    projects,
    isLoading: projectsResult.isPending,
  };
}
