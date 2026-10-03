import type { ProjectRecord } from "../infrastructure/db/repositories/project-repository.js";

/**
 * 工作区档位（ADR-0002 第 5 条）：
 * - shared  默认档：会话直接在项目目录里干活，靠自动检查点兜底；
 * - isolated 并行档：会话在独立副本（git worktree）里干活，完事合并回来。
 */
export type WorkspaceMode = "shared" | "isolated";

/**
 * 一次会话执行的工作区上下文。
 *
 * 拆开"项目根"与"执行根"是并行档的前置：projectRoot 永远指向用户选的真实目录
 * （文件树、索引、git 检查点都锚在这里），executionRoot 才是 runtime 的 cwd 与可写边界。
 * 一期两者恒等；三期加 worktree 时只换 resolver，用到 executionRoot 的地方无须改动。
 */
export interface WorkspaceContext {
  projectId: string;
  /** 无会话上下文（如项目级操作）时为 null。 */
  sessionId: string | null;
  projectRoot: string;
  executionRoot: string;
  mode: WorkspaceMode;
}

/** 默认档上下文：执行根＝项目根。 */
export function sharedWorkspace(
  project: ProjectRecord,
  sessionId: string | null = null,
): WorkspaceContext {
  return {
    projectId: project.id,
    sessionId,
    projectRoot: project.rootPath,
    executionRoot: project.rootPath,
    mode: "shared",
  };
}

/**
 * 会话工作区解析入口。一期只返回默认档；并行档落地后在此按会话选择
 * worktree 副本，调用方（supervisor / message / interrupt）无感。
 */
export class WorkspaceContextResolver {
  forSession(project: ProjectRecord, sessionId: string): WorkspaceContext {
    return sharedWorkspace(project, sessionId);
  }

  forProject(project: ProjectRecord): WorkspaceContext {
    return sharedWorkspace(project, null);
  }
}
