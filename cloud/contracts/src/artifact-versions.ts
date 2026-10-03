import type { UserSummaryDto } from "./auth.js";

/** 发布产物时采用的不可变文件快照。 */
export interface ArtifactVersionFileDto {
  id: string;
  artifactVersionId: string;
  attachmentId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface ArtifactVersionDto {
  id: string;
  requirementId: string;
  versionNumber: number;
  publishedBy: UserSummaryDto;
  publishedAt: string;
  fileCount: number;
}

export interface ArtifactVersionDetailDto extends ArtifactVersionDto {
  files: ArtifactVersionFileDto[];
}

export interface PublishArtifactVersionRequest {
  operationKey: string;
  attachmentIds: string[];
  note?: string;
}

export interface ListArtifactVersionsResponse {
  items: ArtifactVersionDto[];
}
