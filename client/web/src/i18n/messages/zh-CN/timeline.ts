import type { SuDuoToolName } from "@suduo/client-contracts";

/** 会话事件 → 时间线的投影（event-projection/）里的文字：步骤标题、审批、错误与提示、SuDuo 工具卡。 */
export const timeline = {
  /** 并列的几项（路径、附件 ID、权限范围）连成一串。 */
  joinList: (items: readonly string[]) => items.join("、"),
  /** 时间线上的步骤标题：动作短语。 */
  step: {
    run: (command: string) => `运行 ${command}`,
    runCommand: "运行命令",
    read: (name: string) => `查看 ${name}`,
    readFiles: (count: number) => `查看 ${String(count)} 个文件`,
    search: (query: string) => `搜索「${query}」`,
    searchCode: "搜索代码",
    listPath: (path: string) => `列出 ${path}`,
    listFiles: "列出文件",
    thinking: "思考",
    thinkingAbout: (heading: string) => `思考：${heading}`,
    callMcpTool: (server: string, tool: string) => `调用 ${server} · ${tool}`,
    callTool: (tool: string) => `调用 ${tool}`,
    callUnnamedTool: "调用工具",
    webSearch: (query: string) => `搜索网页「${query}」`,
    webSearchAny: "搜索网页",
    viewImage: (name: string) => `查看图片 ${name}`,
    contextCompaction: "压缩了较早的对话，腾出上下文空间",
    enterReview: "进入代码审查",
    exitReview: "结束代码审查",
    sleep: "等待",
    generateImage: "生成图片",
    collabAgent: "协作代理",
    toolCall: "工具调用",
  },
  /** 过程卡（reducer.ts 的 TurnGroup）上的步骤：思考与其他工具沿用 step 的说法。 */
  process: {
    command: "执行命令",
    file: "更新文件",
  },
  /** 用户消息里的图片附件没有 ID 时的名字。 */
  imageAttachment: "图片",
  approval: {
    files: (count: number) => `${String(count)} 个文件`,
    /** 没有具体对象时只说动作。 */
    action: {
      command: "运行命令",
      stdin: "向正在运行的命令输入内容",
      fileChange: "修改文件",
      permissions: "变更权限",
      other: "继续",
    },
    subject: {
      command: (command: string) => `运行 ${command}`,
      stdin: (command: string) => `向 ${command} 输入内容`,
      fileChange: (target: string) => `修改 ${target}`,
      permissions: (scopes: readonly string[]) => `变更权限（${scopes.join("、")}）`,
    },
    state: {
      waiting: (what: string) => `等你确认：${what}`,
      accepted: (what: string) => `已批准：${what}`,
      acceptedForSession: (what: string) => `已批准（本会话同类不再询问）：${what}`,
      declined: (what: string) => `已拒绝：${what}`,
      cancelled: (what: string) => `已拒绝并中断：${what}`,
      deliveryFailed: (what: string) => `审批没能送达：${what}`,
      expired: (what: string) => `审批已失效：${what}`,
    },
  },
  /** 权限审批的范围，每项一行：「写入 /work/out」「联网」。 */
  permission: {
    read: "读取",
    write: "写入",
    deny: "禁止访问",
    network: "联网",
  },
  notice: {
    runtimeRecovered: "运行时连接已恢复，可以继续工作",
    /** SuDuo 写进账本的提示，按 payload.code 渲染（契约 RuntimeNoticeCode）。 */
    threadRebuilt:
      "该会话的历史执行上下文无法恢复，已自动重建线程继续。此前对话内容 AI 已不记得，但对话记录与文件改动都完整保留。",
    connectionRebuilt: "Codex 连接已断开并自动重建，进行中的回合可能中断。",
    /** Codex 发来 SuDuo 还不支持的请求（code unsupported-request），按请求方法分三种说法。 */
    unsupportedQuestion: "Codex 想请你回答一个问题，SuDuo 暂时不支持在这里作答，已跳过；Codex 会接着往下做。",
    unsupportedElicitation:
      "Codex 想请你确认一个 MCP 工具的操作，SuDuo 暂时不支持这种确认，已替你拒绝；Codex 会换个做法继续。",
    unsupportedRequest: "Codex 发来一个 SuDuo 暂时不支持的请求，已跳过；Codex 会接着往下做。",
    /** 共享 Agent 任务的执行过程太长、中间省略了一段（code room-run-events-truncated）。 */
    runEventsTruncated: (omitted: number) =>
      `执行过程太长，中间省略了 ${String(omitted)} 条记录（保留了开头和结尾）。完整过程在所有者本机的房间任务会话里。`,
    skillsBudget:
      "可用 skill 较多，描述已按 Codex 的上下文预算自动缩短——每个 skill 仍可正常选用；在设置里停用不常用的 skill 可让描述更完整。",
    unknownModel:
      "当前模型不在 Codex 的内置模型清单里，Codex 按默认参数运行：上下文约 27 万（设置里调小过则按设置），所选推理强度不会发给模型服务，部分工具不可用。在 Codex 配置里给这个模型补上模型清单信息后，这条提示会消失。",
    serviceTier: "模型服务未声明支持所配置的 service tier，本次请求已自动忽略该参数，不影响使用。",
    websocketFallback: "用 WebSocket 连接模型服务没有成功，已改用 HTTPS 连接。",
    ignoredConfig: (count: number, keys: readonly string[], more: boolean) =>
      `Codex 忽略了 ${String(count)} 个不认识的配置项（可能拼错了，或是新版已不再支持）${
        keys.length > 0 ? `：${keys.join("、")}${more ? " 等" : ""}` : ""
      }。不影响使用；在 Codex 配置里删掉或改正即可消除这条提示。`,
    bubblewrapMissing:
      "这台机器没装 bubblewrap，Codex 暂时用自带的沙箱组件。按 OpenAI 的说明安装 bubblewrap（Ubuntu / Debian：sudo apt install bubblewrap；Ubuntu 24.04 还要加载官方的 AppArmor 配置），处理办法见「设置 → 诊断」的「命令沙箱」一项。",
    userNamespaces:
      "Codex 的 Linux 沙箱建不了用户命名空间，需要审批或受限执行的命令会失败。处理办法见「设置 → 诊断」的「命令沙箱」一项。",
  },
  error: {
    /** 按 HTTP 状态 / 错误文字认出的回合失败原因：text 是完整说明，brief 是重连提示里只说原因的那一句。 */
    turn: {
      rateLimited: {
        text: "模型服务限流（429），已自动重试仍失败。请稍等几分钟再发送；若持续出现请联系管理员检查配额。",
        brief: "模型服务限流（429），已自动重试仍失败",
      },
      unauthorized: {
        text: "模型服务认证失败（401）。请在设置的模型服务里检查凭证，或联系管理员重新配置。",
        brief: "模型服务认证失败（401）",
      },
      forbidden: {
        text: "模型服务拒绝了请求（403），当前凭证可能没有权限使用这个模型。",
        brief: "模型服务拒绝了请求（403），当前凭证可能没有权限使用这个模型",
      },
      serverError: {
        text: "模型服务暂时出错，请稍后重试。",
        brief: "模型服务暂时出错，请稍后重试",
      },
      timeout: {
        text: "模型服务响应超时，请稍后重试。",
        brief: "模型服务响应超时，请稍后重试",
      },
    },
    unknown: "本回合执行失败，原因未知。",
    waitingForNetwork: "和模型服务的连接断了，正在等网络恢复后重连…",
    connectionLost: "和模型服务的连接中断了",
    reconnecting: (reason: string, attempt: number, max: number) =>
      `${reason}，正在重连（第 ${String(attempt)}/${String(max)} 次）…`,
    /** reason 是已经说成人话的原因（或认不出时 Codex 的原文），句末标点去掉再接。 */
    retrying: (reason: string) => `${reason.replace(/[。.]$/, "")}，正在自动重试…`,
    noResponseRetrying: "模型服务暂时没有响应，正在自动重试…",
    /** 字符串形式的 codexErrorInfo（Codex 协议 `CodexErrorInfo` 的无参分支），键是 Codex 的取值。 */
    codex: {
      contextWindowExceeded: "这段对话已经超出模型的上下文窗口。可以新开一个会话，或让 Codex 先总结再继续。",
      usageLimitExceeded: "模型用量已经到上限，请稍后再试，或联系管理员调整额度。",
      unauthorized: "模型服务认证失败（401）。请在设置的模型服务里检查凭证，或联系管理员重新配置。",
      serverOverloaded: "模型服务现在很忙，请稍等一会儿再试。",
      internalServerError: "模型服务暂时出错，请稍后重试。",
      badRequest: "模型服务拒绝了这次请求，可能是参数或附件不被支持。",
      sandboxError: "命令没能在沙箱里运行。可以检查审批档与项目目录的权限设置。",
      rateLimitExceeded: "模型服务限流了，请稍等几分钟再发送。",
      flexUnavailable: "模型服务当前的处理档位暂时不可用，请稍后重试。",
      misalignmentPolicyViolation: "这次请求触发了模型服务的安全策略，本回合已停止。可以换个说法再试。",
      tooManyDenials: "被拒绝的操作太多，本回合已停止。可以调整审批方式或换个做法再试。",
      sessionBudgetExceeded: "这个会话的用量预算已经用完。可以新开一个会话继续。",
      cyberPolicy: "请求涉及网络安全相关内容，被模型服务的安全策略拦下了。",
      threadRollbackFailed: "回退对话没有成功，请重试。",
    },
  },
  /** 会话里的 SuDuo 工具（ADR-0008）：时间线上的工具步骤与审批坞的确认卡。 */
  suDuoTool: {
    /** 需求工具的动作名，键是工具名（标识符不译）。 */
    labels: {
      suduo_requirement_get: "查看需求",
      suduo_requirement_comments: "查看评论",
      suduo_requirement_attachments: "查看附件清单",
      suduo_attachment_view: "查看附件",
      suduo_artifact_versions: "查看确认版",
      suduo_artifact_fetch: "拉取确认版",
      suduo_notes_read: "读取结论笔记",
      suduo_notes_save: "更新结论笔记",
      suduo_comment_submit: "发评论",
      suduo_artifact_publish: "发布确认版",
    } satisfies Record<SuDuoToolName, string>,
    /** 跨会话读取（多 Agent 协作 S7）的动作名；读取步骤另按会话信息显示（sessionLinks.read）。 */
    sessionLabels: {
      suduo_session_list: "列出可读的会话",
      suduo_session_read: "读取会话",
    },
    /** 房间共享 Agent 的房间工具（只读）的动作名。 */
    roomLabels: {
      suduo_room_history: "翻看房间消息",
      suduo_room_search: "搜索房间消息",
      suduo_room_file_view: "查看房间文件",
    },
    commentOn: (target: string) => `发评论到 ${target}`,
    publishTo: (target: string) => `发布确认版到 ${target}`,
    requirement: {
      codeAndTitle: (code: string, title: string) => `${code}「${title}」`,
      title: (title: string) => `「${title}」`,
      unnamed: "这条需求",
    },
    duplicatePending: (at: string) => `本会话还有一张相同内容的确认卡（${at}）`,
    duplicateSent: (at: string) => `本会话 ${at} 已发过相同内容`,
    attachments: (ids: readonly string[]) => `附件 ${ids.join("、")}`,
    version: (version: number) => `第 ${String(version)} 版`,
    quote: (text: string) => `「${text}」`,
    imageOutput: "（图片）",
  },
};
