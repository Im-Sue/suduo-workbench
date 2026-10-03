import type { TurnRef } from "@suduo/client-contracts";

export type LastTurnOutcome = "completed" | "failed" | "interrupted" | null;

export interface SessionRunStatusEvent {
  sessionId: string;
  seq: number;
  type: "turn.started" | "turn.completed" | "turn.interrupted" | "turn.start-failed";
  turnRef: TurnRef | null;
  turnStatus: string | null;
  /** 事件时间（毫秒）；老调用方可不传。 */
  ts?: number;
}

export interface SessionRunStatusSummary {
  running: boolean;
  lastTurnOutcome: LastTurnOutcome;
  /** 正在跑的回合里最早开始的那个的开始时间；没在跑为 null。 */
  runningSince: number | null;
  /** 正在跑的回合里最早开始的那个的 turn.started 序号（用来找它之后的步骤）；没在跑为 null。 */
  runningFromSeq: number | null;
}

/**
 * 将一批会话的回合事件归约为现有左栏运行态所需的最小摘要。
 * 调用方传入会话集合，因此即使完全无事件的会话也会得到空闲摘要。
 */
export function reduceSessionRunStatuses(
  sessionIds: readonly string[],
  events: readonly SessionRunStatusEvent[],
): Map<string, SessionRunStatusSummary> {
  const states = new Map<string, {
    runningTurns: Map<string, { running: boolean; startedTs: number | null; startedSeq: number }>;
    lastTurnOutcome: LastTurnOutcome;
  }>();
  for (const sessionId of sessionIds) {
    states.set(sessionId, {
      runningTurns: new Map(),
      lastTurnOutcome: null,
    });
  }

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const state = states.get(event.sessionId);
    if (!state) continue;

    if (event.type === "turn.completed") {
      state.lastTurnOutcome = event.turnStatus === "failed" ? "failed" : "completed";
    } else if (event.type === "turn.interrupted") {
      state.lastTurnOutcome = "interrupted";
    } else if (event.type === "turn.start-failed") {
      state.lastTurnOutcome = "failed";
    }

    if (event.turnRef !== null) {
      state.runningTurns.set(event.turnRef.threadId + "\0" + event.turnRef.turnId, {
        running: event.type === "turn.started",
        startedTs: event.ts ?? null,
        startedSeq: event.seq,
      });
    }
  }

  return new Map(
    [...states.entries()].map(([sessionId, state]) => {
      const running = [...state.runningTurns.values()]
        .filter((turn) => turn.running)
        .sort((left, right) => left.startedSeq - right.startedSeq);
      return [
        sessionId,
        {
          running: running.length > 0,
          lastTurnOutcome: state.lastTurnOutcome,
          runningSince: running[0]?.startedTs ?? null,
          runningFromSeq: running[0]?.startedSeq ?? null,
        },
      ];
    }),
  );
}
