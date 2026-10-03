import { describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../src/application/attachment-service.js";
import type { AttachmentRepository } from "../src/infrastructure/attachment-repository.js";
import type { AttachmentStorage } from "../src/infrastructure/attachment-storage.js";
import type { ArtifactVersionRepository } from "../src/infrastructure/artifact-version-repository.js";

const REQUIREMENT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe("T3 attachment service idempotency", () => {
  it("reconciles an active replay even when the requirement is already at its quota", async () => {
    const context = serviceContext("active");
    context.repository.create.mockRejectedValue(new Error("quota reached"));

    await expect(context.service.upload(uploadInput())).resolves.toMatchObject({
      attachment: { id: ATTACHMENT_ID, sha256: SHA256 },
    });
    expect(context.repository.assertCanUpload).not.toHaveBeenCalled();
    expect(context.storage.remove).toHaveBeenCalledWith("objects/aa/new-object");
  });

  it("rejects a replay whose content differs from the committed result", async () => {
    const context = serviceContext("active");
    context.repository.create.mockRejectedValue(new Error("duplicate id"));
    context.storage.store.mockResolvedValue({
      storageKey: "objects/aa/new-object",
      fileName: "different.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      sha256: SHA256,
    });

    await expect(context.service.upload(uploadInput())).rejects.toMatchObject({
      statusCode: 409,
      code: "ATTACHMENT_INVALID",
    });
    expect(context.storage.remove).toHaveBeenCalledWith("objects/aa/new-object");
  });

  it("rejects a deleted idempotency tombstone before consuming storage", async () => {
    const context = serviceContext("deleted");

    await expect(context.service.upload(uploadInput())).rejects.toMatchObject({
      statusCode: 409,
      code: "ATTACHMENT_INVALID",
    });
    expect(context.storage.store).not.toHaveBeenCalled();
  });

  it("keeps deleting an uncommitted storage key when the metadata write fails", async () => {
    const context = serviceContext("missing");
    const insertError = new Error("metadata write failed");
    context.repository.create.mockRejectedValue(insertError);

    await expect(context.service.upload(uploadInput())).rejects.toBe(insertError);

    expect(context.storage.remove).toHaveBeenCalledWith("objects/aa/new-object");
    expect(context.artifactVersions.referencedStorageKeys).not.toHaveBeenCalled();
  });

  it("physically removes a soft-deleted blob that no artifact version references", async () => {
    const context = serviceContext("active");

    await expect(context.service.delete(ACTOR_ID, ATTACHMENT_ID)).resolves.toMatchObject({
      cleanupFailed: false,
    });

    expect(context.artifactVersions.referencedStorageKeys).toHaveBeenCalledOnce();
    expect(context.storage.remove).toHaveBeenCalledWith("objects/bb/existing-object");
  });
});

function serviceContext(idState: "missing" | "active" | "deleted") {
  const attachment = {
    id: ATTACHMENT_ID,
    requirementId: REQUIREMENT_ID,
    fileName: "test.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    sha256: SHA256,
    uploadedBy: { id: ACTOR_ID, displayName: "T3" },
    createdAt: "2026-08-14T00:00:00.000Z",
  };
  const mutation = {
    attachment,
    storageKey: "objects/bb/existing-object",
    projectId: "44444444-4444-4444-8444-444444444444",
    requirementVersion: 20,
  };
  const repository = {
    assertStorageOwnership: vi.fn(),
    attachmentIdState: vi.fn().mockResolvedValue(idState),
    assertCanUpload: vi.fn(),
    create: vi.fn().mockResolvedValue(mutation),
    delete: vi.fn().mockResolvedValue(mutation),
    findActiveByStorageKey: vi.fn().mockResolvedValue(null),
    findActiveById: vi.fn().mockResolvedValue(idState === "active" ? mutation : null),
  };
  const storage = {
    store: vi.fn().mockResolvedValue({
      storageKey: "objects/aa/new-object",
      fileName: "test.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      sha256: SHA256,
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const artifactVersions = {
    referencedStorageKeys: vi.fn().mockResolvedValue(new Set<string>()),
  };
  return {
    service: new AttachmentService(
      repository as unknown as AttachmentRepository,
      storage as unknown as AttachmentStorage,
      artifactVersions as unknown as ArtifactVersionRepository,
    ),
    repository,
    storage,
    artifactVersions,
  };
}

function uploadInput() {
  return {
    actorId: ACTOR_ID,
    attachmentId: ATTACHMENT_ID,
    requirementId: REQUIREMENT_ID,
    stream: chunks("test"),
    fileName: "test.txt",
    contentType: "text/plain",
    declaredSize: 4,
  };
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}
