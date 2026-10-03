import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AttachmentRepository } from "../src/infrastructure/attachment-repository.js";
import type { Database } from "../src/infrastructure/database.js";

const REQUIREMENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

describe("T3 attachment repository ownership", () => {
  it("uses the advisory-lock client and serializes storage mutation transactions", async () => {
    const version = 10;
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        if (text.includes("pg_try_advisory_lock")) return result([{ acquired: true }]);
        if (text.includes("SELECT project_id, version")) {
          return result([{ project_id: "44444444-4444-4444-8444-444444444444", version }]);
        }
        if (text.includes("COUNT(*)")) return result([{ active_count: "0" }]);
        if (text.includes("UPDATE requirements")) return result([{ version }]);
        if (text.includes("FROM attachments a") && text.includes("WHERE a.id = $1")) {
          return result([attachmentRow(String(values?.[0]), version)]);
        }
        return result([]);
      }),
      release: vi.fn(),
    });
    const database = {
      pool: { connect: vi.fn().mockResolvedValue(client) },
      query: vi.fn(),
      transaction: vi.fn(() => {
        throw new Error("storage mutation must not use a pooled transaction");
      }),
    } as unknown as Database;
    const repository = new AttachmentRepository(database, 20);
    await repository.acquireStorageOwnership();

    await Promise.all([
      repository.create(ACTOR_ID, REQUIREMENT_ID, stored("a"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      repository.create(ACTOR_ID, REQUIREMENT_ID, stored("b"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    ]);

    const transactionCommands = client.query.mock.calls
      .map(([text]) => text.trim())
      .filter((text) => text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK");
    expect(transactionCommands).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
    expect(database.transaction).not.toHaveBeenCalled();
    const commands = client.query.mock.calls.map(([text]) => text as string);
    expect(commands.some((text) => text.includes("SELECT project_id, version") && text.includes("FOR UPDATE")))
      .toBe(true);
    const touches = commands.filter((text) => text.includes("UPDATE requirements"));
    expect(touches).toHaveLength(2);
    expect(touches.every((text) => !text.includes("version = version + 1"))).toBe(true);
  });

  it("附件达到上限时在持锁后回滚，不写入附件", async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (text: string) => {
        if (text.includes("pg_try_advisory_lock")) return result([{ acquired: true }]);
        if (text.includes("SELECT project_id, version")) {
          return result([{ project_id: "44444444-4444-4444-8444-444444444444", version: 10 }]);
        }
        if (text.includes("COUNT(*)")) return result([{ active_count: "20" }]);
        return result([]);
      }),
      release: vi.fn(),
    });
    const repository = new AttachmentRepository(databaseFor(client), 20);
    await repository.acquireStorageOwnership();

    await expect(repository.create(
      ACTOR_ID,
      REQUIREMENT_ID,
      stored("quota-create"),
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )).rejects.toMatchObject({ statusCode: 409, code: "ATTACHMENT_INVALID" });

    const commands = client.query.mock.calls.map(([text]) => text as string);
    expect(commands.some((text) => text.includes("SELECT project_id, version") && text.includes("FOR UPDATE")))
      .toBe(true);
    expect(commands.some((text) => text.includes("INSERT INTO attachments"))).toBe(false);
    expect(commands.filter((text) => text.trim() === "ROLLBACK")).toHaveLength(1);
  });

  it("keeps the ownership error listener until unlock succeeds", async () => {
    const emitter = new EventEmitter();
    const client = Object.assign(emitter, {
      query: vi.fn(async (text: string) => {
        if (text.includes("pg_try_advisory_lock")) return result([{ acquired: true }]);
        if (text.includes("pg_advisory_unlock")) {
          expect(emitter.listenerCount("error")).toBe(1);
          return result([{ unlocked: true }]);
        }
        return result([]);
      }),
      release: vi.fn(),
    });
    const repository = new AttachmentRepository(databaseFor(client), 20);

    await repository.acquireStorageOwnership();
    await repository.releaseStorageOwnership();

    expect(client.listenerCount("error")).toBe(0);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("destroys the ownership connection when unlock fails", async () => {
    const unlockError = new Error("unlock connection lost");
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (text: string) => {
        if (text.includes("pg_try_advisory_lock")) return result([{ acquired: true }]);
        if (text.includes("pg_advisory_unlock")) throw unlockError;
        return result([]);
      }),
      release: vi.fn(),
    });
    const repository = new AttachmentRepository(databaseFor(client), 20);

    await repository.acquireStorageOwnership();
    await expect(repository.releaseStorageOwnership()).rejects.toBe(unlockError);

    expect(client.listenerCount("error")).toBe(0);
    expect(client.release).toHaveBeenCalledWith(unlockError);
  });
});

function stored(suffix: string) {
  return {
    storageKey: `objects/aa/${suffix}`,
    fileName: `${suffix}.txt`,
    contentType: "text/plain",
    sizeBytes: 4,
    sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  };
}

function attachmentRow(id: string, requirementVersion: number) {
  return {
    id,
    requirement_id: REQUIREMENT_ID,
    project_id: "44444444-4444-4444-8444-444444444444",
    storage_key: `objects/aa/${id}`,
    file_name: `${id}.txt`,
    content_type: "text/plain",
    size_bytes: 4,
    sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    uploaded_by_user: { id: ACTOR_ID, displayName: "T3" },
    created_at: new Date("2026-08-14T00:00:00.000Z"),
    requirement_version: requirementVersion,
  };
}

function result<T>(rows: T[]) {
  return { rows, rowCount: rows.length };
}

function databaseFor(client: EventEmitter & { query: unknown; release: unknown }): Database {
  return {
    pool: { connect: vi.fn().mockResolvedValue(client) },
    query: vi.fn(),
    transaction: vi.fn(),
  } as unknown as Database;
}
