import { readFileSync } from "node:fs";
import type { DatabasePort } from "./database-port.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationResult {
  appliedVersions: number[];
  currentVersion: number;
}

const INITIAL_SCHEMA_URL = new URL(
  "./migrations/001_m1_initial.sql",
  import.meta.url,
);
const APPROVAL_MODES_URL = new URL(
  "./migrations/002_approval_modes.sql",
  import.meta.url,
);
const V2_CLEAN_LOCAL_STATE_URL = new URL(
  "./migrations/010_v2_clean_local_state.sql",
  import.meta.url,
);
const V2_SESSION_OBSERVATION_STATE_URL = new URL(
  "./migrations/011_v2_session_observation_state.sql",
  import.meta.url,
);
const V2_SESSION_OBSERVATION_HEALTH_URL = new URL(
  "./migrations/012_v2_session_observation_health.sql",
  import.meta.url,
);

const SESSION_MODEL_OVERRIDES_URL = new URL(
  "./migrations/013_session_model_overrides.sql",
  import.meta.url,
);

const SESSION_LIST_METADATA_URL = new URL(
  "./migrations/014_session_list_metadata.sql",
  import.meta.url,
);

const SESSION_CONTEXT_TOOLS_URL = new URL(
  "./migrations/015_session_context_tools.sql",
  import.meta.url,
);

const ROOM_TASKS_URL = new URL(
  "./migrations/016_room_tasks.sql",
  import.meta.url,
);

const V2_MIGRATION_VERSIONS = new Set([1, 2, 10, 11, 12, 13, 14, 15, 16]);

export function loadM1Migrations(): Migration[] {
  return [
    {
      version: 1,
      name: "m1_initial",
      sql: readFileSync(INITIAL_SCHEMA_URL, "utf8"),
    },
    {
      version: 2,
      name: "approval_modes",
      sql: readFileSync(APPROVAL_MODES_URL, "utf8"),
    },
    {
      version: 10,
      name: "v2_clean_local_state",
      sql: readFileSync(V2_CLEAN_LOCAL_STATE_URL, "utf8"),
    },
    {
      version: 11,
      name: "v2_session_observation_state",
      sql: readFileSync(V2_SESSION_OBSERVATION_STATE_URL, "utf8"),
    },
    {
      version: 12,
      name: "v2_session_observation_health",
      sql: readFileSync(V2_SESSION_OBSERVATION_HEALTH_URL, "utf8"),
    },
    {
      version: 13,
      name: "session_model_overrides",
      sql: readFileSync(SESSION_MODEL_OVERRIDES_URL, "utf8"),
    },
    {
      version: 14,
      name: "session_list_metadata",
      sql: readFileSync(SESSION_LIST_METADATA_URL, "utf8"),
    },
    {
      version: 15,
      name: "session_context_tools",
      sql: readFileSync(SESSION_CONTEXT_TOOLS_URL, "utf8"),
    },
    {
      version: 16,
      name: "room_tasks",
      sql: readFileSync(ROOM_TASKS_URL, "utf8"),
    },
  ];
}

export function runMigrations(
  database: DatabasePort,
  migrations: readonly Migration[] = loadM1Migrations(),
  now: () => number = Date.now,
): MigrationResult {
  configureDatabase(database);
  ensureMigrationTable(database);

  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all<{ version: number }>()
      .map((row) => row.version),
  );
  const legacyVersions = [...applied].filter(
    (version) => !V2_MIGRATION_VERSIONS.has(version),
  );
  if (legacyVersions.length > 0) {
    throw new Error(
      `检测到旧数据库迁移版本 [${legacyVersions.join(", ")}]；按 D4 删除本机数据库后重建。`,
    );
  }
  const appliedVersions: number[] = [];

  for (const migration of [...migrations].sort(
    (left, right) => left.version - right.version,
  )) {
    if (applied.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      database.exec(stripPragmas(migration.sql));
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (@version, @name, @appliedAt)",
        )
        .run({
          version: migration.version,
          name: migration.name,
          appliedAt: now(),
        });
    })();
    appliedVersions.push(migration.version);
  }

  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get<{ version: number }>();

  return {
    appliedVersions,
    currentVersion: row?.version ?? 0,
  };
}

function configureDatabase(database: DatabasePort): void {
  database.exec(
    [
      "PRAGMA foreign_keys = ON;",
      "PRAGMA journal_mode = WAL;",
      "PRAGMA synchronous = NORMAL;",
      "PRAGMA busy_timeout = 5000;",
    ].join("\n"),
  );
}

function ensureMigrationTable(database: DatabasePort): void {
  database.exec(
    [
      "CREATE TABLE IF NOT EXISTS schema_migrations (",
      "  version INTEGER PRIMARY KEY,",
      "  name TEXT NOT NULL UNIQUE,",
      "  applied_at INTEGER NOT NULL",
      ") STRICT;",
    ].join("\n"),
  );
}

function stripPragmas(sql: string): string {
  return sql.replace(/^\s*PRAGMA\s+[^;]+;\s*$/gimu, "");
}
