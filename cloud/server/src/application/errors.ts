import type { RequirementsV2ErrorCode, RequirementsV2ErrorResponse } from "@suduo/cloud-contracts";

export class ApplicationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: RequirementsV2ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApplicationError";
  }
}

export function errorResponse(
  error: ApplicationError,
  requestId: string,
): RequirementsV2ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function notFound(resource: string): ApplicationError {
  return new ApplicationError(404, "NOT_FOUND", `${resource}不存在`);
}
