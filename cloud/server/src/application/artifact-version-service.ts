import { createHash } from "node:crypto";
import type {
  ArtifactVersionDetailDto,
  ListArtifactVersionsResponse,
  PublishArtifactVersionRequest,
} from "@suduo/cloud-contracts";
import { REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT } from "@suduo/cloud-contracts";
import { ApplicationError } from "./errors.js";
import { systemPublishComment } from "./publish-comment.js";
import type {
  ArtifactVersionFileSnapshot,
  ArtifactVersionRepository,
} from "../infrastructure/artifact-version-repository.js";
import { touchRequirement } from "../infrastructure/requirement-touch.js";

export interface PublishArtifactVersionResult {
  artifactVersion: ArtifactVersionDetailDto;
  projectId: string;
  requirementVersion: number;
}

export class ArtifactVersionService {
  constructor(private readonly repository: ArtifactVersionRepository) {}

  list(requirementId: string): Promise<ListArtifactVersionsResponse> {
    return this.repository.list(requirementId);
  }

  getDetail(versionId: string): Promise<ArtifactVersionDetailDto> {
    return this.repository.getDetail(versionId);
  }

  getFileForDownload(
    artifactVersionId: string,
    fileId: string,
  ): Promise<ArtifactVersionFileSnapshot> {
    return this.repository.getVersionFileForDownload(artifactVersionId, fileId);
  }

  async publish(
    actorId: string,
    requirementId: string,
    request: PublishArtifactVersionRequest,
  ): Promise<PublishArtifactVersionResult> {
    const input = normalizePublishRequest(request);
    const requestDigest = publishRequestDigest(input);
    return this.repository.transaction(async (executor) => {
      // 同一需求的发布与附件变更共用这一把行锁。获取锁后再查幂等记录，
      // 并发的同 operationKey 调用会在前一笔提交后正确重放。
      const requirement = await this.repository.lockRequirement(requirementId, executor);
      const replay = await this.repository.findPublishOperation<PublishArtifactVersionResult>(
        requirementId,
        input.operationKey,
        executor,
      );
      if (replay !== null) {
        if (replay.requestDigest !== requestDigest) {
          throw new ApplicationError(409, "VALIDATION_ERROR", "operationKey was already used for a different publish request");
        }
        return replay.response;
      }
      const attachmentSnapshots = await this.repository.findActiveAttachmentSnapshots(
        requirementId,
        input.attachmentIds,
        executor,
      );
      if (attachmentSnapshots.length !== input.attachmentIds.length) {
        throw new ApplicationError(
          400,
          "ATTACHMENT_INVALID",
          "Published files must belong to this requirement and must not be deleted",
        );
      }
      const snapshotsById = new Map(attachmentSnapshots.map((file) => [file.id, file]));
      const files = input.attachmentIds.map((attachmentId) => snapshotsById.get(attachmentId));
      if (files.some((file) => file === undefined)) {
        throw new ApplicationError(
          400,
          "ATTACHMENT_INVALID",
          "Published files must belong to this requirement and must not be deleted",
        );
      }

      const artifactVersion = await this.repository.createVersionWithFiles(
        {
          requirementId,
          actorId,
          files: files.filter((file): file is NonNullable<typeof file> => file !== undefined),
        },
        executor,
      );
      await this.repository.createPublishComment(
        {
          actorId,
          projectId: requirement.projectId,
          requirementId,
          artifactVersionId: artifactVersion.id,
          ...(input.note === undefined
            ? systemPublishComment({
                versionNumber: artifactVersion.versionNumber,
                fileCount: artifactVersion.fileCount,
              })
            : { body: input.note, system: null }),
        },
        executor,
      );
      const requirementVersion = await touchRequirement(executor, requirementId, actorId);
      await this.repository.createPublicationAudit(
        {
          actorId,
          projectId: requirement.projectId,
          artifactVersion,
          requirementVersion,
        },
        executor,
      );
      const response: PublishArtifactVersionResult = {
        artifactVersion,
        projectId: requirement.projectId,
        requirementVersion,
      };
      await this.repository.recordPublishOperation(
        {
          requirementId,
          operationKey: input.operationKey,
          requestDigest,
          response,
        },
        executor,
      );
      return response;
    });
  }
}

function normalizePublishRequest(
  request: PublishArtifactVersionRequest,
): PublishArtifactVersionRequest {
  const operationKey = request.operationKey.trim();
  if (!operationKey || operationKey.length > 200) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "operationKey must be 1 to 200 characters");
  }
  if (
    request.attachmentIds.length === 0 ||
    request.attachmentIds.length > REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT
  ) {
    throw new ApplicationError(
      400,
      "ATTACHMENT_INVALID",
      `A confirmed version must include 1 to ${REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT} files`,
    );
  }
  if (new Set(request.attachmentIds).size !== request.attachmentIds.length) {
    throw new ApplicationError(400, "ATTACHMENT_INVALID", "Published files must not contain duplicates");
  }
  const note = request.note?.trim();
  if (note !== undefined && note.length > 4_000) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "Publish note must be 4000 characters or fewer");
  }
  return {
    operationKey,
    attachmentIds: [...request.attachmentIds],
    ...(note === undefined || note === "" ? {} : { note }),
  };
}

function publishRequestDigest(request: PublishArtifactVersionRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({
      attachmentIds: [...request.attachmentIds].sort(),
      note: request.note ?? null,
    }))
    .digest("hex");
}
