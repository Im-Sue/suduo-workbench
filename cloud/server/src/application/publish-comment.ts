/** 发布时未填写说明，自动评论使用的系统正文；活动时间线据此把说明还原为 null。 */
export function systemPublishCommentBody(versionNumber: number, fileCount: number): string {
  return `发布了产物 v${String(versionNumber)}，含 ${String(fileCount)} 个文件。`;
}
