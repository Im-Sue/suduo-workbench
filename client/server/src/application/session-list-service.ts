import type {
  ListAllSessionsQuery,
  ListAllSessionsResponse,
  Locale,
  SessionListItemDto,
} from "@suduo/client-contracts";
import type { ApprovalRepository } from "../infrastructure/db/repositories/approval-repository.js";
import type { EventRepository } from "../infrastructure/db/repositories/event-repository.js";
import type {
  SessionListCursor,
  SessionListRepository,
} from "../infrastructure/db/repositories/session-list-repository.js";
import type { SessionThreadRepository } from "../infrastructure/db/repositories/session-thread-repository.js";
import { messagesFor } from "../i18n/messages/index.js";
import { ApiError } from "./api-error.js";
import { sessionDto } from "./dto.js";
import { describeActivity } from "./session-activity.js";
import { reduceSessionRunStatuses } from "./session-run-status-reducer.js";
import { normalizePreviewText } from "./session-preview.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface SessionListServiceDependencies {
  list: Pick<SessionListRepository, "listPage">;
  threads: Pick<SessionThreadRepository, "listBySession">;
  events: Pick<EventRepository, "listRunStatusEventsForSessions" | "latestStep">;
  approvals: Pick<ApprovalRepository, "countPendingGroupedBySession">;
}

/**
 * GET /api/v1/sessions：本机所有项目的会话（可按远程项目过滤），只读投影。
 * 预览与需求快照都是入账 / 建会话时写好的列；运行态只对当页会话读回合事件。
 */
export class SessionListService {
  constructor(private readonly dependencies: SessionListServiceDependencies) {}

  /** locale：「正在做什么」那一行（runStatus.activity）用的语言，即请求的语言。 */
  list(query: ListAllSessionsQuery, locale: Locale): ListAllSessionsResponse {
    const t = messagesFor(locale);
    const limit = normalizeLimit(query.limit);
    const after = decodeCursor(query.cursor);
    // 多取一条判断是否还有下一页。
    const entries = this.dependencies.list.listPage({
      view: query.state ?? "active",
      kind: query.kind ?? "normal",
      remoteProjectId: query.remoteProjectId ?? null,
      after,
      limit: limit + 1,
    });
    const page = entries.slice(0, limit);
    const ids = page.map((entry) => entry.session.id);
    const runStatuses = reduceSessionRunStatuses(
      ids,
      this.dependencies.events.listRunStatusEventsForSessions(ids),
    );
    const pending = this.dependencies.approvals.countPendingGroupedBySession();
    const items: SessionListItemDto[] = page.map((entry) => {
      const run = runStatuses.get(entry.session.id);
      const previewText =
        entry.lastMessage === null ? "" : normalizePreviewText(entry.lastMessage.text);
      return {
        ...sessionDto(entry.session, this.dependencies.threads.listBySession(entry.session.id)),
        project: entry.project,
        requirement: entry.requirement,
        kind: entry.session.kind,
        roomTask: entry.roomTask,
        preview:
          entry.lastMessage === null || previewText === ""
            ? null
            : { role: entry.lastMessage.role, text: previewText },
        runStatus: {
          running: run?.running ?? false,
          pendingApprovals: pending.get(entry.session.id) ?? 0,
          lastTurnOutcome: run?.lastTurnOutcome ?? null,
          runningSince: run?.runningSince ?? null,
          // 只对在跑的会话读一条最近步骤（通常没几个），空闲会话不查。
          activity:
            run?.running === true && run.runningFromSeq !== null
              ? describeActivity(this.dependencies.events.latestStep(entry.session.id, run.runningFromSeq), t)
              : null,
        },
      };
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        entries.length > limit && last !== undefined
          ? encodeCursor({ sortKey: last.sortKey, id: last.session.id })
          : null,
    };
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.limitRange(MAX_LIMIT));
  }
  return limit;
}

function encodeCursor(cursor: SessionListCursor): string {
  return Buffer.from(JSON.stringify([cursor.sortKey, cursor.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): SessionListCursor | null {
  if (cursor === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.cursorInvalid);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "number" ||
    !Number.isSafeInteger(parsed[0]) ||
    typeof parsed[1] !== "string" ||
    parsed[1] === ""
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.cursorInvalid);
  }
  return { sortKey: parsed[0], id: parsed[1] };
}
