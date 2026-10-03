export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParameters =
  | readonly SqlValue[]
  | Readonly<Record<string, SqlValue>>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface StatementPort {
  run(parameters?: SqlParameters): RunResult;
  get<T>(parameters?: SqlParameters): T | undefined;
  all<T>(parameters?: SqlParameters): T[];
}

export interface DatabasePort {
  exec(sql: string): void;
  prepare(sql: string): StatementPort;
  transaction<T>(operation: () => T): () => T;
  close(): void;
}
