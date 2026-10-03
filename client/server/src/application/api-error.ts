import type { ErrorCode, JsonValue, LocalPathErrorCode } from "@suduo/client-contracts";
import type { RequirementsV2ErrorCode } from "@suduo/cloud-contracts";

export type BffErrorCode = ErrorCode | RequirementsV2ErrorCode | LocalPathErrorCode;

export interface BffErrorResponse {
  error: {
    code: BffErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: BffErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

export class IndeterminateOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndeterminateOperationError";
  }
}

export function errorResponse(
  error: ApiError,
  requestId: string,
): BffErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function asJsonError(error: unknown): JsonValue {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
}
