import type { JsonValue } from "@suduo/client-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

export type IdempotencyStatus =
  | "processing"
  | "completed"
  | "failed"
  | "indeterminate";

export interface IdempotencyRecord {
  scope: string;
  key: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  response: JsonValue | null;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type IdempotencyClaim =
  | { kind: "started"; record: IdempotencyRecord }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "conflict"; record: IdempotencyRecord }
  | { kind: "indeterminate"; record: IdempotencyRecord };

interface IdempotencyRow {
  scope: string;
  key: string;
  request_hash: string;
  status: IdempotencyStatus;
  response_status: number | null;
  response_json: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export class IdempotencyRepository {
  constructor(private readonly database: DatabasePort) {}

  claim(
    scope: string,
    key: string,
    requestHash: string,
    expiresAt: number,
    now = Date.now(),
  ): IdempotencyClaim {
    const existing = this.get(scope, key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return { kind: "conflict", record: existing };
      }
      if (existing.status === "indeterminate") {
        return { kind: "indeterminate", record: existing };
      }
      return { kind: "replay", record: existing };
    }

    this.database
      .prepare(
        [
          "INSERT INTO idempotency_records",
          "(scope, key, request_hash, status, created_at, updated_at, expires_at)",
          "VALUES (@scope, @key, @requestHash, 'processing', @now, @now, @expiresAt)",
        ].join(" "),
      )
      .run({ scope, key, requestHash, now, expiresAt });
    return {
      kind: "started",
      record: requireIdempotency(this.get(scope, key), scope, key),
    };
  }

  get(scope: string, key: string): IdempotencyRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM idempotency_records WHERE scope = @scope AND key = @key",
      )
      .get<IdempotencyRow>({ scope, key });
    return row ? mapIdempotency(row) : null;
  }

  complete(
    scope: string,
    key: string,
    responseStatus: number,
    response: JsonValue,
    resourceType: string | null,
    resourceId: string | null,
    now = Date.now(),
  ): boolean {
    return this.finish(
      scope,
      key,
      "completed",
      responseStatus,
      response,
      resourceType,
      resourceId,
      now,
    );
  }

  fail(
    scope: string,
    key: string,
    responseStatus: number,
    response: JsonValue,
    now = Date.now(),
  ): boolean {
    return this.finish(
      scope,
      key,
      "failed",
      responseStatus,
      response,
      null,
      null,
      now,
    );
  }

  markIndeterminate(scope: string, key: string, now = Date.now()): boolean {
    return (
      this.database
        .prepare(
          [
            "UPDATE idempotency_records",
            "SET status = 'indeterminate', updated_at = @now",
            "WHERE scope = @scope AND key = @key AND status = 'processing'",
          ].join(" "),
        )
        .run({ scope, key, now }).changes === 1
    );
  }

  purgeExpired(now = Date.now()): number {
    return this.database
      .prepare("DELETE FROM idempotency_records WHERE expires_at < @now")
      .run({ now }).changes;
  }

  private finish(
    scope: string,
    key: string,
    status: "completed" | "failed",
    responseStatus: number,
    response: JsonValue,
    resourceType: string | null,
    resourceId: string | null,
    now: number,
  ): boolean {
    return (
      this.database
        .prepare(
          [
            "UPDATE idempotency_records SET",
            "status = @status, response_status = @responseStatus,",
            "response_json = @responseJson, resource_type = @resourceType,",
            "resource_id = @resourceId, updated_at = @now",
            "WHERE scope = @scope AND key = @key AND status = 'processing'",
          ].join(" "),
        )
        .run({
          scope,
          key,
          status,
          responseStatus,
          responseJson: serializeJson(response),
          resourceType,
          resourceId,
          now,
        }).changes === 1
    );
  }
}

function mapIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    status: row.status,
    responseStatus: row.response_status,
    response: row.response_json ? parseJson(row.response_json) : null,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function requireIdempotency(
  record: IdempotencyRecord | null,
  scope: string,
  key: string,
): IdempotencyRecord {
  if (!record) {
    throw new Error("idempotency record was not persisted: " + scope + "/" + key);
  }
  return record;
}
