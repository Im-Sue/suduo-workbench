import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createApplicationCloser,
  listenApplication,
} from "../src/lifecycle.js";
import type { Database } from "../src/infrastructure/database.js";

describe("requirements-service lifecycle", () => {
  it("closes the server and pool when listen fails", async () => {
    const listenError = new Error("EADDRINUSE");
    const server = {
      listen: vi.fn().mockRejectedValue(listenError),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FastifyInstance;
    const end = vi.fn().mockResolvedValue(undefined);
    const database = { pool: { end } } as unknown as Database;
    const close = createApplicationCloser(server, database);

    await expect(
      listenApplication(server, { host: "127.0.0.1", port: 4100 }, close),
    ).rejects.toBe(listenError);

    expect(server.close).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("ends the pool even when server close fails and only closes once", async () => {
    const closeError = new Error("unlock failed");
    const server = {
      close: vi.fn().mockRejectedValue(closeError),
    } as unknown as FastifyInstance;
    const end = vi.fn().mockResolvedValue(undefined);
    const database = { pool: { end } } as unknown as Database;
    const close = createApplicationCloser(server, database);

    const first = close();
    const second = close();
    await expect(first).rejects.toBe(closeError);
    await expect(second).rejects.toBe(closeError);

    expect(server.close).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
