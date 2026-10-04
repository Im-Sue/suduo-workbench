import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("T3 attachment storage", () => {
  it("uses a server-generated key, sanitizes the name, and stores HTML at the exact limit", async () => {
    const storage = await createStorage(4, new Set([".html", ".svg"]));
    const stored = await storage.store({
      stream: chunks("test"),
      fileName: "../../escape.HTML",
      contentType: "text/html",
      declaredSize: 4,
    });

    expect(stored).toMatchObject({
      fileName: "escape.HTML",
      contentType: "text/html",
      sizeBytes: 4,
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    });
    expect(stored.storageKey).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f-]{36}$/u);
    await expect(readStream(await storage.open(stored.storageKey))).resolves.toBe("test");
  });

  it("rejects the first byte over the limit and leaves staging empty", async () => {
    const root = await temporaryDirectory();
    const storage = new AttachmentStorage(root, 4, new Set([".txt"]));
    await storage.initialize();

    await expect(
      storage.store({
        stream: chunks("123", "45"),
        fileName: "oversize.txt",
        contentType: "text/plain",
      }),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "ATTACHMENT_TOO_LARGE",
    });
    await expect(readdir(join(root, ".staging"))).resolves.toEqual([]);
  });

  it("rejects before writing bytes beyond the declared size", async () => {
    const root = await temporaryDirectory();
    const storage = new AttachmentStorage(root, 16, new Set([".txt"]));
    await storage.initialize();

    await expect(
      storage.store({
        stream: chunks("123", "45"),
        fileName: "wrong-size.txt",
        contentType: "text/plain",
        declaredSize: 4,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "ATTACHMENT_INVALID",
    });
    await expect(readdir(join(root, ".staging"))).resolves.toEqual([]);
  });

  it("reconcile keeps active objects and removes orphan objects", async () => {
    const storage = await createStorage(16, new Set([".txt"]));
    const active = await storage.store({
      stream: chunks("active"),
      fileName: "active.txt",
      contentType: "text/plain",
    });
    const orphan = await storage.store({
      stream: chunks("orphan"),
      fileName: "orphan.txt",
      contentType: "text/plain",
    });

    await storage.reconcile(new Set([active.storageKey]));

    await expect(readStream(await storage.open(active.storageKey))).resolves.toBe("active");
    await expect(storage.open(orphan.storageKey)).rejects.toMatchObject({
      statusCode: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    });
  });

  it("refuses to take ownership of a non-empty unmarked root", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "unrelated.txt"), "keep");
    const storage = new AttachmentStorage(root, 16, new Set([".txt"]));

    await expect(storage.initialize()).rejects.toThrow("missing the SuDuo ownership marker");
    await expect(readdir(root)).resolves.toEqual(["unrelated.txt"]);
  });

  it("adopts a structurally valid pre-marker attachment root", async () => {
    const root = await temporaryDirectory();
    const objectId = "55555555-5555-4555-8555-555555555555";
    await mkdir(join(root, ".staging"));
    await mkdir(join(root, "objects", "55"), { recursive: true });
    await writeFile(join(root, "objects", "55", objectId), "legacy");
    const storage = new AttachmentStorage(root, 16, new Set([".txt"]));

    await storage.initialize();

    await expect(readFile(join(root, ".suduo-attachments-v1"), "utf8"))
      .resolves.toBe("suduo-requirements-attachments-v1\n");
    await expect(readStream(await storage.open(`objects/55/${objectId}`)))
      .resolves.toBe("legacy");
  });

  it("refuses an unmarked staging-only root without deleting its contents", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".staging"));
    await writeFile(join(root, ".staging", "unrelated.txt"), "keep");
    const storage = new AttachmentStorage(root, 16, new Set([".txt"]));

    await expect(storage.initialize()).rejects.toThrow("missing the SuDuo ownership marker");
    await expect(readFile(join(root, ".staging", "unrelated.txt"), "utf8")).resolves.toBe("keep");
  });

  it("refuses a legacy-shaped root with an unknown staging file", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".staging"));
    await mkdir(join(root, "objects"));
    await writeFile(join(root, ".staging", "unrelated.txt"), "keep");
    const storage = new AttachmentStorage(root, 16, new Set([".txt"]));

    await expect(storage.initialize()).rejects.toThrow("missing the SuDuo ownership marker");
    await expect(readFile(join(root, ".staging", "unrelated.txt"), "utf8")).resolves.toBe("keep");
  });
});

async function createStorage(
  maxBytes: number,
  extensions: ReadonlySet<string>,
): Promise<AttachmentStorage> {
  const storage = new AttachmentStorage(await temporaryDirectory(), maxBytes, extensions);
  await storage.initialize();
  return storage;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "suduo-t3-storage-"));
  temporaryPaths.push(path);
  return path;
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const values: Buffer[] = [];
  for await (const value of stream) values.push(Buffer.from(value));
  return Buffer.concat(values).toString("utf8");
}
