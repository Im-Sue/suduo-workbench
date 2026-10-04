import type { RequirementsV2ErrorCode } from "@suduo/cloud-contracts";

/** 需求服务（远程）的连接、登录、配置与报错。 */
export const remote = {
  /** 试连（设置页、首次设置向导）。 */
  test: {
    unreachable: "无法连接远程需求服务，请确认地址、网络和服务状态",
    healthFailed: (status: number) => `远程需求服务健康检查失败（HTTP ${String(status)}）`,
    healthInvalid: "远程需求服务健康检查返回了无效响应",
    /** 试连成功时随结果返回的说明。 */
    ok: "远程需求服务连接正常",
  },
  notConfigured: "请先在设置中配置远程需求服务地址",
  /** 登录、注册时还没保存地址。 */
  notConfiguredShort: "请先配置远程需求服务地址",
  signInRequired: "请先登录远程需求服务",
  baseUrlChanged: "远程服务地址已变更，请重新登录",
  baseUrlChangedSignInAgain: "远程服务地址已变更，请按新地址重新登录",
  credentialsExpired: "登录凭证无效或已过期，请重新登录",
  unavailable: "远程需求服务暂时不可用",
  streamUnavailable: "远程需求服务流连接不可用",
  unrecognizedResponse: "远程需求服务返回了无法识别的响应",
  /** 远程返回的错误码在本机的说明（远程的原文不透传）。 */
  errorCodes: {
    AUTH_REQUIRED: "需要登录后访问",
    AUTH_INVALID: "登录凭证无效或已过期，请重新登录",
    LOGIN_CREDENTIALS_INVALID: "登录名或密码错误",
    LOGIN_NAME_TAKEN: "登录名已被使用",
    VALIDATION_ERROR: "远程服务拒绝了请求参数",
    NOT_FOUND: "远程资源不存在或不可访问",
    VERSION_CONFLICT: "远程数据版本已变化，请刷新后重试",
    PROJECT_ARCHIVED: "项目已归档，不能执行该操作",
    WORKSPACE_MAPPING_REQUIRED: "请先配置可用的本机工作目录",
    ATTACHMENT_INVALID: "附件类型、名称、大小或数量不符合要求",
    ATTACHMENT_TOO_LARGE: "附件超过 300 MiB 上限",
    DEPENDENCY_UNAVAILABLE: "远程需求服务依赖不可用",
    REMOTE_SERVICE_NOT_CONFIGURED: "远程需求服务尚未配置",
    WORKSPACE_MAPPING_CONFLICT: "本机工作目录映射冲突",
    ROOM_ARCHIVED: "房间已归档，只能查看",
    INTERNAL_ERROR: "远程需求服务处理失败",
  } satisfies Record<RequirementsV2ErrorCode, string>,
  /** 发往需求服务之前的本机校验。 */
  validation: {
    baseUrlNotString: "baseUrl 必须是字符串",
    baseUrlInvalid: "远程服务地址无效",
    patchEmpty: "PATCH 至少提供一个字段",
    publishInvalid: "产物发布请求无效",
    loginNameInvalid: "登录名格式无效",
    passwordLengthInvalid: "密码长度无效",
    summaryTooLong: "需求描述必须是不超过 4000 字符的字符串",
    assigneeInvalid: "assigneeId 必须是用户 ID 或 null",
    /** label 是下面 fields 里的字段名。 */
    lengthOutOfRange: (label: string, maximum: number) => `${label}长度必须为 1 到 ${String(maximum)}`,
    fields: {
      projectName: "项目名称",
      requirementTitle: "需求标题",
      commentBody: "评论内容",
      displayName: "显示名",
      loginName: "登录名",
    },
  },
  requirementSessionUnavailable: "需求会话服务不可用",
};
