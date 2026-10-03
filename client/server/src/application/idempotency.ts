import { createHash } from "node:crypto";
import type { JsonValue } from "@suduo/client-contracts";

export function hashIdempotencyRequest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ":" + canonicalJson(value[key] as JsonValue),
      )
      .join(",") +
    "}"
  );
}
