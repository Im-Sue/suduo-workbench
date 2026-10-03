import type { FastifyRequest } from "fastify";
import type { RoomEventDraft, WithEvents } from "../application/rooms/events.js";
import type { RealtimeHub } from "../application/rooms/realtime-hub.js";

/** 路由共用的小工具。 */

export function actorId(request: FastifyRequest): string {
  return request.user.sub;
}

export function idSchema(name: string) {
  return {
    type: "object",
    additionalProperties: false,
    required: [name],
    properties: {
      [name]: { type: "string", format: "uuid" },
    },
  } as const;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Content-Disposition：ASCII 兜底名 + RFC 5987 的 UTF-8 文件名。 */
export function contentDisposition(type: "attachment" | "inline", fileName: string): string {
  const fallback = fileName
    .replace(/[^\u0020-\u007e]/gu, "_")
    .replace(/["\\]/gu, "_")
    .slice(0, 120) || "attachment";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function downloadDisposition(fileName: string): string {
  return contentDisposition("attachment", fileName);
}

/** 事务提交后在路由层发布房间事件，返回业务结果。 */
export function emit<T>(realtime: RealtimeHub, outcome: WithEvents<T>): T {
  realtime.publishAll(outcome.events);
  return outcome.value;
}

export type { RoomEventDraft };
