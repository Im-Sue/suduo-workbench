import {
  AGENT_KINDS,
  AGENT_RUN_STATUSES,
  AGENT_SHARE_DURATIONS,
} from "./rooms.js";

/**
 * 项目聊天房间与共享 Agent 的请求 JSON Schema（远程需求服务的 Fastify 校验用）。
 * 与 `rooms.ts` 的请求类型一一对应；服务端 ajv 开启了类型强转（查询串里的数字可直接用）。
 */

const uuid = { type: "string", format: "uuid" } as const;
const seq = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
/** 执行过程（`EventEnvelope[]`）：服务端不解析，只原样存取。 */
const runEvents = { type: "array", maxItems: 20_000 } as const;
/**
 * 任务进度 / 原因的 code 与参数（中英双语技术设计 §4.3）。只限长度、不限取值：
 * 新版本客户端加的 code，老云端照样收下转发，前端认不出就显示兜底文字（ADR-0004：不为此拒收）。
 */
const runTextCode = { type: "string", minLength: 1, maxLength: 64 } as const;
const runTextParams = {
  type: "object",
  maxProperties: 16,
  additionalProperties: {
    anyOf: [{ type: "string", maxLength: 2_000 }, { type: "number" }],
  },
} as const;

export const ROOM_MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const ROOM_MESSAGE_PAGE_MAX_LIMIT = 200;
export const ROOM_MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
export const ROOM_MESSAGE_SEARCH_MAX_LIMIT = 50;
/** 单条消息正文上限（与数据库约束一致）。 */
export const ROOM_MESSAGE_BODY_MAX_LENGTH = 100_000;

export const REQUIREMENTS_V2_ROOM_SCHEMAS = {
  createRequirementRoom: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      memberIds: { type: "array", maxItems: 200, items: uuid },
    },
  },
  updateRoom: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["name"] }, { required: ["archived"] }],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      archived: { type: "boolean" },
    },
  },
  addRoomMembers: {
    type: "object",
    additionalProperties: false,
    properties: {
      userIds: { type: "array", maxItems: 200, items: uuid },
    },
  },
  markRoomRead: {
    type: "object",
    additionalProperties: false,
    required: ["upToSeq"],
    properties: {
      upToSeq: seq,
    },
  },
  listRoomMessages: {
    type: "object",
    additionalProperties: false,
    properties: {
      after: seq,
      before: seq,
      threadRootId: uuid,
      limit: { type: "integer", minimum: 1, maximum: ROOM_MESSAGE_PAGE_MAX_LIMIT },
    },
  },
  searchRoomMessages: {
    type: "object",
    additionalProperties: false,
    required: ["q"],
    properties: {
      q: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: ROOM_MESSAGE_SEARCH_MAX_LIMIT },
      before: seq,
    },
  },
  sendRoomMessage: {
    type: "object",
    additionalProperties: false,
    required: ["clientId", "body"],
    properties: {
      clientId: { type: "string", minLength: 1, maxLength: 120 },
      body: { type: "string", maxLength: ROOM_MESSAGE_BODY_MAX_LENGTH },
      mentions: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["user", "agent", "all"] },
            id: uuid,
          },
        },
      },
      // 用类型联合而不是 anyOf：ajv 类型强转会先把 null 转成空串。
      threadRootId: { type: ["string", "null"], format: "uuid" },
      fileIds: { type: "array", maxItems: 20, items: uuid },
    },
  },
  roomFileContentQuery: {
    type: "object",
    additionalProperties: false,
    properties: {
      disposition: { type: "string", enum: ["inline", "attachment"] },
    },
  },
  registerAgent: {
    type: "object",
    additionalProperties: false,
    required: ["deviceKey", "deviceName"],
    properties: {
      deviceKey: { type: "string", minLength: 1, maxLength: 120 },
      deviceName: { type: "string", minLength: 1, maxLength: 120 },
      kind: { type: "string", enum: AGENT_KINDS },
    },
  },
  agentHeartbeat: {
    type: "object",
    additionalProperties: false,
    required: ["browserActive"],
    properties: {
      browserActive: { type: "boolean" },
    },
  },
  openAgentShare: {
    type: "object",
    additionalProperties: false,
    required: ["agentId", "duration"],
    properties: {
      agentId: uuid,
      duration: { type: "string", enum: AGENT_SHARE_DURATIONS },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
  createAgentShareRequest: {
    type: "object",
    additionalProperties: false,
    required: ["agentId"],
    properties: {
      agentId: uuid,
    },
  },
  resolveAgentShareRequest: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["accept", "ignore"] },
      duration: { type: "string", enum: AGENT_SHARE_DURATIONS },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
  listAgentRuns: {
    type: "object",
    additionalProperties: false,
    properties: {
      agentId: uuid,
      status: { type: "string", enum: AGENT_RUN_STATUSES },
    },
  },
  agentRunProgress: {
    type: "object",
    additionalProperties: false,
    required: ["progress"],
    properties: {
      progress: { type: "string", maxLength: 2_000 },
      progressCode: runTextCode,
      progressParams: runTextParams,
      events: runEvents,
    },
  },
  completeAgentRun: {
    type: "object",
    additionalProperties: false,
    required: ["replyBody", "summary", "events"],
    properties: {
      replyBody: { type: "string", minLength: 1, maxLength: ROOM_MESSAGE_BODY_MAX_LENGTH },
      summary: { type: "string", maxLength: 2_000 },
      events: runEvents,
    },
  },
  finishAgentRun: {
    type: "object",
    additionalProperties: false,
    required: ["status", "reason"],
    properties: {
      status: { type: "string", enum: ["failed", "stopped"] },
      reason: { type: "string", maxLength: 2_000 },
      reasonCode: runTextCode,
      reasonParams: runTextParams,
      events: runEvents,
    },
  },
} as const;
