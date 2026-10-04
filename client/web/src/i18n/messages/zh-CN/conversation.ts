import type { ReactNode } from "react";

/**
 * 会话（需求 §4.5）：会话列表与会话页、会话头、模型与推理强度、审批坞、消息流（回合、过程卡、用户消息）、
 * 状态行、完成提醒。会话事件投影出来的步骤标题在 timeline 分区，会话状态名在 feedback 分区，
 * 输入框与排队面板（含排队暂停原因）在 workbench 分区。
 */
export const conversation = {
  /** 会话标题为空时的显示名。 */
  untitled: "未命名会话",
  /** 会话列表栏。 */
  list: {
    label: "会话列表",
    title: "会话",
    create: "新建",
    searchLabel: "搜索会话",
    searchPlaceholder: "搜索标题、需求编号或内容",
    clearSearch: "清除搜索",
    filtersLabel: "筛选会话",
    filters: {
      all: "全部",
      running: "运行中",
      runningCount: (count: number) => `运行中 ${String(count)}`,
      needsMe: "需要我",
      needsMeCount: (count: number) => `需要我 ${String(count)}`,
      roomTasks: "房间任务",
    },
    loading: "正在加载会话",
    empty: {
      roomTasks: {
        title: "这个项目还没有房间任务",
        description: "你共享到这个项目讨论里的 Codex 被同事 @ 后，它在你电脑上执行的任务会列在这里，可以随时查看或停止。",
      },
      sessions: {
        title: "这个项目还没有会话",
        description: "在需求页从某个需求开始会话，或者新建一个项目会话。别的项目的会话在左上角切换项目后查看。",
      },
      noMatch: (keyword: string) => `没有找到「${keyword}」`,
      noMatchHint: "换个关键词，或按需求编号搜索，例如 REQ-12。",
      noRunning: "没有正在运行的会话",
      noNeedsMe: "没有需要你处理的会话",
      filterHint: "切到「全部」看看所有会话。",
    },
    loadMore: "加载更早的会话",
    /** 按最后活动分组：今天、昨天用 common.time，其余归「更早」。 */
    earlier: "更早",
    row: {
      /** 最后一句是你说的时，前面加的称呼。 */
      previewFromYou: "你：",
      renameLabel: "会话名称",
      moreActions: (title: string) => `会话「${title}」的更多操作`,
      rename: "重命名",
      openInRoom: "在讨论里查看",
      archive: "归档",
      delete: "删除…",
    },
  },
  /** 会话页：列表上的操作反馈、没选会话时的占位、删除确认。 */
  page: {
    regionLabel: "会话区",
    renameFailed: "没能重命名",
    archived: (title: string) => `已归档「${title}」`,
    undo: "撤销",
    undoArchiveFailed: "没能撤销归档",
    archiveFailed: "没能归档",
    deleted: (title: string) => `已删除「${title}」`,
    deleteFailed: "没能删除",
    listFailed: (message: string) => `没能读取会话列表：${message}`,
    createDisabled: {
      noProject: "还没有项目：先在左上角新建一个项目",
      archivedProject: "当前项目已归档，不能新建会话",
    },
    placeholder: {
      title: "选一个会话继续",
      description: "从左侧列表打开会话；也可以在需求页从某个需求开始会话，或者新建一个项目会话。按 ⌘B 收起或展开列表。",
    },
    deleteConfirm: {
      title: (title: string) => `删除会话「${title}」？`,
      description: "删除后对话记录不能恢复；项目文件和检查点不受影响。",
      confirm: "删除",
    },
  },
  /** 会话头。 */
  header: {
    titleLabel: "会话标题",
    rename: "重命名会话",
    requirementHint: "关联需求：在检查面板查看",
    requirementFallback: "关联需求",
    noticesLabel: (count: number) => `运行提示 ${String(count)} 条`,
    noticesTitle: "运行提示",
    openInspector: "打开检查面板",
    closeInspector: "收起检查面板",
    inspector: "检查面板",
  },
  /** 输入框底栏的模型与推理强度（本会话）。档位名在 sessions.effort。 */
  model: {
    defaultModel: "默认模型",
    defaultEffort: "默认",
    chipTitle: "模型与推理强度（本会话，下个回合生效）",
    menuLabel: "本会话 · 下个回合生效",
    model: "模型",
    effort: "推理强度",
    followDefault: "跟随默认",
    loading: "正在获取可用模型…",
    loadFailed: "没能取到模型列表，可以到设置里配置模型服务",
    isDefault: "默认",
    openSettings: "全局默认与模型服务设置…",
  },
  /** 审批坞：普通审批与 SuDuo 写工具的确认卡。 */
  approval: {
    label: "等你确认",
    question: {
      command: "Codex 想运行命令",
      fileChange: "Codex 想修改文件",
      permissions: "Codex 想变更权限",
      other: "Codex 请你确认后继续",
      /** 命令审批里向已在运行的命令（终端）输入内容。 */
      stdin: "Codex 想向正在运行的命令输入内容",
    },
    editFiles: (count: number) => `Codex 想修改 ${String(count)} 个文件`,
    /** 多个待确认时：眼下处理的总是第 1 个。 */
    position: (total: number) => `第 1 个，共 ${String(total)} 个`,
    cwd: (cwd: string) => `在 ${cwd}`,
    viewPatch: (path: string) => `查看 ${path} 的改动`,
    /** 审批卡获焦时的按键提示，两个按键是渲染好的组件。 */
    keyHint: (keys: { approve: ReactNode; decline: ReactNode }): ReactNode[] => [keys.approve, " 批准 · ", keys.decline, " 拒绝"],
    approve: "批准",
    decline: "拒绝",
    moreOptions: "更多批准选项",
    acceptForSession: {
      title: "本会话都允许",
      description: "同类操作不再询问",
    },
    cancel: {
      title: "拒绝并中断",
      description: "停止 Codex 当前这一轮",
    },
    /** 发评论、发布确认版的确认卡：对外且不能撤回，只能点按钮确认。 */
    tool: {
      noFiles: "没有列出要发布的文件。",
      unknownSize: "大小未知",
      noNote: "没有填写发布说明。",
      note: "发布说明",
      sending: "正在发出…",
      publishing: "正在发布…",
      sendWarning: "发出后不能撤回",
      publishWarning: "发布后全组可见，不能撤回",
      send: "发出",
      dontSend: "不发",
      publish: "发布",
      dontPublish: "不发布",
    },
  },
  /** 消息流。 */
  stream: {
    loadingHistory: "正在加载更早的记录…",
    newContent: "有新内容",
  },
  /** 一个回合：过程卡、改动卡、计划、错误卡与结束摘要旁的操作。 */
  turn: {
    truncatedHead: "更早的过程记录不在本机缓存里，这一轮只显示后半段。",
    thinking: "思考中…",
    waiting: "等你确认",
    exitCode: (code: number) => `退出码 ${String(code)}`,
    unfinished: "未完成",
    /** 步骤输出太长时只显示末尾。 */
    outputTruncated: (count: number) => `…（只显示最后 ${String(count)} 个字符）`,
    stepStatus: {
      waiting: "等你确认",
      completed: "完成",
      failed: "失败",
      declined: "已拒绝",
      aborted: "已停止",
    },
    changes: {
      writing: "正在修改文件…",
      /** 改动卡标题：按状态说这些文件怎样了。 */
      title: {
        declined: (count: number) => `改动已被拒绝 ${String(count)} 个文件`,
        failed: (count: number) => `改动没能写入 ${String(count)} 个文件`,
        aborted: (count: number) => `改动没有完成 ${String(count)} 个文件`,
        running: (count: number) => `正在修改 ${String(count)} 个文件`,
        done: (count: number) => `修改了 ${String(count)} 个文件`,
      },
      viewInInspector: (path: string) => `在检查面板查看 ${path} 的改动`,
      kind: {
        add: "新增",
        delete: "删除",
        update: "修改",
      },
    },
    plan: {
      label: "计划",
      completed: "已完成",
      inProgress: "进行中",
      pending: "待做",
    },
    error: {
      title: "这一轮没能完成",
      retry: "重试",
      retried: "已重新发送",
    },
    viewChanges: "查看改动",
    restoreBefore: "回到开始前",
  },
  /** 一句话摘要：步骤组折叠后一行、回合结束一行，各段用「 · 」连起来。 */
  summary: {
    read: (count: number) => `查看了 ${String(count)} 个文件`,
    search: (count: number) => `搜索了 ${String(count)} 次`,
    list: (count: number) => `列了 ${String(count)} 个目录`,
    command: (count: number) => `运行了 ${String(count)} 条命令`,
    tool: (count: number) => `调用了 ${String(count)} 次工具`,
    web: (count: number) => `搜索了 ${String(count)} 次网页`,
    approval: (count: number) => `确认了 ${String(count)} 次`,
    /** 一组里全是思考时。 */
    thinking: "思考",
    steps: (count: number) => `${String(count)} 个步骤`,
    /** 连续几条空思考合成的一行。 */
    thinkingRepeated: (count: number) => `思考 ×${String(count)}`,
    outcome: {
      running: "进行中",
      completed: "完成",
      interrupted: "已停止",
      failed: "失败",
      partial: "记录不完整",
    },
    duration: (duration: string) => `用时 ${duration}`,
    filesChanged: (count: number) => `修改 ${String(count)} 个文件`,
    commands: (count: number) => `运行 ${String(count)} 条命令`,
  },
  /**
   * 用户消息的归属（需求 R3 / R4），键是归属值：只说能证实的那一种。
   * 「已并入当前工作」的说明必须原样是「已记入当前正在跑的这一轮」，不得出现「会送到」一类的表述。
   */
  message: {
    attribution: {
      submitted: "已提交",
      merged: "已并入当前工作",
      "new-turn": "已作为新一轮",
    },
    mergedNote: "已记入当前正在跑的这一轮",
    /** 归属后面括注说明。 */
    mergedSuffix: (note: string) => `（${note}）`,
    interruptedNote: "这一轮被中断，这条可能没被处理到",
    imageAttachment: "图片附件",
  },
  /** 输入框上方的状态行：当前步骤说成人话（按步骤类型说，不看标题文字）。 */
  status: {
    command: "正在执行命令",
    commandWith: (detail: string) => `正在执行 ${detail}`,
    file: "正在更新文件",
    fileWith: (detail: string) => `正在更新 ${detail}`,
    thinking: "正在思考",
    tool: (title: string) => `正在调用 ${title}`,
    toolWith: (title: string, detail: string) => `正在调用 ${title} · ${detail}`,
  },
  /** 会话在后台完成、失败或等你确认时：标题前缀与系统通知。 */
  attention: {
    title: {
      completed: "已完成",
      approval: "等你确认",
      error: "没能完成",
    },
    /** 会话还没取到标题时，通知里用的名字。 */
    fallbackSession: "会话",
    body: {
      completed: "这一轮已经完成。",
      approval: "Codex 在等你确认后继续。",
      error: "这一轮没能完成，回到会话看看原因。",
    },
  },
  /** 会话画布（SessionRuntime）：提示、还原确认、检查面板、旧版与房间任务会话的说明、空会话。 */
  runtime: {
    conversationLabel: "对话",
    inspectorLabel: "检查面板",
    opening: "正在打开…",
    recovered: "会话已恢复，可继续工作；进行中回合可能中断，历史进度已自动补齐。",
    noCheckpoint: "这一轮开始前没有检查点，没法一键回到开始前。可以在检查面板的「环境」里看看有哪些检查点。",
    restored: "已回到这一轮开始前",
    outsideProject: (path: string) => `这个文件不在项目目录里，没法在检查面板里看改动：${path}`,
    retryMissing: "找不到这一轮最初发送的内容，请在输入框里重新发送。",
    restore: {
      title: "回到这一轮开始前？",
      ownAuto: (clock: string) => `项目文件会恢复到这一轮开始前自动存档时（${clock}）的状态。`,
      /** subject 是检查点提交的标题（写入时的原文）。 */
      nearest: (subject: string, clock: string) =>
        `这一轮开始前没有它自己的自动存档；最近的是「${subject}」（${clock}），还原到它可能连带撤掉更早几轮的改动。`,
      /** lead 是上面两句之一。 */
      description: (lead: string) => `${lead}还原前会先自动存一份当前状态（包括新建的文件），需要时可以在检查面板的「环境」里还原回来。`,
      confirm: "回到开始前",
    },
    /** 在检查面板里看还没写入的改动时的标签。 */
    pendingPatch: "待确认",
    stopMismatch: {
      text: "刚才那一轮已经结束，现在在跑的是新的一轮。",
      stopCurrent: "停止当前这一轮",
      dismiss: "知道了",
    },
    dismissError: "关闭提示",
    fileTree: {
      label: "项目文件",
      empty: "当前目录为空。",
      emptyDirectory: "空目录",
    },
    legacy: {
      text: "这是旧版需求会话：需求信息不会再自动更新。新建会话即可用工具直接查看需求、评论和附件。",
      back: "回到需求",
    },
    roomTask: {
      text: "这是房间任务会话：由房间里的 @ 触发，回答会发回房间。这里只读；要私下追问请新开会话。",
      openInRoom: "在讨论里查看",
    },
    empty: {
      title: "准备好了",
      /** 两个按键（/ 与 @）是渲染好的组件。 */
      description: (keys: { skill: ReactNode; file: ReactNode }): ReactNode[] => [
        "直接描述要交给 Codex 的工作；输入 ",
        keys.skill,
        " 选择 skill，",
        keys.file,
        " 引用项目文件。",
      ],
    },
  },
};
