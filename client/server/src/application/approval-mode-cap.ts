import {
  APPROVAL_MODE_POLICIES,
  ROOM_AGENT_SECURITY_POLICY,
  cliLocale,
  type ApprovalMode,
  type RuntimeSecurityPolicy,
} from "@suduo/client-contracts";
import { messagesFor } from "../i18n/messages/index.js";
import type { SessionRecord } from "../infrastructure/db/repositories/session-repository.js";

const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  ask: 0,
  auto: 1,
  full: 2,
};

/** 部署侧审批上限；未配置时不锁定，保持既有三档行为。 */
export function maxApprovalMode(
  env: NodeJS.ProcessEnv = process.env,
): ApprovalMode | null {
  const raw = env["SUDUO_MAX_APPROVAL_MODE"];
  if (raw === undefined || raw === "") {
    return null;
  }
  if (raw === "ask" || raw === "auto" || raw === "full") {
    return raw;
  }
  // 部署配置错误，给运维看：按这个进程的系统语言（中英双语 S8）。启动时不校验，运行中取审批档时才抛；
  // 经接口时界面只显示按请求语言的「服务端处理请求失败」、这句进日志，共享 Agent 任务起不来时原文嵌进任务原因。
  throw new Error(messagesFor(cliLocale(env)).cli.maxApprovalModeInvalid);
}

/** 会话原始值不落库改写；每次取策略时按当前部署上限实时 clamp。 */
export function effectiveApprovalMode(
  session: Pick<SessionRecord, "approvalMode">,
  env: NodeJS.ProcessEnv = process.env,
): ApprovalMode {
  const cap = maxApprovalMode(env);
  if (cap === null || APPROVAL_MODE_RANK[session.approvalMode] <= APPROVAL_MODE_RANK[cap]) {
    return session.approvalMode;
  }
  return cap;
}

/**
 * 会话实际下发给 Codex 的安全档：房间任务会话固定为「房间 Agent」档（只读 + 联网 + 不审批，
 * ADR-0009）；其余会话按审批模式（受部署上限约束）取 ask / auto / full 三档之一。
 */
export function sessionSecurityPolicy(
  session: Pick<SessionRecord, "approvalMode"> & { kind?: SessionRecord["kind"] },
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSecurityPolicy {
  if (session.kind === "room_task") {
    return ROOM_AGENT_SECURITY_POLICY;
  }
  return APPROVAL_MODE_POLICIES[effectiveApprovalMode(session, env)];
}
