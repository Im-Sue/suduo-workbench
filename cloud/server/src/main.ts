import { createApplication } from "./application.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./infrastructure/database.js";
import { createApplicationCloser, listenApplication } from "./lifecycle.js";
import { runMigrations } from "./infrastructure/migration-runner.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const database = createDatabase(config);
  try {
    if (config.runMigrations) {
      await runMigrations(database.pool);
    }
  } catch (error) {
    await database.pool.end();
    throw error;
  }

  let server: Awaited<ReturnType<typeof createApplication>>;
  try {
    server = await createApplication(config, database);
  } catch (error) {
    await database.pool.end();
    throw error;
  }
  const close = createApplicationCloser(server, database);
  const closeFromSignal = () => {
    void close().catch(reportFatalError);
  };
  process.once("SIGINT", closeFromSignal);
  process.once("SIGTERM", closeFromSignal);
  await listenApplication(server, { host: config.host, port: config.port }, close);
}

function reportFatalError(error: unknown): void {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

main().catch(reportFatalError);
