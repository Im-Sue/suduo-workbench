export const requirements = {
  /** 需求页顶栏与工具栏（看板 / 列表 + 速览）。 */
  page: {
    title: "需求",
    /** 标题旁的条数；还有下一页时带「+」。 */
    total: (count: number, more: boolean) => `${String(count)}${more ? "+" : ""} 条`,
    view: "视图",
    viewBoard: "看板",
    viewList: "列表",
    reconnecting: "实时更新已断开，正在重连…",
    moreActions: "更多操作",
    projectSettings: "项目设置",
    create: "新建需求",
    searchLabel: "搜索需求",
    searchPlaceholder: "搜索标题或编号",
    clearSearch: "清除搜索",
    clearFilters: "清除筛选",
  },
  /** 工具栏上的状态 / 负责人筛选。 */
  filter: {
    status: "状态",
    statusValue: (label: string) => `状态：${label}`,
    allStatuses: "显示全部状态",
    assignee: "负责人",
    assigneeValue: (label: string) => `负责人：${label}`,
    mine: "我负责的",
    /** 按成员筛选、但成员列表还没取到名字时。 */
    someone: "指定成员",
    anyAssignee: "不按负责人筛选",
    priority: "优先级",
    /** 选中的档位用顿号连起来，如「优先级：紧急、高」。 */
    priorityValue: (labels: readonly string[]) => `优先级：${labels.join("、")}`,
    anyPriority: "不按优先级筛选",
  },
  /** 看板每列、列表每组内的排序方式（记在本机）。 */
  sort: {
    label: "排序方式",
    value: (label: string) => `排序：${label}`,
    priority: "优先级",
    updated: "最近更新",
  },
  /** 筛选或搜索后一条都没有。 */
  noResult: {
    filteredTitle: "没有符合条件的需求",
    filteredDescription: "换个筛选条件试试。",
    searchTitle: (query: string) => `没有找到「${query}」`,
    searchDescription: "换个关键词，或按编号搜索，例如 REQ-128",
  },
  /** 链接里的速览编号找不到或打不开。 */
  peekMissing: {
    /** 编号不是数字时，原样加引号显示。 */
    quoted: (ref: string) => `「${ref}」`,
    notFound: (label: string) => `找不到 ${label}`,
    notFoundDetail: "它可能不在这个项目里，或者编号写错了。",
    failed: (label: string) => `没能打开 ${label}`,
    failedDetail: "可能是网络或服务暂时不可用。",
  },
  /** 看板列与列表分组共用。 */
  column: {
    empty: "暂无",
    loadMore: "加载更多",
    createIn: (label: string) => `在「${label}」新建需求`,
    loadFailed: (label: string, message: string) => `没能加载「${label}」：${message}`,
  },
  board: {
    region: "需求看板",
    dragInstructions: "按 1 到 7 可直接修改状态。",
    /** 拖动卡片时读屏的播报。 */
    drag: {
      /** 拿不到卡片数据时的泛称。 */
      fallbackItem: "需求",
      pickedUp: (item: string) => `已拿起 ${item}`,
      overNone: "不在任何列上",
      over: (column: string) => `移到「${column}」上方`,
      droppedUnchanged: (item: string) => `已放下 ${item}，状态未变`,
      moved: (item: string, column: string) => `已把 ${item} 移到「${column}」`,
      cancelled: (item: string) => `已取消移动 ${item}`,
    },
  },
  list: {
    region: "需求列表",
    header: {
      number: "编号",
      title: "标题",
      priority: "优先级",
      assignee: "负责人",
      counts: "附件 · 评论 · 会话",
      updated: "更新",
    },
  },
  /** 看板卡片。 */
  card: {
    description: (status: string, assignee: string, priority: string | null = null) =>
      `${status}${priority === null ? "" : ` · 优先级 ${priority}`} · 负责人 ${assignee} · 按 1–7 修改状态`,
    attachments: (count: number) => `${String(count)} 个附件`,
    comments: (count: number) => `${String(count)} 条评论`,
    localSessions: (count: number) => `本机有 ${String(count)} 个会话`,
  },
  /** 负责人选择菜单，以及各处显示负责人的地方。 */
  assignee: {
    unassigned: "未指派",
    search: "搜索成员",
    loading: "正在加载成员…",
    loadFailed: "没能加载成员列表",
    empty: "没有匹配的成员",
    /** 搜索框按这些词匹配「未指派」「我」两项。 */
    unassignedKeywords: "未指派 none",
    meKeywords: (name: string) => `我 me ${name}`,
    meSuffix: "（我）",
  },
  statusMenu: {
    triggerLabel: (label: string, pending: boolean) => `状态：${label}${pending ? "，正在保存" : "，点击修改"}`,
  },
  priorityMenu: {
    triggerLabel: (label: string, pending: boolean) => `优先级：${label}${pending ? "，正在保存" : "，点击修改"}`,
  },
  /** 新建需求对话框。 */
  create: {
    title: "新建需求",
    description: "只有标题必填，其余可以稍后补充。",
    discardLabel: "放弃这条需求？",
    discardPrompt: "放弃这条还没创建的需求？",
    titleLabel: "需求标题",
    titlePlaceholder: "需求标题",
    titleRequired: "写一个标题，方便大家在看板上认出它",
    summaryLabel: "描述",
    summaryPlaceholder: "补充背景、目标或验收标准，支持 Markdown（可稍后再写）",
    addMaterials: "添加附件",
    pendingFiles: "待上传的附件",
    removeFile: (name: string) => `移除 ${name}`,
    /** 选文件时预检不通过的说明：最多列三个，其余只给总数。 */
    rejectedItem: (name: string, reason: string) => `「${name}」${reason}`,
    rejected: (items: readonly string[], total: number) =>
      `${items.join("；")}${total > items.length ? ` 等 ${String(total)} 个文件` : ""}`,
    failed: (message: string) => `没能创建：${message}`,
    createMore: "继续新建下一条",
    submit: "创建需求",
    created: (code: string, uploading: number) =>
      `已创建 ${code}${uploading > 0 ? `，${String(uploading)} 个附件正在上传` : ""}`,
    uploadFailed: (code: string, name: string) => `${code} 的附件「${name}」没能上传`,
    view: "查看",
  },
  /** 需求速览面板。 */
  peek: {
    label: "需求速览",
    labelWith: (code: string, title: string) => `需求速览：${code} ${title}`,
    prev: "上一条",
    next: "下一条",
    openFull: "打开完整页",
    close: "关闭速览",
    /** 关闭按钮的提示，后面跟快捷键 Esc。 */
    closeHint: "关闭",
    loading: "正在加载需求",
    loadFailed: (message: string) => `没能打开这条需求：${message}`,
    field: {
      assignee: "负责人",
      priority: "优先级",
      created: "创建",
      updated: "更新",
    },
    assigneeTrigger: (name: string) => `负责人：${name}，点击修改`,
    /** 后面紧跟「去补充」链接；词间要空格的语言在末尾自带空格。 */
    noDescription: "还没有描述。",
    addDescription: "去补充",
    localSessions: "本机会话",
    recentActivity: "最近活动",
    startSession: "开始会话",
  },
  /** 分步的「开始会话」对话框。 */
  startSession: {
    title: "开始会话",
    directoryTitle: "选择本机代码目录",
    checking: "正在检查本机代码目录和已有会话",
    failed: (message: string) => `没能开始会话：${message}`,
    /** 转到后台后准备失败时的全局提示标题。 */
    backgroundFailed: "会话没能准备好",
    choose: {
      intro: (count: number) =>
        `这个需求已经有 ${String(count)} 个本机会话。继续之前的会话可以保留上下文；需求有较大变化时建议新开。`,
      listLabel: "已有会话",
      untitled: "未命名会话",
      activity: (when: string, latest: boolean) => `${latest ? "最近一次 · " : ""}${when}活动`,
      resume: "继续",
      more: (count: number) => `其余 ${String(count)} 个会话可以在「会话」里找到。`,
      createNew: "新开一个会话",
    },
    directory: {
      intro: "会话在这个项目的本机代码目录里运行。选一次即可，之后同一项目的会话都用它，可以在项目设置里修改。",
      /** 为什么要重新选目录；path 为 null 时不提具体路径。 */
      missing: (path: string | null) =>
        `之前关联的目录${path === null ? "" : ` ${path} `}已经不存在了（可能被移动、改名或删除）。请重新选择这个项目的本机代码目录。`,
      unusable: (path: string | null) =>
        `SuDuo 读写不了之前关联的目录${path === null ? "" : ` ${path}`}。请换一个目录，或检查它的权限。`,
      unlinked: "这个项目在本机的代码目录关联已失效。请重新选择。",
      use: "使用这个目录",
      useDisabledReason: "先选一个可以读写的目录",
    },
    preparing: {
      directoryReady: "本机代码目录可用",
      syncAndStart: "同步需求材料并启动会话",
      start: "启动会话",
      elapsed: (seconds: number) => `已用 ${String(seconds)} 秒`,
      enter: "进入会话",
      slow: "比平时慢一些：首次启动 Codex 或需求附件较大时会更久。可以先关掉，准备好后会提示你。",
      background: "在后台继续",
    },
  },
  /** 本机代码目录选择器（开始会话、关联目录对话框、首次设置向导共用）。 */
  directoryPicker: {
    manualLabel: "代码目录的绝对路径",
    up: "上一级目录",
    location: "当前位置",
    loading: "正在读取目录",
    loadFailed: (message: string) => `没能读取这个目录：${message}`,
    goHome: "回到主目录",
    empty: "这里没有子目录",
    listLabel: "目录",
    listLabelIn: (path: string) => `${path} 下的目录`,
    gitRepo: "Git 仓库",
    truncated: "目录较多，只显示前 500 个。可以直接输入路径。",
    recent: "最近使用",
    checking: "正在检查…",
    browse: "浏览目录",
    manual: "手动输入路径",
    /** 目录已关联给其他项目（null = 当前看不到名字的项目，合并成「另外 N 个项目」）：只提示，不拦保存。 */
    alsoLinked: (projects: readonly (string | null)[]) => {
      const named = projects.filter((name) => name !== null).map((name) => `「${name}」`);
      const unnamed = projects.length - named.length;
      const parts = [...named, ...(unnamed === 0 ? [] : [unnamed === 1 ? "另一个项目" : `另外 ${String(unnamed)} 个项目`])];
      return `这个目录也关联给了${parts.join("、")}，${projects.length === 1 ? "两个项目" : "这些项目"}的会话都会在这里运行`;
    },
    verdict: {
      idle: "选中一个目录（双击或 → 进入子目录）",
      missing: "这个路径不存在",
      notDirectory: "这不是一个目录",
      noAccess: "SuDuo 需要能读写这个目录",
      notGitRepo: "可以读写，但不是 Git 仓库：会话里将无法保存检查点",
      ok: "可以读写 · 是 Git 仓库",
      okOnBranch: (branch: string) => `可以读写 · 是 Git 仓库 · 当前分支 ${branch}`,
    },
  },
};
