import type { RequirementsEventDto } from "@suduo/cloud-contracts";

/**
 * SSE 的第一道关卡：只让契约中明确支持的事件进入工作台分发链。
 *
 * 新事件必须同时补这里与 Workbench 的分发分支；只补后者会在这里静默丢失。
 */
export function parseRequirementsEvent(value: string): RequirementsEventDto | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed as Partial<RequirementsEventDto>;
    if (
      typeof event.id !== "string" ||
      typeof event.projectId !== "string" ||
      typeof event.occurredAt !== "string" ||
      (event.type !== "project.changed" &&
        event.type !== "requirement.changed" &&
        event.type !== "comment.created" &&
        event.type !== "attachment.changed" &&
        event.type !== "artifact.published")
    ) {
      return null;
    }
    return event as RequirementsEventDto;
  } catch {
    return null;
  }
}
