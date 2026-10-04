import { randomUUID } from "node:crypto";
import {
  agentRunReasonFallback,
  type AgentRunCloudReasonCode,
  type AgentRunDetailDto,
  type AgentRunStatus,
  type AgentRunSummaryDto,
  type AgentRunTextParams,
} from "@suduo/cloud-contracts";
import { PRESENCE_WINDOW_SECONDS, RUNNING_STALE_SECONDS } from "../../application/rooms/constants.js";
import type { Database, QueryExecutor } from "../database.js";
import { RUN_COLUMNS, RUN_FROM, mapRun, requiredRow, type RunRecord, type RunRow } from "./sql.js";

export interface RunLockRow {
  id: string;
  room_id: string;
  agent_id: string;
  thread_root_id: string;
  triggered_by: string;
  status: AgentRunStatus;
  stop_requested: boolean;
  owner_id: string;
}

/**
 * 写库的原因（中英双语技术设计 §4.3）：`text` 是 `reason` 列的英文兜底，`code` / `params` 给新前端按语言渲染。
 * 所有者本机回写的照收（老本机不带 code 时为 null，前端显示原文）；云端自己写的用 `cloudReason`。
 */
export interface RunReasonValue {
  text: string;
  code: string | null;
  params: AgentRunTextParams | null;
}

/** 云端写的原因：code + 英文兜底，不带参数。 */
export function cloudReason(code: AgentRunCloudReasonCode): RunReasonValue {
  return { text: agentRunReasonFallback(code, {}), code, params: null };
}

/** 原因三列的 SQL 参数（参数对象存 jsonb）。 */
function reasonValues(reason: RunReasonValue | null): [string | null, string | null, string | null] {
  if (reason === null) return [null, null, null];
  return [reason.text, reason.code, reason.params === null ? null : JSON.stringify(reason.params)];
}

/**
 * Agent 任务。状态迁移全部是条件更新：条件不满足时不报错，原样返回当前状态（ADR-0004 合并），
 * 由调用方据返回值决定是否推送。
 */
export class AgentRunRepository {
  constructor(private readonly database: Database) {}

  /** 一条消息对一个 Agent 只有一个任务：已有就返回已有那一行（合并）。 */
  async insert(
    executor: QueryExecutor,
    input: {
      roomId: string;
      agentId: string;
      triggerMessageId: string;
      threadRootId: string;
      triggeredBy: string;
      status: "queued" | "offline";
      reason: AgentRunCloudReasonCode | null;
    },
  ): Promise<string> {
    const inserted = await executor.query<{ id: string }>(
      `
        INSERT INTO agent_runs (
          id, room_id, agent_id, trigger_message_id, thread_root_id, triggered_by, status,
          reason, reason_code, reason_params, finished_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::varchar, $8, $9, $10::jsonb, CASE WHEN $7::varchar = 'offline' THEN now() END
        )
        ON CONFLICT (trigger_message_id, agent_id) DO NOTHING
        RETURNING id
      `,
      [
        randomUUID(),
        input.roomId,
        input.agentId,
        input.triggerMessageId,
        input.threadRootId,
        input.triggeredBy,
        input.status,
        ...reasonValues(input.reason === null ? null : cloudReason(input.reason)),
      ],
    );
    if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
    const existing = await executor.query<{ id: string }>(
      "SELECT id FROM agent_runs WHERE trigger_message_id = $1 AND agent_id = $2",
      [input.triggerMessageId, input.agentId],
    );
    return requiredRow(existing.rows[0]).id;
  }

  async find(runId: string, executor: QueryExecutor = this.database): Promise<RunRecord | null> {
    const result = await executor.query<RunRow>(`SELECT ${RUN_COLUMNS} ${RUN_FROM} WHERE ar.id = $1`, [runId]);
    return result.rows[0] === undefined ? null : mapRun(result.rows[0]);
  }

  async findMany(runIds: readonly string[], executor: QueryExecutor = this.database): Promise<RunRecord[]> {
    if (runIds.length === 0) return [];
    const result = await executor.query<RunRow>(
      `SELECT ${RUN_COLUMNS} ${RUN_FROM} WHERE ar.id = ANY($1::uuid[]) ORDER BY ar.queued_at, ar.id`,
      [[...new Set(runIds)]],
    );
    return result.rows.map(mapRun);
  }

  async detail(runId: string): Promise<AgentRunDetailDto | null> {
    const result = await this.database.query<RunRow & { events: unknown[] }>(
      `SELECT ${RUN_COLUMNS}, ar.events ${RUN_FROM} WHERE ar.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { ...mapRun(row).summary, events: row.events };
  }

  /** 接收器用：按 Agent / 状态过滤；取排队时间最新的 200 条，按排队顺序返回。 */
  async list(filter: { agentId?: string; status?: AgentRunStatus }): Promise<AgentRunSummaryDto[]> {
    const result = await this.database.query<RunRow>(
      `
        SELECT * FROM (
          SELECT ${RUN_COLUMNS}, ar.queued_at
          ${RUN_FROM}
          WHERE ($1::uuid IS NULL OR ar.agent_id = $1)
            AND ($2::varchar IS NULL OR ar.status = $2)
          ORDER BY ar.queued_at DESC, ar.id DESC
          LIMIT 200
        ) recent
        ORDER BY recent.queued_at, recent.id
      `,
      [filter.agentId ?? null, filter.status ?? null],
    );
    return result.rows.map((row) => mapRun(row).summary);
  }

  async lock(executor: QueryExecutor, runId: string): Promise<RunLockRow | null> {
    const result = await executor.query<RunLockRow>(
      `
        SELECT ar.id, ar.room_id, ar.agent_id, ar.thread_root_id, ar.triggered_by, ar.status, ar.stop_requested,
               a.owner_id
        FROM agent_runs ar
        JOIN agents a ON a.id = ar.agent_id
        WHERE ar.id = $1
        FOR UPDATE OF ar
      `,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  /** 排队中 → 执行中；已不是排队中返回 false。 */
  async start(executor: QueryExecutor, runId: string): Promise<boolean> {
    const result = await executor.query(
      `
        UPDATE agent_runs
        SET status = 'running', started_at = now(), stop_requested = false
        WHERE id = $1 AND status = 'queued'
      `,
      [runId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 只有执行中的任务接受进度；否则不改。进度的 code / 参数与文字一起整体替换：
   * 老本机不带 code 时清空，免得旧 code 与新文字对不上。
   */
  async progress(
    executor: QueryExecutor,
    runId: string,
    input: { text: string; code: string | null; params: AgentRunTextParams | null; events: unknown[] | undefined },
  ): Promise<boolean> {
    const result = await executor.query(
      `
        UPDATE agent_runs
        SET progress = $2, progress_code = $3, progress_params = $4::jsonb, events = COALESCE($5::jsonb, events)
        WHERE id = $1 AND status = 'running'
      `,
      [
        runId,
        input.text,
        input.code,
        input.params === null ? null : JSON.stringify(input.params),
        input.events === undefined ? null : JSON.stringify(input.events),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 完成。执行过程为空数组时保留执行中已上传的过程：本机带过程回写失败后会退一步不带过程重发
   * （与 finish 的 COALESCE 同口径）。
   */
  async complete(
    executor: QueryExecutor,
    runId: string,
    input: { summary: string; replyMessageId: string; events: unknown[] },
  ): Promise<void> {
    await executor.query(
      `
        UPDATE agent_runs
        SET status = 'completed', summary = $2, reply_message_id = $3, events = COALESCE($4::jsonb, events),
            reason = NULL, reason_code = NULL, reason_params = NULL, stop_requested = false, finished_at = now(),
            started_at = COALESCE(started_at, now())
        WHERE id = $1
      `,
      [runId, input.summary, input.replyMessageId, input.events.length === 0 ? null : JSON.stringify(input.events)],
    );
  }

  async finish(
    executor: QueryExecutor,
    runId: string,
    input: { status: "failed" | "stopped"; reason: RunReasonValue; events: unknown[] | undefined },
  ): Promise<void> {
    // 以所有者本机的回写为准：原因三列整体覆盖（含执行中被请求停止时云端先写的原因）。
    await executor.query(
      `
        UPDATE agent_runs
        SET status = $2::varchar, reason = $3, reason_code = $4, reason_params = $5::jsonb,
            events = COALESCE($6::jsonb, events), stop_requested = false, finished_at = now()
        WHERE id = $1
      `,
      [runId, input.status, ...reasonValues(input.reason), input.events === undefined ? null : JSON.stringify(input.events)],
    );
  }

  /** 停止：排队中直接停；执行中只标记 stop_requested，由所有者本机中断后回写。返回是否有变化。 */
  async requestStop(executor: QueryExecutor, run: RunLockRow, reason: AgentRunCloudReasonCode): Promise<boolean> {
    const values = reasonValues(cloudReason(reason));
    if (run.status === "queued") {
      await executor.query(
        `
          UPDATE agent_runs
          SET status = 'stopped', reason = $2, reason_code = $3, reason_params = $4::jsonb, finished_at = now()
          WHERE id = $1
        `,
        [run.id, ...values],
      );
      return true;
    }
    if (run.status === "running" && !run.stop_requested) {
      await executor.query(
        "UPDATE agent_runs SET stop_requested = true, reason = $2, reason_code = $3, reason_params = $4::jsonb WHERE id = $1",
        [run.id, ...values],
      );
      return true;
    }
    return false;
  }

  /** 重试复用同一行：回到排队（或再次离线），清掉上一次的结果。 */
  async requeue(
    executor: QueryExecutor,
    runId: string,
    status: "queued" | "offline",
    reason: AgentRunCloudReasonCode | null,
  ): Promise<void> {
    await executor.query(
      `
        UPDATE agent_runs
        SET status = $2::varchar, reason = $3, reason_code = $4, reason_params = $5::jsonb, queued_at = clock_timestamp(),
            progress = NULL, progress_code = NULL, progress_params = NULL, summary = NULL, stop_requested = false,
            events = '[]'::jsonb, reply_message_id = NULL, started_at = NULL,
            finished_at = CASE WHEN $2::varchar = 'offline' THEN now() END
        WHERE id = $1
      `,
      [runId, status, ...reasonValues(reason === null ? null : cloudReason(reason))],
    );
  }

  /** 共享关闭 / 到期：排队中的停掉，执行中的请求停止。返回有变化的任务。 */
  async stopForShare(
    executor: QueryExecutor,
    agentId: string,
    roomId: string,
    reason: AgentRunCloudReasonCode,
  ): Promise<string[]> {
    const result = await executor.query<{ id: string }>(
      `
        UPDATE agent_runs
        SET status = CASE WHEN status = 'queued' THEN 'stopped' ELSE status END,
            stop_requested = (status = 'running'),
            reason = $3, reason_code = $4, reason_params = $5::jsonb,
            finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
        WHERE agent_id = $1 AND room_id = $2
          AND (status = 'queued' OR (status = 'running' AND stop_requested = false))
        RETURNING id
      `,
      [agentId, roomId, ...reasonValues(cloudReason(reason))],
    );
    return result.rows.map((row) => row.id);
  }

  /** 掉线 Agent（心跳超时）的排队任务改离线。 */
  async offlineQueuedOfDisconnectedAgents(executor: QueryExecutor, reason: AgentRunCloudReasonCode): Promise<string[]> {
    const result = await executor.query<{ id: string }>(
      `
        UPDATE agent_runs ar
        SET status = 'offline', reason = $1, reason_code = $2, reason_params = $3::jsonb, finished_at = now()
        FROM agents a
        WHERE a.id = ar.agent_id
          AND ar.status = 'queued'
          AND (a.last_seen_at IS NULL OR a.last_seen_at <= now() - make_interval(secs => ${PRESENCE_WINDOW_SECONDS}))
        RETURNING ar.id
      `,
      reasonValues(cloudReason(reason)),
    );
    return result.rows.map((row) => row.id);
  }

  /** 执行中但所属 Agent 太久没心跳：判定本机下线，任务失败（可重试）。 */
  async failRunningOfDisconnectedAgents(executor: QueryExecutor, reason: AgentRunCloudReasonCode): Promise<string[]> {
    const result = await executor.query<{ id: string }>(
      `
        UPDATE agent_runs ar
        SET status = 'failed', reason = $1, reason_code = $2, reason_params = $3::jsonb, stop_requested = false,
            finished_at = now()
        FROM agents a
        WHERE a.id = ar.agent_id
          AND ar.status = 'running'
          AND (a.last_seen_at IS NULL OR a.last_seen_at <= now() - make_interval(secs => ${RUNNING_STALE_SECONDS}))
        RETURNING ar.id
      `,
      reasonValues(cloudReason(reason)),
    );
    return result.rows.map((row) => row.id);
  }
}
