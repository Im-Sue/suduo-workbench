import {
  AUDIT_RESOURCE_TYPES,
} from "./collaboration.js";
import { REQUIREMENT_COMMENT_MAX_FILES, REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT } from "./limits.js";
import {
  REQUIREMENT_ASSIGNEE_FILTER_ME,
  REQUIREMENT_ASSIGNEE_FILTER_NONE,
  REQUIREMENT_NUMBER_MAX,
} from "./requirements.js";
import {
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_PRIORITY_FILTER_NONE,
  REQUIREMENT_SORTS,
} from "./priority.js";
import { PROJECT_STATS_WINDOWS } from "./stats.js";
import { REQUIREMENT_STATUSES } from "./status.js";

const cursorProperties = {
  cursor: { type: "string", minLength: 1, maxLength: 1024 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
} as const;

const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * 用户 id 或 null（清空）。用类型联合而不是 anyOf：服务端 ajv 开启了类型强转，
 * anyOf 的首个分支会先把 null 强转成空串。
 */
const nullableUuid = {
  type: ["string", "null"],
  format: "uuid",
} as const;

/** 优先级或 null（清空）。同 nullableUuid，用类型联合。 */
const nullablePriority = {
  type: ["string", "null"],
  enum: [...REQUIREMENT_PRIORITIES, null],
} as const;

const PRIORITY_FILTER_VALUE = `(?:${[...REQUIREMENT_PRIORITIES, REQUIREMENT_PRIORITY_FILTER_NONE].join("|")})`;

export const REQUIREMENTS_V2_SCHEMAS = {
  register: {
    type: "object",
    additionalProperties: false,
    required: ["loginName", "displayName", "password"],
    properties: {
      loginName: {
        type: "string",
        minLength: 3,
        maxLength: 64,
        pattern: "^[A-Za-z0-9._-]+$",
      },
      displayName: { type: "string", minLength: 1, maxLength: 80 },
      password: { type: "string", minLength: 8, maxLength: 128 },
    },
  },
  login: {
    type: "object",
    additionalProperties: false,
    required: ["loginName", "password"],
    properties: {
      loginName: { type: "string", minLength: 3, maxLength: 64 },
      password: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  createProject: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  updateProject: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["name"] }, { required: ["isArchived"] }],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      isArchived: { type: "boolean" },
    },
  },
  createRequirement: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      summary: { type: "string", minLength: 0, maxLength: 4000 },
      status: { type: "string", enum: REQUIREMENT_STATUSES },
      assigneeId: nullableUuid,
      priority: nullablePriority,
    },
  },
  updateRequirement: {
    type: "object",
    additionalProperties: false,
    anyOf: [
      { required: ["title"] },
      { required: ["summary"] },
      { required: ["status"] },
      { required: ["assigneeId"] },
      { required: ["priority"] },
    ],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      summary: { type: "string", minLength: 0, maxLength: 4000 },
      status: { type: "string", enum: REQUIREMENT_STATUSES },
      assigneeId: nullableUuid,
      priority: nullablePriority,
    },
  },
  createComment: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["body"] }, { required: ["fileIds"] }],
    properties: {
      // 只带文件时正文可以为空；正文和文件都没有由服务端拒绝。
      body: { type: "string", minLength: 0, maxLength: 4000 },
      fileIds: {
        type: "array",
        minItems: 1,
        maxItems: REQUIREMENT_COMMENT_MAX_FILES,
        items: { type: "string", format: "uuid" },
      },
    },
  },
  commentFileContentQuery: {
    type: "object",
    additionalProperties: false,
    properties: {
      disposition: { type: "string", enum: ["inline", "attachment"] },
    },
  },
  publishArtifactVersion: {
    type: "object",
    additionalProperties: false,
    required: ["operationKey", "attachmentIds"],
    properties: {
      operationKey: { type: "string", minLength: 1, maxLength: 200 },
      attachmentIds: {
        type: "array",
        minItems: 1,
        maxItems: REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT,
        items: { type: "string", format: "uuid" },
      },
      note: { type: "string", maxLength: 4000 },
    },
  },
  listProjects: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...cursorProperties,
      includeArchived: { type: "boolean" },
    },
  },
  listRequirements: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...cursorProperties,
      status: { type: "string", enum: REQUIREMENT_STATUSES },
      search: { type: "string", minLength: 1, maxLength: 200 },
      assignee: {
        type: "string",
        pattern: `^(?:${REQUIREMENT_ASSIGNEE_FILTER_ME}|${REQUIREMENT_ASSIGNEE_FILTER_NONE}|${UUID_PATTERN})$`,
      },
      creator: {
        type: "string",
        pattern: `^(?:${REQUIREMENT_ASSIGNEE_FILTER_ME}|${UUID_PATTERN})$`,
      },
      priority: {
        type: "string",
        maxLength: 100,
        pattern: `^${PRIORITY_FILTER_VALUE}(?:,${PRIORITY_FILTER_VALUE})*$`,
      },
      sort: { type: "string", enum: REQUIREMENT_SORTS },
    },
  },
  requirementByNumberParams: {
    type: "object",
    additionalProperties: false,
    required: ["projectId", "number"],
    properties: {
      projectId: { type: "string", format: "uuid" },
      number: { type: "integer", minimum: 1, maximum: REQUIREMENT_NUMBER_MAX },
    },
  },
  listRequirementsByIds: {
    type: "object",
    additionalProperties: false,
    required: ["ids"],
    properties: {
      ids: { type: "string", minLength: 1, maxLength: 4096 },
    },
  },
  projectStats: {
    type: "object",
    additionalProperties: false,
    required: ["window", "tz"],
    properties: {
      window: { type: "string", enum: PROJECT_STATS_WINDOWS },
      tz: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
  cursorQuery: {
    type: "object",
    additionalProperties: false,
    properties: cursorProperties,
  },
  listAudit: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...cursorProperties,
      resourceType: { type: "string", enum: AUDIT_RESOURCE_TYPES },
      resourceId: { type: "string", format: "uuid" },
      projectId: { type: "string", format: "uuid" },
    },
  },
  idParams: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" },
    },
  },
} as const;
