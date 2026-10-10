import type {
  AgentDto,
  AgentKind,
  AgentRunStatus,
  AgentRunSummaryDto,
  AgentRunTextParams,
  AgentShareDto,
  AgentShareRequestDto,
  AgentShareRequestStatus,
  AgentSummaryDto,
  RoomFileDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import { agentKindName } from "@suduo/cloud-contracts";
import { PRESENCE_WINDOW_SECONDS } from "../../application/rooms/constants.js";
import { roomFileKind } from "../../application/rooms/file-types.js";

/**
 * 房间模块各仓储共用的 SQL 片段与行映射。
 * 嵌套对象（用户、Agent）在 SQL 里直接拼成 JSON，时间统一格式化成与 `Date#toISOString` 同形的 UTC 字符串。
 */

export function isoTimestamp(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** 在线判定的下界：心跳 / 活跃时间晚于它算在线（用数据库时钟）。 */
export const ONLINE_SINCE = `(now() - make_interval(secs => ${PRESENCE_WINDOW_SECONDS}))`;

/** 共享「开着且未到期」。 */
export function shareActive(alias: string): string {
  return `(${alias}.closed_at IS NULL AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > now()))`;
}

export function userJson(idExpression: string): string {
  return `(SELECT json_build_object('id', ju.id, 'displayName', ju.display_name) FROM users ju WHERE ju.id = ${idExpression})`;
}

export function agentJson(idExpression: string): string {
  return `(
    SELECT json_build_object(
      'id', ja.id,
      'kind', ja.kind,
      'deviceName', ja.device_name,
      'owner', json_build_object('id', jo.id, 'displayName', jo.display_name),
      'lastSeenAt', ${isoTimestamp("ja.last_seen_at")},
      'online', COALESCE(ja.last_seen_at > ${ONLINE_SINCE}, false),
      'activeShareCount', (
        SELECT count(*)::integer FROM agent_shares js WHERE js.agent_id = ja.id AND ${shareActive("js")}
      )
    )
    FROM agents ja
    JOIN users jo ON jo.id = ja.owner_id
    WHERE ja.id = ${idExpression}
  )`;
}

export interface AgentJson {
  id: string;
  kind: AgentKind;
  deviceName: string;
  owner: UserSummaryDto;
  lastSeenAt: string | null;
  online: boolean;
  activeShareCount: number;
}

/**
 * Agent 标签（英文兜底）：“Sam's Codex · MacBook Pro”（种类换成对应的显示名）。新前端用所有者名、种类与设备名
 * 按看的人的语言自己拼，只在找不到 Agent 时由它推导；老客户端直接显示，消息里 @ 的高亮也由它推导。
 */
export function agentLabel(ownerName: string, deviceName: string, kind: string = "codex"): string {
  return `${ownerName}'s ${agentKindName(kind)} · ${deviceName}`;
}

export function mapAgent(json: AgentJson): AgentDto {
  return {
    id: json.id,
    kind: json.kind,
    owner: json.owner,
    deviceName: json.deviceName,
    label: agentLabel(json.owner.displayName, json.deviceName, json.kind),
    online: json.online,
    lastSeenAt: json.lastSeenAt,
    activeShareCount: json.activeShareCount,
  };
}

export function toAgentSummary(agent: AgentDto): AgentSummaryDto {
  return {
    id: agent.id,
    kind: agent.kind,
    owner: agent.owner,
    deviceName: agent.deviceName,
    label: agent.label,
  };
}

// ───────────────────────────── 文件 ─────────────────────────────

export const FILE_COLUMNS = `
  f.id, f.room_id, f.file_name, f.content_type, f.size_bytes, f.sha256, f.storage_key, f.created_at,
  ${userJson("f.uploaded_by")} AS uploaded_by_json
`;

export interface FileRow {
  id: string;
  room_id: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  created_at: Date;
  uploaded_by_json: UserSummaryDto;
}

export function mapFile(row: FileRow): RoomFileDto {
  return {
    id: row.id,
    roomId: row.room_id,
    fileName: row.file_name,
    contentType: row.content_type,
    kind: roomFileKind(row.content_type),
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    uploadedBy: row.uploaded_by_json,
    createdAt: row.created_at.toISOString(),
  };
}

// ───────────────────────────── 任务 ─────────────────────────────

export const RUN_COLUMNS = `
  ar.id, ar.room_id, ar.agent_id, ar.trigger_message_id, ar.thread_root_id, ar.triggered_by, ar.status,
  ar.progress, ar.summary, ar.reply_message_id, ar.reason, ar.stop_requested,
  ar.progress_code, ar.progress_params, ar.reason_code, ar.reason_params,
  ar.created_at, ar.started_at, ar.finished_at,
  run_room.project_id AS project_id,
  run_agent.owner_id AS agent_owner_id,
  ${agentJson("ar.agent_id")} AS agent_json,
  ${userJson("ar.triggered_by")} AS triggered_by_json,
  CASE WHEN ar.status = 'queued' THEN (
    SELECT count(*)::integer
    FROM agent_runs rq
    WHERE rq.agent_id = ar.agent_id
      AND rq.status = 'queued'
      AND (rq.queued_at, rq.id) < (ar.queued_at, ar.id)
  ) END AS queue_position
`;

export const RUN_FROM = `
  FROM agent_runs ar
  JOIN rooms run_room ON run_room.id = ar.room_id
  JOIN agents run_agent ON run_agent.id = ar.agent_id
`;

export interface RunRow {
  id: string;
  room_id: string;
  agent_id: string;
  trigger_message_id: string;
  thread_root_id: string;
  triggered_by: string;
  status: AgentRunStatus;
  progress: string | null;
  summary: string | null;
  reply_message_id: string | null;
  reason: string | null;
  stop_requested: boolean;
  progress_code: string | null;
  progress_params: AgentRunTextParams | null;
  reason_code: string | null;
  reason_params: AgentRunTextParams | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  project_id: string;
  agent_owner_id: string;
  agent_json: AgentJson;
  triggered_by_json: UserSummaryDto;
  queue_position: number | null;
}

/** 任务 + 授权与推送需要的归属信息。 */
export interface RunRecord {
  summary: AgentRunSummaryDto;
  projectId: string;
  agentId: string;
  ownerId: string;
  triggeredById: string;
}

export function mapRun(row: RunRow): RunRecord {
  return {
    summary: {
      id: row.id,
      roomId: row.room_id,
      agent: toAgentSummary(mapAgent(row.agent_json)),
      triggerMessageId: row.trigger_message_id,
      threadRootId: row.thread_root_id,
      triggeredBy: row.triggered_by_json,
      status: row.status,
      queuePosition: row.status === "queued" ? (row.queue_position ?? 0) : null,
      progress: row.progress,
      progressCode: row.progress_code,
      progressParams: row.progress_params,
      summary: row.summary,
      replyMessageId: row.reply_message_id,
      reason: row.reason,
      reasonCode: row.reason_code,
      reasonParams: row.reason_params,
      stopRequested: row.stop_requested,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      finishedAt: row.finished_at?.toISOString() ?? null,
    },
    projectId: row.project_id,
    agentId: row.agent_id,
    ownerId: row.agent_owner_id,
    triggeredById: row.triggered_by,
  };
}

// ───────────────────────────── 共享与申请 ─────────────────────────────

export const SHARE_COLUMNS = `
  s.id, s.room_id, s.agent_id, s.started_at, s.expires_at, s.closed_at, s.closed_reason,
  ${shareActive("s")} AS active,
  share_room.project_id AS project_id,
  share_room.requirement_id AS requirement_id,
  share_agent.owner_id AS agent_owner_id,
  ${agentJson("s.agent_id")} AS agent_json
`;

export const SHARE_FROM = `
  FROM agent_shares s
  JOIN rooms share_room ON share_room.id = s.room_id
  JOIN agents share_agent ON share_agent.id = s.agent_id
`;

export interface ShareRow {
  id: string;
  room_id: string;
  agent_id: string;
  started_at: Date;
  expires_at: Date | null;
  closed_at: Date | null;
  closed_reason: string | null;
  active: boolean;
  project_id: string;
  requirement_id: string | null;
  agent_owner_id: string;
  agent_json: AgentJson;
}

export interface ShareRecord {
  share: AgentShareDto;
  projectId: string;
  requirementId: string | null;
  agentId: string;
  ownerId: string;
}

export function mapShare(row: ShareRow): ShareRecord {
  return {
    share: {
      id: row.id,
      roomId: row.room_id,
      agent: mapAgent(row.agent_json),
      startedAt: row.started_at.toISOString(),
      expiresAt: row.expires_at?.toISOString() ?? null,
      closedAt: row.closed_at?.toISOString() ?? null,
      active: row.active,
    },
    projectId: row.project_id,
    requirementId: row.requirement_id,
    agentId: row.agent_id,
    ownerId: row.agent_owner_id,
  };
}

export const SHARE_REQUEST_COLUMNS = `
  sr.id, sr.room_id, sr.agent_id, sr.requester_id, sr.status, sr.created_at,
  request_room.project_id AS project_id,
  request_agent.owner_id AS agent_owner_id,
  ${agentJson("sr.agent_id")} AS agent_json,
  ${userJson("sr.requester_id")} AS requester_json
`;

export const SHARE_REQUEST_FROM = `
  FROM agent_share_requests sr
  JOIN rooms request_room ON request_room.id = sr.room_id
  JOIN agents request_agent ON request_agent.id = sr.agent_id
`;

export interface ShareRequestRow {
  id: string;
  room_id: string;
  agent_id: string;
  requester_id: string;
  status: AgentShareRequestStatus;
  created_at: Date;
  project_id: string;
  agent_owner_id: string;
  agent_json: AgentJson;
  requester_json: UserSummaryDto;
}

export interface ShareRequestRecord {
  request: AgentShareRequestDto;
  projectId: string;
  agentId: string;
  ownerId: string;
}

export function mapShareRequest(row: ShareRequestRow): ShareRequestRecord {
  return {
    request: {
      id: row.id,
      roomId: row.room_id,
      agent: toAgentSummary(mapAgent(row.agent_json)),
      requester: row.requester_json,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    },
    projectId: row.project_id,
    agentId: row.agent_id,
    ownerId: row.agent_owner_id,
  };
}

// ───────────────────────────── 文本 ─────────────────────────────

/**
 * PostgreSQL 的 text 与 jsonb 都不收 NUL（U+0000）：外部给的字符串只要带一个，整条写入稳定 500、重试也过不去。
 * 写库前去掉（不可见的控制字符，不丢有意义的内容），按合并处理，不拒绝。
 */
export function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

/**
 * 递归去掉 JSON 值里所有字符串的 NUL，对象的 key 也处理（去掉后撞名的，后出现的那个生效）。
 * 没有 NUL 的部分原样复用，不复制。
 */
export function stripNulDeep<T>(value: T): T {
  return stripNulValue(value) as T;
}

function stripNulValue(value: unknown): unknown {
  if (typeof value === "string") return stripNul(value);
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((item, index) => {
      const next = stripNulValue(item);
      if (next === item) return;
      copy ??= [...value];
      copy[index] = next;
    });
    return copy ?? value;
  }
  if (value === null || typeof value !== "object") return value;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const nextKey = stripNul(key);
    const nextItem = stripNulValue(item);
    if (nextKey !== key || nextItem !== item) changed = true;
    return [nextKey, nextItem] as const;
  });
  return changed ? Object.fromEntries(entries) : value;
}

/** LIKE / ILIKE 的通配符转义（配合 `ESCAPE '\\'`）。 */
export function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** 数据库写入必须返回行时用。 */
export function requiredRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("Database write returned no row");
  return row;
}
