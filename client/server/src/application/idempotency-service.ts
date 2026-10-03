import type { JsonValue } from "@suduo/client-contracts";
import type { IdempotencyRepository } from "../infrastructure/db/repositories/idempotency-repository.js";
import { ApiError } from "./api-error.js";
import { hashIdempotencyRequest } from "./idempotency.js";

export interface IdempotencyReplay {
  statusCode: number;
  body: JsonValue;
}

export type IdempotencyBegin =
  | { kind: "started" }
  | { kind: "replay"; response: IdempotencyReplay };

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export class IdempotencyService {
  constructor(
    private readonly records: IdempotencyRepository,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  begin(scope: string, key: string, request: JsonValue): IdempotencyBegin {
    if (key.length === 0 || key.length > 200) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Idempotency-Key 必须为 1 到 200 个字符",
      );
    }
    const now = Date.now();
    const claim = this.records.claim(
      scope,
      key,
      hashIdempotencyRequest(request),
      now + this.ttlMs,
      now,
    );
    if (claim.kind === "started") {
      return { kind: "started" };
    }
    if (claim.kind === "conflict") {
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "相同 Idempotency-Key 已用于不同请求",
        { scope },
      );
    }
    if (
      claim.kind === "indeterminate" ||
      claim.record.status === "processing"
    ) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_INDETERMINATE",
        "请求结果不确定，服务端不会自动重放可能产生副作用的操作",
        { scope },
      );
    }
    if (
      claim.record.responseStatus === null ||
      claim.record.response === null
    ) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_INDETERMINATE",
        "幂等记录缺少可重放响应",
        { scope },
      );
    }
    return {
      kind: "replay",
      response: {
        statusCode: claim.record.responseStatus,
        body: claim.record.response,
      },
    };
  }

  complete(
    scope: string,
    key: string,
    statusCode: number,
    body: JsonValue,
    resourceType: string | null = null,
    resourceId: string | null = null,
  ): void {
    if (
      !this.records.complete(
        scope,
        key,
        statusCode,
        body,
        resourceType,
        resourceId,
      )
    ) {
      throw new Error("幂等记录完成 CAS 失败: " + scope + "/" + key);
    }
  }

  fail(scope: string, key: string, statusCode: number, body: JsonValue): void {
    if (!this.records.fail(scope, key, statusCode, body)) {
      throw new Error("幂等记录失败 CAS 失败: " + scope + "/" + key);
    }
  }

  indeterminate(scope: string, key: string): void {
    if (!this.records.markIndeterminate(scope, key)) {
      throw new Error("幂等记录不确定 CAS 失败: " + scope + "/" + key);
    }
  }
}
