import {
  type ApprovalDto,
  type ProjectDto,
  type SessionDto,
  type ThreadBindingDto,
} from "@suduo/client-contracts";
import type { ApprovalRecord } from "../infrastructure/db/repositories/approval-repository.js";
import type { ProjectRecord } from "../infrastructure/db/repositories/project-repository.js";
import type { SessionRecord } from "../infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRecord } from "../infrastructure/db/repositories/session-thread-repository.js";

export function projectDto(project: ProjectRecord): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    state: project.state,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
    version: project.version,
  };
}

export function threadBindingDto(
  binding: SessionThreadRecord,
): ThreadBindingDto {
  return {
    bindingId: binding.id,
    threadRef: binding.threadRef,
    role: binding.role,
    ordinal: binding.ordinal,
    primary: binding.primary,
    state: binding.state,
  };
}

export function sessionDto(
  session: SessionRecord,
  bindings: readonly SessionThreadRecord[],
): SessionDto {
  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    state: session.state,
    purpose: session.purpose,
    approvalMode: session.approvalMode,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    kind: session.kind,
    agentId: session.agentId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    version: session.version,
    threads: bindings.map(threadBindingDto),
  };
}

export function approvalDto(
  approval: ApprovalRecord,
  binding: SessionThreadRecord,
): ApprovalDto {
  return {
    id: approval.id,
    sessionId: approval.sessionId,
    threadRef: binding.threadRef,
    turnRef: turnRefFromApproval(approval, binding),
    kind: approval.kind,
    status: approval.status,
    decision: approval.decision,
    request: approval.requestPayload,
    requestedAt: approval.requestedAt,
    decidedAt: approval.decidedAt,
    version: approval.version,
  };
}

function turnRefFromApproval(
  approval: ApprovalRecord,
  binding: SessionThreadRecord,
) {
  const payload = approval.requestPayload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const request = payload["request"];
    if (request !== null && typeof request === "object" && !Array.isArray(request)) {
      const turnId = request["turnId"];
      if (typeof turnId === "string") {
        return { threadId: binding.threadRef.threadId, turnId };
      }
    }
  }
  return null;
}
