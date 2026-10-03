import {
  Pool,
  type PoolClient,
  type QueryConfigValues,
  type QueryResultRow,
} from "pg";
import type { RequirementsServiceConfig } from "../config.js";

export interface QueryExecutor {
  query<T extends QueryResultRow>(
    text: string,
    values?: QueryConfigValues<unknown[]>,
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class Database implements QueryExecutor {
  constructor(readonly pool: Pool) {}

  query<T extends QueryResultRow>(
    text: string,
    values?: QueryConfigValues<unknown[]>,
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createDatabase(config: RequirementsServiceConfig): Database {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    application_name: "suduo-requirements-service",
  });
  pool.on("error", (error) => {
    console.error("requirements-service PostgreSQL idle connection error", error);
  });
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error("requirements-service PostgreSQL connection error", error);
    });
  });
  return new Database(pool);
}
