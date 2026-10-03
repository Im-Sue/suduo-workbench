import type { JsonValue } from "@suduo/client-contracts";

export function serializeJson(value: JsonValue): string {
  return JSON.stringify(value);
}

export function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}
