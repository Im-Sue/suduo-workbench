import { cliLocale } from "@suduo/client-contracts";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { messagesFor } from "../../i18n/messages/index.js";
import type {
  DatabasePort,
  RunResult,
  SqlParameters,
  StatementPort,
} from "./database-port.js";

interface NativeRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

interface NativeStatement {
  run(...parameters: unknown[]): NativeRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  transaction<T>(operation: () => T): () => T;
  close(): void;
}

type NativeDatabaseConstructor = new (path: string) => NativeDatabase;

/**
 * 打开本机数据库失败，说明按系统语言（中英双语 S8）。主要出现在本机服务启动与 `pnpm doctor` 自检的 SQLite 一项；
 * 界面的自检页也跑这一项，打开临时库失败（如临时目录不可写）时同样会出现，此时是服务进程的系统语言。
 */
export class DatabaseAdapterLoadError extends Error {
  constructor(cause: unknown) {
    super(messagesFor(cliLocale(process.env)).cli.databaseAdapterLoadFailed, { cause });
    this.name = "DatabaseAdapterLoadError";
  }
}

class BetterSqliteStatement implements StatementPort {
  constructor(private readonly statement: NativeStatement) {}

  run(parameters?: SqlParameters): RunResult {
    const result = invoke(this.statement.run.bind(this.statement), parameters);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get<T>(parameters?: SqlParameters): T | undefined {
    return invoke(this.statement.get.bind(this.statement), parameters) as
      | T
      | undefined;
  }

  all<T>(parameters?: SqlParameters): T[] {
    return invoke(this.statement.all.bind(this.statement), parameters) as T[];
  }
}

export class BetterSqlite3Database implements DatabasePort {
  constructor(private readonly database: NativeDatabase) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): StatementPort {
    return new BetterSqliteStatement(this.database.prepare(sql));
  }

  transaction<T>(operation: () => T): () => T {
    return this.database.transaction(operation);
  }

  close(): void {
    this.database.close();
  }
}

export function openBetterSqlite3Database(path: string): DatabasePort {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  let DatabaseConstructor: NativeDatabaseConstructor;
  try {
    const require = createRequire(import.meta.url);
    DatabaseConstructor = require("better-sqlite3") as NativeDatabaseConstructor;
  } catch (error) {
    throw new DatabaseAdapterLoadError(error);
  }

  try {
    return new BetterSqlite3Database(new DatabaseConstructor(path));
  } catch (error) {
    throw new DatabaseAdapterLoadError(error);
  }
}

function invoke<T>(
  method: (...parameters: unknown[]) => T,
  parameters?: SqlParameters,
): T {
  if (parameters === undefined) {
    return method();
  }
  if (Array.isArray(parameters)) {
    return method(...parameters);
  }
  return method(parameters);
}
