import type { SessionRunStatusResponse } from "@suduo/client-contracts";
import type { ApprovalRepository } from "../infrastructure/db/repositories/approval-repository.js";
import type { EventRepository } from "../infrastructure/db/repositories/event-repository.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../infrastructure/db/repositories/session-repository.js";
import { ApiError } from "./api-error.js";

/**
 * 会话运行态摘要：由事件账本＋审批表推导，供左栏全列表徽标准确显示，
 * 避免为每个会话单开 SSE（ADR-0002 第 9 条）。
 */
export class SessionRunStatusService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly approvals: ApprovalRepository,
  ) {}

  list(projectId: string): SessionRunStatusResponse {
    if (!this.projects.getById(projectId)) {
      throw new ApiError(404, "NOT_FOUND", "项目不存在");
    }
    const items = this.sessions
      .listByProject(projectId)
      .filter(
        (session) =>
          session.kind !== "room_task" && session.state !== "archived" && session.state !== "deleted",
      )
      .map((session) => ({
        sessionId: session.id,
        running: this.events.listRunningTurnRefs(session.id).length > 0,
        pendingApprovals: this.approvals.countPendingBySession(session.id),
        lastTurnOutcome: this.events.lastTurnOutcome(session.id),
        lastActivityAt: session.lastActivityAt,
      }));
    return { items };
  }
}
