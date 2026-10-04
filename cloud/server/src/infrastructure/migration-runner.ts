import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = 2_024_082_011;
const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<string> {
  const migrations = await loadMigrations(migrationsDirectory);
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${migrationsDirectory}`);
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version varchar(128) PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<{
      version: string;
      checksum: string;
    }>("SELECT version, checksum FROM schema_migrations");
    const appliedByVersion = new Map(
      applied.rows.map((row) => [row.version, row.checksum]),
    );

    for (const migration of migrations) {
      const existingChecksum = appliedByVersion.get(migration.version);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(`Checksum of migration ${migration.version} has drifted`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return migrations.at(-1)?.version ?? "unknown";
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [
        MIGRATION_LOCK_KEY,
      ]);
    } finally {
      client.release();
    }
  }
}

export async function currentSchemaVersion(pool: Pool): Promise<string> {
  const result = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
  );
  return result.rows[0]?.version ?? "uninitialized";
}

async function loadMigrations(directory: string): Promise<
  Array<{ version: string; checksum: string; sql: string }>
> {
  const files = (await readdir(directory))
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort();
  return Promise.all(
    files.map(async (version) => {
      const sql = await readFile(join(directory, version), "utf8");
      return {
        version,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
}
