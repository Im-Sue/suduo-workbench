import { plural, type ArtifactPublishedCommentParams, type CommentSystemContent } from "@suduo/cloud-contracts";

/**
 * 发布时未填写说明，系统代写的评论：存类型 + 参数，各人前端按自己的语言渲染（中英双语技术设计 §4.3）；
 * 正文是英文兜底，给还不认识类型的旧客户端看（与前端英文字典 requirementDetail.activity.systemComment 一致）。
 * 活动流靠类型判断「没有说明」，不再比较正文；迁移 012 按旧的中文句式回填类型，已冻结。
 */
export function systemPublishComment(params: ArtifactPublishedCommentParams): {
  body: string;
  system: CommentSystemContent;
} {
  const files = plural("en", params.fileCount, { one: "1 file", other: `${String(params.fileCount)} files` });
  return {
    body: `Published confirmed version ${String(params.versionNumber)} with ${files}.`,
    system: { kind: "artifact_published", params },
  };
}
