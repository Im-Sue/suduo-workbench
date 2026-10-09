import {
  type ApprovalDto,
  type ProjectDto,
  type SessionAgentDto,
  type SessionDto,
  type SessionLinkDto,
  type ThreadBindingDto,
} from "@suduo/client-contracts";
import type { ApprovalRecord } from "../infrastructure/db/repositories/approval-repository.js";
import { findAgentDescriptor } from "./agents/catalog.js";
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
    ...sessionAgent(session.agentId),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    version: session.version,
    threads: bindings.map(threadBindingDto),
    parentSessionId: session.parentSessionId ?? null,
    rootSessionId: session.rootSessionId ?? null,
    relation: session.relation ?? null,
  };
}

/** 会话关系另一头的简要信息（多 Agent 协作 S7）。 */
export function sessionLink(session: SessionRecord): SessionLinkDto {
  return {
    id: session.id,
    title: session.title,
    agentId: session.agentId,
    agentName: findAgentDescriptor(session.agentId)?.displayName ?? session.agentId,
    state: session.state,
  };
}

/** 配置表里这家 Agent 的名字与能力；不认识的 Agent（配置表删掉了）不带。 */
function sessionAgent(agentId: string): { agent?: SessionAgentDto } {
  const descriptor = findAgentDescriptor(agentId);
  return descriptor === undefined
    ? {}
    : { agent: { displayName: descriptor.displayName, readOnlyCapable: descriptor.readOnlyCapable, capabilities: [...descriptor.capabilities] } };
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
