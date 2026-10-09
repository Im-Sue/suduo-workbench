import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { EventPublisher } from "./event-ledger.js";

type Listener = (event: EventEnvelope<string, JsonValue>) => void;

export class EventBroker implements EventPublisher {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** 不分会话的监听（本机调度器按回合终态还名额，多 Agent 协作 S8）。 */
  private readonly globalListeners = new Set<Listener>();

  publish(event: EventEnvelope<string, JsonValue>): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // 一个监听出错不挡别的（本机调度器按回合事件记名额，漏了要等对账）。
      }
    }
    for (const listener of this.globalListeners) {
      try {
        listener(event);
      } catch {
        // 全局监听出错不影响会话推送。
      }
    }
  }

  subscribeAll(listener: Listener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    let sessionListeners = this.listeners.get(sessionId);
    if (!sessionListeners) {
      sessionListeners = new Set();
      this.listeners.set(sessionId, sessionListeners);
    }
    sessionListeners.add(listener);
    return () => {
      sessionListeners?.delete(listener);
      if (sessionListeners?.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }
}
