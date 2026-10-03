export const REQUIREMENTS_V2_ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "LOGIN_CREDENTIALS_INVALID",
  "LOGIN_NAME_TAKEN",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "PROJECT_ARCHIVED",
  "WORKSPACE_MAPPING_REQUIRED",
  "ATTACHMENT_INVALID",
  "ATTACHMENT_TOO_LARGE",
  "DEPENDENCY_UNAVAILABLE",
  "REMOTE_SERVICE_NOT_CONFIGURED",
  "WORKSPACE_MAPPING_CONFLICT",
  /** 房间已归档：只读，不能再发消息（需求 4.1）。 */
  "ROOM_ARCHIVED",
  "INTERNAL_ERROR",
] as const;

export type RequirementsV2ErrorCode =
  (typeof REQUIREMENTS_V2_ERROR_CODES)[number];

export interface RequirementsV2ErrorResponse {
  error: {
    code: RequirementsV2ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}
