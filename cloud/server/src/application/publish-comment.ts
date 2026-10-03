import type { ArtifactPublishedCommentParams } from "@suduo/cloud-contracts";

/**
 * 发布时未填写说明，系统代写的评论：存类型 + 参数，各人前端按自己的语言渲染（中英双语技术设计 §4.3）；
 * 正文只作兜底，给还不认识类型的旧客户端看。活动流靠类型判断「没有说明」，不再比较正文。
 */
export function systemPublishComment(params: ArtifactPublishedCommentParams): {
  body: string;
  system: { kind: "artifact_published"; params: ArtifactPublishedCommentParams };
} {
  return {
    body: `发布了产物 v${String(params.versionNumber)}，含 ${String(params.fileCount)} 个文件。`,
    system: { kind: "artifact_published", params },
  };
}
