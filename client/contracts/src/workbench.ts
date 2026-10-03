import type { SessionPurpose } from "./api.js";
import type { RequirementStatus } from "@suduo/cloud-contracts";

export interface WorkbenchReadySection<T> {
  status: "ready";
  data: T;
}

export interface WorkbenchUnavailableSection {
  status: "unavailable";
  error: {
    code: string;
    message: string;
  };
}

/** 工作台各区块独立降级，端点本身始终返回 HTTP 200。 */
export type WorkbenchSection<T> =
  | WorkbenchReadySection<T>
  | WorkbenchUnavailableSection;

export type WorkbenchActionDto =
  | {
      kind: "pending_approval";
      sessionId: string;
      sessionTitle: string;
      localProjectId: string;
      projectName: string | null;
      pendingApprovals: number;
      lastActivityAt: number | null;
    }
  | {
      kind: "failed_turn";
      sessionId: string;
      sessionTitle: string;
      localProjectId: string;
      projectName: string | null;
      lastActivityAt: number | null;
    }
  | {
      kind: "invalid_mapping";
      remoteProjectId: string;
      localProjectId: string | null;
      projectName: string | null;
      message: string;
    };

export type WorkbenchRequirementAvailability = "available" | "unavailable";
export type WorkbenchSnapshotStatus = "available" | "unreadable";

export interface WorkbenchRequirementDto {
  requirementId: string;
  remoteProjectId: string;
  /** 远程当前值；需求已删除或当前账号无权读取时为 null。 */
  title: string | null;
  projectName: string | null;
  status: RequirementStatus | null;
  availability: WorkbenchRequirementAvailability;
  unavailableMessage?: string;
  sessionIds: string[];
  sessionCount: number;
  running: boolean;
  pendingApprovals: number;
  lastActivityAt: number | null;
  /** 只比较快照 title / summary / status，不比较 version。 */
  drift: boolean;
  snapshotStatus: WorkbenchSnapshotStatus;
  snapshotError?: string;
}

export interface WorkbenchSessionDto {
  sessionId: string;
  title: string;
  purpose: SessionPurpose;
  state: "starting" | "active" | "error";
  running: boolean;
  pendingApprovals: number;
  lastTurnOutcome: "completed" | "failed" | "interrupted" | null;
  lastActivityAt: number | null;
  project: {
    id: string;
    name: string | null;
  };
  requirement: {
    remoteProjectId: string;
    requirementId: string;
    /** 本机会话材料中的标题；快照不可读取时为 null。 */
    title: string | null;
    snapshotStatus: WorkbenchSnapshotStatus;
  } | null;
}

export interface MyWorkbenchResponse {
  actions: WorkbenchSection<WorkbenchActionDto[]>;
  requirements: WorkbenchSection<WorkbenchRequirementDto[]>;
  sessions: WorkbenchSection<WorkbenchSessionDto[]>;
}
