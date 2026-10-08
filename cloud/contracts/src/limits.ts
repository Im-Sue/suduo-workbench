/** 远端服务权威执行的单需求活跃附件硬上限。 */
export const REQUIREMENTS_SERVICE_MAX_ACTIVE_ATTACHMENTS_PER_REQUIREMENT = 100;

/** 前端文件选择时的体验性预检上限；远端仍以服务端上限为准。 */
export const REQUIREMENTS_WEB_ATTACHMENT_UPLOAD_PRECHECK_LIMIT = 100;

/** 一条评论最多带几个文件（需求附件评论文件与优先级 R5）。 */
export const REQUIREMENT_COMMENT_MAX_FILES = 10;

/** 单个评论文件上限，与附件、房间文件一致（300 MiB）。 */
export const COMMENT_FILE_MAX_BYTES = 314_572_800;

/** 单次按需拉取（亦即单个产物版本）最多允许的文件数。 */
export const REQUIREMENTS_ARTIFACT_VERSION_FETCH_FILE_LIMIT = 50;
