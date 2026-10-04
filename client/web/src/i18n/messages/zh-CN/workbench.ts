/** 会话工作台：输入框、审批档切换、检查面板（改动 / 需求 / 环境）、文件查看器、打开方式菜单、上传的本地报错。 */
export const workbench = {
  composer: {
    messageLabel: "给 Codex 的消息",
    placeholder: {
      default: "描述要交给 Codex 的工作；/ 选 skill，@ 引用文件",
      withSkill: (skill: string) => `已选 ${skill}，补充说明后发送…`,
      running: "正在工作：Enter 并入这一轮，Tab 排到之后",
    },
    /** 拖入、粘贴了图片以外的文件。 */
    imagesOnly: "目前仅支持拖入/粘贴图片；其他文件请用 @ 引用项目内路径。",
    dropImages: "松开以把图片加入本条消息",
    /** 「/」与「@」触发的选择面板。 */
    palette: {
      label: "选择候选",
      skillTitle: "选择 skill",
      fileTitle: "引用项目文件",
      keys: "↑↓ 选择 · Enter 确认 · Esc 关闭",
      indexing: "正在索引项目文件…",
      indexFailed: "索引失败，稍后重试",
      noSkills: "没有可用的 skill：把 skill 放进项目 .codex/skills/ 或用户目录 .codex/skills/ 后刷新",
      noMatches: "没有匹配项",
      truncated: "文件太多，仅索引前 8000 个",
    },
    /** 不在项目目录里的 skill（用户目录下的）。 */
    globalSkill: "全局",
    removeSkill: "移除 skill",
    image: "图片",
    imageWithSize: (size: string) => `图片 · ${size}`,
    removeImage: "移除图片",
    attachImage: "添加图片（也可以直接粘贴或拖进来）",
    queue: "排队",
    queueTitle: "排进队列，这一轮结束后自动发出（Tab）",
    stop: "停止",
    stopTitle: "停止这一轮（输入框为空时按 Esc）",
    stopLabel: "停止这一轮",
    stopping: "正在停止…",
    stoppingTitle: "停止中…",
    stoppingLabel: "停止中",
    send: "发送",
    sendTitle: "发送（Enter）",
    /** 上下文用量环。 */
    context: {
      used: "上下文已用",
      title: (percent: number, used: string, limit: string) =>
        `上下文已用 ${String(percent)}%（${used} / ${limit}）。接近上限时 Codex 会自动压缩较早的对话。`,
    },
    /** 输入框上方的运行状态行。 */
    run: {
      working: "Codex 正在工作",
      running: "运行中",
      waiting: (count: number) => `等你确认 · ${String(count)} 项`,
      review: "去看看",
    },
    /** 输入框上方的排队面板。 */
    queuePanel: {
      title: (count: number) => `排队 ${count > 0 ? String(count) : ""}`,
      scope: "仅本标签页有效 · 这一轮结束后自动发出队首一条",
      paused: (reason: string) => `已暂停 · ${reason}`,
      /** 暂停原因，键是 `session/queue.ts` 的 PausedReason。 */
      pausedReasons: {
        user_stop: "你点了停止",
        turn_failed: "上一轮失败了",
        turn_interrupted: "上一轮被中断了",
        send_rejected: "发送失败，已放回队首",
        send_uncertain: "这一条发没发出去还不确定",
        attribution_unconfirmed: "这一条去了哪儿还没确认",
        restored: "刷新或切回会话后，需要你确认继续",
      },
      resume: "恢复",
      editLabel: "编辑排队的消息",
      save: "保存",
      cancel: "取消",
      unconfirmed: "待核对",
      noText: "（无文本）",
      edit: "编辑",
      take: "取回",
      remove: "删除",
    },
  },
  /** 输入框底栏的审批档切换器；档位名用设置里的词表 `settingsAgent.execution.modes`。 */
  approvalMode: {
    title: "审批档（本会话，切换后下个回合生效）",
    menuLabel: "审批档 · 本会话 · 下个回合生效",
    descriptions: {
      ask: "每一步写文件、执行命令都需要你批准（最稳）",
      auto: "项目目录内直接执行，越界操作才询问（推荐日常）",
      full: "不设限、不询问，Codex 可访问本机任意文件与网络",
    },
    lockedReason: "本机部署设置了审批上限，不能选择完全访问；需要的话请联系管理员。",
    locked: "已被部署上限锁定，请联系管理员",
    fullConfirm: {
      title: "切换到完全访问？",
      description: "这个会话将不再弹出任何审批，Codex 可以不受限制地访问本机文件与网络。下个回合生效。",
      confirm: "切换到完全访问",
    },
  },
  /** 检查面板的框架。 */
  inspector: {
    label: "检查面板",
    tabs: {
      changes: "改动",
      requirement: "需求",
      env: "环境",
      files: "文件",
    },
    collapse: "收起检查面板",
    collapseTitle: "收起检查面板（⌘J）",
  },
  /** 检查面板「改动」标签。 */
  changes: {
    emptyTitle: "还没有改动",
    emptyDescription: "Codex 新建、修改或删除文件后会列在这里，点开可以看改动对比。",
    summary: (count: number) => `相对会话开始前 · ${String(count)} 个文件`,
    /** 分组标题，也是文件查看器头部的标记。 */
    kind: {
      created: "新建",
      modified: "修改",
      deleted: "删除",
    },
    /** 列表每行前的短标记。 */
    tag: {
      created: "新增",
      modified: "修改",
      deleted: "删除",
    },
  },
  /** 检查面板「环境」标签：改动量、目录、分支、检查点。 */
  env: {
    label: "环境",
    changes: "改动",
    files: (count: number) => `${String(count)} 个文件`,
    noChanges: "暂无",
    folder: "目录",
    /** 取不到目录名时的称呼。 */
    folderFallback: "本机项目",
    open: "打开",
    branch: "分支",
    detached: "（游离）",
    uncommitted: (count: number) => `${String(count)} 处未提交`,
    clean: "干净",
    versionControl: "版本管理",
    noGit: "本机没有可用的 Git",
    initHint: "这个目录还没有版本管理。初始化后，每一轮开始前会自动存档，改坏了可以一键回到之前。",
    init: "初始化版本管理",
    checkpoints: {
      heading: "检查点",
      save: "保存检查点",
      saveTitle: "把当前文件状态存为检查点",
      /** 运行中保存检查点的告知文案（ADR-0004：告知后继续）。 */
      runningNote: "这一轮还在跑，现在存的快照可能不包含正在写入的改动",
      nothingToSave: "当前没有需要保存的改动",
      empty: "还没有检查点。",
      history: (count: number) => `历史（${String(count)}）`,
      latest: "最新检查点",
      item: "检查点",
      restore: "还原",
      restoreTitle: "还原到此检查点",
      /** 运行中不可还原的原因（ADR-0004 不可逆字节损失红线；后续提交可从 reflog 找回，所以不说「无法撤回」）。 */
      restoreRunning: "回合进行中不可还原：会以检查点覆盖 Codex 正在写入的文件，可能丢失未提交改动",
      autoSave: "回合前自动存档",
      autoSaveFailed: (error: string) => `上次自动存档失败：${error}`,
    },
    restoreConfirm: {
      title: "还原到这个检查点？",
      description: (checkpoint: string, time: string, hasRemote: boolean) =>
        `项目文件会恢复到「${checkpoint} · ${time}」时的状态，这之后新建的文件会被移走（.gitignore 里的除外）。还原前会先自动存一份当前状态（包括新建的文件），需要时可以再还原回来。${
          hasRemote ? "这个仓库配置了远端，相关提交如果已经推送，请谨慎操作。" : ""
        }`,
      confirm: "还原",
    },
  },
  /** 检查面板「需求」标签：关联需求的概要与附件。 */
  requirement: {
    loading: "正在读取关联需求…",
    loadFailed: (message: string) => `查不到关联需求：${message}`,
    projectSession: "这是项目会话，没有关联具体需求。",
    notLinked: "本会话没有关联需求。",
    titleLoading: "正在读取需求…",
    titleFallback: "这条需求",
    /** 版本一行：「开工时第 2 版，」+「现在第 4 版」/ 读取中 / 查不到 +（改过时）「 · 开工后需求改过」。 */
    startVersion: (version: number) => `开工时第 ${String(version)} 版，`,
    currentVersion: (version: number) => `现在第 ${String(version)} 版`,
    currentVersionLoading: "现在的版本正在读取…",
    currentVersionUnavailable: "现在的版本查不到",
    changedSinceStart: " · 开工后需求改过",
    detailFailed: (message: string) => `查不到需求详情：${message}`,
    openPage: "在需求页打开",
    attachments: "附件",
    attachmentsLoading: "正在读取附件…",
    attachmentsFailed: (message: string) => `查不到附件：${message}`,
    noAttachments: "这条需求没有附件",
    viewInNewTab: (fileName: string) => `在新标签页查看「${fileName}」`,
    download: (fileName: string) => `下载「${fileName}」`,
    retry: "重试",
  },
  /** 检查面板里的文件查看器。 */
  viewer: {
    label: "文件详情",
    back: "返回",
    backTitle: "返回（Esc）",
    preview: "预览",
    file: "文件",
    loading: "正在加载查看器…",
    diffSummaryOnly: "二进制或超大文件只显示摘要。",
    noPatch: "没有可显示的改动内容。",
    unsupportedTitle: "这种文件没法在工作台里预览",
    unsupportedHint: "Word 等文件请用系统默认应用打开查看。",
    fallbackTitle: "没法在工作台里预览",
    csvTruncated: "文件较大，只解析了开头部分——完整内容请用系统应用打开。",
    textTruncated: "文件较大，只显示开头部分——完整内容请用系统应用打开。",
    markdownAsText: "文档较大，已按纯文本显示以保证流畅。",
  },
  /** 表格预览（CSV / xlsx）。 */
  table: {
    parsing: "正在解析表格…",
    parseFailed: "表格解析失败，请「用系统应用打开」查看完整内容。",
    sheets: "工作表",
    empty: "表格为空。",
    truncated: (rows: number, columns: number) =>
      `仅显示前 ${String(rows)} 行 / ${String(columns)} 列 —— 完整内容请「用系统应用打开」。`,
  },
  /** 「用…打开」下拉，键是 SystemOpenTarget。 */
  openMenu: {
    label: "打开位置",
    targets: {
      open: "系统默认应用",
      reveal: "文件管理器",
      vscode: "VS Code",
      terminal: "终端",
    },
  },
  /** 上传在本地就失败时的说明（`api/client.ts`）。 */
  upload: {
    tooLarge: "文件超过 300 MB，无法上传",
    fileInterrupted: "文件上传连接中断",
    fileCancelled: "文件上传已取消",
    attachmentInterrupted: "附件上传连接中断",
    attachmentCancelled: "附件上传已取消",
    cancelled: "上传已取消",
  },
};
