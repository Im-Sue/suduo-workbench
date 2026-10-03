import type { FastifyInstance, FastifyListenOptions } from "fastify";
import type { Database } from "./infrastructure/database.js";

type ApplicationServer = Pick<FastifyInstance, "close" | "listen">;

export function createApplicationCloser(
  server: ApplicationServer,
  database: Database,
): () => Promise<void> {
  let closePromise: Promise<void> | null = null;
  return () => {
    closePromise ??= (async () => {
      try {
        await server.close();
      } finally {
        await database.pool.end();
      }
    })();
    return closePromise;
  };
}

export async function listenApplication(
  server: ApplicationServer,
  options: FastifyListenOptions,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await server.listen(options);
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "requirements-service 监听和关闭均失败",
        { cause: closeError },
      );
    }
    throw error;
  }
}
