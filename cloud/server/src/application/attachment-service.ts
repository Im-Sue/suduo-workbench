import type { Readable } from "node:stream";
import type { AttachmentDto, ListAttachmentsResponse } from "@suduo/cloud-contracts";
import { ApplicationError } from "./errors.js";
import type { AttachmentRepository } from "../infrastructure/attachment-repository.js";
import type { AttachmentStorage } from "../infrastructure/attachment-storage.js";
import type { ArtifactVersionRepository } from "../infrastructure/artifact-version-repository.js";

export class AttachmentService {
  constructor(
    private readonly repository: AttachmentRepository,
    private readonly storage: AttachmentStorage,
    private readonly artifactVersions: ArtifactVersionRepository,
  ) {}

  async initialize(): Promise<void> {
    await this.repository.acquireStorageOwnership();
    try {
      await this.storage.initialize();
      await this.storage.reconcile(await this.retainedStorageKeys());
    } catch (error) {
      await this.repository.releaseStorageOwnership();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.repository.releaseStorageOwnership();
  }

  list(requirementId: string): Promise<ListAttachmentsResponse> {
    return this.repository.list(requirementId);
  }

  async upload(input: {
    actorId: string;
    attachmentId: string;
    requirementId: string;
    stream: AsyncIterable<Uint8Array | string> & { truncated?: boolean };
    fileName: string;
    contentType: string;
    declaredSize?: number;
    beforeCommit?: () => Promise<void>;
  }) {
    await this.repository.assertStorageOwnership();
    const idState = await this.repository.attachmentIdState(input.attachmentId);
    if (idState === "deleted") throw attachmentIdConflict();
    if (idState === "missing") {
      await this.repository.assertCanUpload(input.requirementId);
    }
    const stored = await this.storage.store({
      stream: input.stream,
      fileName: input.fileName,
      contentType: input.contentType,
      ...(input.declaredSize === undefined ? {} : { declaredSize: input.declaredSize }),
    });
    try {
      if (input.stream.truncated === true) {
        throw new ApplicationError(413, "ATTACHMENT_TOO_LARGE", "Attachment exceeds the 300 MiB limit");
      }
      await input.beforeCommit?.();
      await this.repository.assertStorageOwnership();
      return await this.repository.create(
        input.actorId,
        input.requirementId,
        stored,
        input.attachmentId,
      );
    } catch (error) {
      let replayed: Awaited<ReturnType<AttachmentRepository["findActiveById"]>>;
      let replayedIdState: Awaited<ReturnType<AttachmentRepository["attachmentIdState"]>>;
      try {
        const committed = await this.repository.findActiveByStorageKey(stored.storageKey);
        if (committed !== null) return committed;
        replayed = await this.repository.findActiveById(input.attachmentId);
        replayedIdState = replayed === null
          ? await this.repository.attachmentIdState(input.attachmentId)
          : "active";
      } catch {
        // COMMIT 结果无法读回时保留文件，由启动 reconcile 根据数据库真相处理。
        throw error;
      }
      if (replayed !== null) {
        await this.storage.remove(stored.storageKey).catch(() => undefined);
        if (!sameAttachment(replayed.attachment, input.requirementId, stored)) {
          throw new ApplicationError(
            409,
            "ATTACHMENT_INVALID",
            "This upload Idempotency-Key was already used for different content",
          );
        }
        return replayed;
      }
      if (replayedIdState === "deleted") {
        await this.storage.remove(stored.storageKey).catch(() => undefined);
        throw attachmentIdConflict();
      }
      await this.storage.remove(stored.storageKey).catch(() => undefined);
      throw error;
    }
  }

  async download(actorId: string, attachmentId: string): Promise<{
    attachment: AttachmentDto;
    stream: Readable;
  }> {
    const record = await this.repository.getForDownload(attachmentId);
    const stream = await this.storage.open(record.storageKey);
    try {
      await this.repository.recordDownload(actorId, attachmentId);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return { attachment: record.attachment, stream };
  }

  async delete(actorId: string, attachmentId: string) {
    await this.repository.assertStorageOwnership();
    const record = await this.repository.delete(actorId, attachmentId);
    if ((await this.artifactVersions.referencedStorageKeys()).has(record.storageKey)) {
      return { ...record, cleanupFailed: false };
    }
    let cleanupFailed = false;
    try {
      await this.storage.remove(record.storageKey);
    } catch {
      cleanupFailed = true;
    }
    return { ...record, cleanupFailed };
  }

  private async retainedStorageKeys(): Promise<ReadonlySet<string>> {
    const [activeStorageKeys, referencedStorageKeys] = await Promise.all([
      this.repository.activeStorageKeys(),
      this.artifactVersions.referencedStorageKeys(),
    ]);
    return new Set([...activeStorageKeys, ...referencedStorageKeys]);
  }
}

function attachmentIdConflict(): ApplicationError {
  return new ApplicationError(
    409,
    "ATTACHMENT_INVALID",
    "This upload Idempotency-Key was already used for a deleted or different attachment",
  );
}

function sameAttachment(
  existing: AttachmentDto,
  requirementId: string,
  stored: {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  },
): boolean {
  return (
    existing.requirementId === requirementId &&
    existing.fileName === stored.fileName &&
    existing.contentType === stored.contentType &&
    existing.sizeBytes === stored.sizeBytes &&
    existing.sha256 === stored.sha256
  );
}
