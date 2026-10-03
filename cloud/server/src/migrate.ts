import { loadConfig } from "./config.js";
import { createDatabase } from "./infrastructure/database.js";
import { runMigrations } from "./infrastructure/migration-runner.js";

const config = loadConfig();
const database = createDatabase(config);

try {
  const version = await runMigrations(database.pool);
  process.stdout.write(`requirements schema migrated: ${version}\n`);
} finally {
  await database.pool.end();
}
