/** 会话、消息、审批、中断、排队与幂等、会话列表、分页、房间路由的报错与提示。 */
export const session = {
  /** 建会话时没给标题用的默认名：按创建请求的语言写下，之后是用户数据。 */
  defaultTitle: "新会话",

  notFound: "会话不存在",
  projectNotFound: "项目不存在",
  activeProjectNotFound: "活动项目不存在",
  activeLocalProjectNotFound: "活动本机项目不存在",
  titleNotString: "会话标题必须是字符串",
  titleLength: "会话标题长度必须为 1 到 300",
  runtimeIdNotString: "runtimeId 必须是字符串",
  runtimeUnsupported: "M1 仅支持 runtimeId=codex-local",
  agentIdNotString: "agentId 必须是字符串",
  /** 配置表里有、但这个版本还接不上它，或者没有这家 Agent。 */
  agentUnavailable: (agentId: string) => `这个版本的 SuDuo 还不能用 ${agentId} 开工`,
  requirementRefStoreUnavailable: "V2 会话引用存储不可用",
  /** 结果不确定（409 IDEMPOTENCY_INDETERMINATE）：线程已在 Codex 建好，本机记录没写进去。 */
  threadMappingWriteFailed: "runtime thread 已创建，但本地映射写入失败",
  requirementRefWriteFailed: "runtime thread 已创建，但 V2 会话引用写入失败",
  stateInvalid: "会话 state 仅允许 active 或 archived",
  approvalModeInvalid: "approvalMode 仅允许 ask / auto / full",
  approvalModeLocked: "审批模式已被部署上限 SUDUO_MAX_APPROVAL_MODE 锁定",
  patchEmpty: "PATCH 至少提供一个字段",
  deletedNotUpdatable: "已删除会话不能更新",
  versionConflict: "会话版本冲突",
  noPrimaryThread: "会话没有可用 primary thread",
  primaryThreadAmbiguous: "会话存在多个 primary thread",
  /** 发消息时：有多个主线程，不猜往哪发。 */
  primaryThreadAmbiguousRouting: "会话存在多个 primary thread，拒绝猜测路由",
  purposeInvalid: "会话 purpose 无效",
  modelNotString: "model 必须是字符串或 null",
  modelInvalid: "model 必须是 1 到 128 位的模型名（字母、数字与 . _ : / -）；恢复跟随默认请传 null",
  /** examples 形如「low / medium / high」。 */
  reasoningEffortInvalid: (examples: string) =>
    "reasoningEffort 须为小写档位名（如 " + examples + "），恢复跟随默认请传 null",

  // 发消息
  contentNotArray: "content 必须是数组",
  notActive: "只有 active 会话可以发消息",
  projectUnavailable: "会话所属项目不可用",
  turnStartIndeterminate: "启动 turn 的结果不确定",
  rebuiltWithoutPrimary: "重建 thread 后缺少 primary 绑定",
  targetThreadNotBound: "目标 thread 未绑定到该会话",
  contentCount: "content 必须包含 1 到 64 项",
  contentItemInvalid: "content item 无效",
  textNotString: "消息文本必须是字符串",
  textEmpty: "消息文本不能为空",
  imageUrlNotString: "图片 URL 必须是字符串",
  imageUrlInvalid: "图片 URL 无效",
  imageUrlProtocol: "图片 URL 仅支持 http/https",
  attachmentIdNotString: "attachmentId 必须是字符串",
  attachmentIdInvalid: "attachmentId 无效",
  contentTypeUnsupported: "不支持的消息 content 类型",
  textTooLong: "消息文本总长度超过 200000",
  skillPathNotAbsolute: "skill 路径必须是绝对路径",
  skillNotAllowed: "skill 不存在或不属于允许的 skill 目录",
  localPathNotAbsolute: "本机路径必须是绝对路径",
  localFileNotFound: "本机输入文件不存在或超出项目目录",

  // 审批
  approvalNotFound: "审批不存在",
  approvalAlreadyDecided: "审批已经完成决策",
  approvalNotPending: "审批已过期或不再可决策",
  approvalConcurrentUpdate: "审批状态已被并发更新",
  approvalThreadLost: "审批 thread 映射已丢失",
  approvalDeliveryIndeterminate: "审批响应投递结果不确定",
  approvalResolveWriteFailed: "审批已投递，但本地完成状态写入失败",

  // 中断
  /** cause 是 Codex 的原始报错（截到 200 字）。 */
  interruptIndeterminate: (cause: string) => `中断请求结果不确定：${cause}`,
  interruptRecordWriteFailed: "中断已投递，但本地确认事件写入失败",
  interruptTargetThreadNotBound: "目标 thread 未绑定到会话",
  runningTurnAmbiguous: "无法唯一确定正在运行的 turn",

  // 幂等
  idempotencyKeyLength: "Idempotency-Key 必须为 1 到 200 个字符",
  idempotencyConflict: "相同 Idempotency-Key 已用于不同请求",
  idempotencyIndeterminate: "请求结果不确定，服务端不会自动重放可能产生副作用的操作",
  idempotencyMissingResponse: "幂等记录缺少可重放响应",

  // 运行时
  threadCreateIndeterminate: "创建 runtime thread 的结果不确定",
  runtimeUnavailable: (runtimeId: string) => "runtime 不可用: " + runtimeId,
  threadResumeFailed: "恢复 runtime thread 失败",

  // 分页与会话列表
  limitRange: (max: number) => `limit 必须是 1 到 ${String(max)} 的整数`,
  limitNotInteger: "limit 必须是整数",
  cursorInvalid: "cursor 无效",
  listStateInvalid: "state 仅允许 active / archived / all",
  listKindInvalid: "kind 仅允许 normal / room_task",
  remoteProjectIdEmpty: "remoteProjectId 不能为空",

  /** 「我的工作」（GET /api/v2/my/workbench）：某一块拿不到数据时的说明，前端接在「…暂不可用：」后面。 */
  workbench: {
    localUnavailable: "本机工作台数据不可用",
    actionsUnavailable: "待处理数据暂不可用",
    requirementsUnavailable: "需求服务暂不可用",
    sessionsUnavailable: "会话数据暂不可用",
    /** 映射失效那一行：映射指向的本机项目已经没有了。 */
    localProjectMissing: "本机项目记录不存在",
    requirementUnavailable: "需求不可用",
  },

  /** 房间端点（转发到需求服务）的本机校验。 */
  rooms: {
    uploadNotMultipart: "房间文件上传必须使用 multipart/form-data",
    uploadStreamInvalid: "房间文件上传流无效",
    bodyNotObject: "请求体必须是 JSON object",
  },
};
