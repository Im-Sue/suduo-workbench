import type { EventEnvelope, JsonValue } from "@suduo/client-contracts";
import type { EventPublisher } from "./event-ledger.js";

type Listener = (event: EventEnvelope<string, JsonValue>) => void;

export class EventBroker implements EventPublisher {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(event: EventEnvelope<string, JsonValue>): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      listener(event);
    }
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
