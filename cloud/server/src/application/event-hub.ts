import { randomUUID } from "node:crypto";
import type { RequirementsEventDto, RequirementsEventType } from "@suduo/cloud-contracts";

type EventListener = (event: RequirementsEventDto) => void;

export class RequirementsEventHub {
  private readonly listeners = new Set<EventListener>();

  publish(input: {
    type: RequirementsEventType;
    projectId: string;
    requirementId?: string;
    requirementVersion?: number;
  }): RequirementsEventDto {
    const event: RequirementsEventDto = {
      id: randomUUID(),
      type: input.type,
      projectId: input.projectId,
      ...(input.requirementId === undefined
        ? {}
        : { requirementId: input.requirementId }),
      ...(input.requirementVersion === undefined
        ? {}
        : { requirementVersion: input.requirementVersion }),
      occurredAt: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
