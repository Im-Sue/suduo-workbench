import type {
  AgentRunCodexError,
  AgentRunFailureCategory,
  AgentRunStatus,
  AgentShareDuration,
} from "@suduo/cloud-contracts";
import type { ReactNode } from "react";

/** 讨论房间与共享 Agent（需求十一、快捷入口需求）：讨论页、悬浮窗口与入口、需求下的讨论、共享面板、任务状态。 */
export const rooms = {
  /** 读屏标签里各段之间的分隔（「REQ-1 讨论，4 条未读，有人 @ 你」）。 */
  labelSeparator: "，",
  /** 「已归档」标记。 */
  archived: "已归档",
  /** 读屏标签里的「已归档」一段。 */
  archivedState: "已归档",
  unread: (count: number) => `${String(count)} 条未读`,
  mentioned: "有人 @ 你",
  noRooms: "这个项目还没有讨论",
  loadFailed: (message: string) => `查不到讨论：${message}`,
  roomLoadFailed: (message: string) => `查不到这个讨论：${message}`,
  usersLoadFailed: (message: string) => `查不到人员列表：${message}`,
  opening: "正在打开讨论",
  kind: {
    project: "项目讨论",
    requirement: "需求讨论",
  },
  page: {
    regionLabel: "讨论区",
    emptyDescription: "项目讨论会在第一次打开时自动建立；需求下的讨论在需求详情里新建。",
    roomNotFound: "查不到这个讨论：它可能已被移走，或链接有误。",
  },
  list: {
    label: "讨论列表",
    title: "讨论",
    loading: "正在加载讨论",
    loadFailed: (message: string) => `查不到讨论列表：${message}`,
    activeLabel: "进行中的讨论",
    archivedToggle: (count: number) => `已归档 ${String(count)}`,
    archivedLabel: "已归档的讨论",
    requirementHint: "需求下的讨论在需求详情里新建。",
  },
  header: {
    archivedToast: (name: string) => `已归档「${name}」`,
    unarchivedToast: (name: string) => `已取消归档「${name}」`,
    undo: "撤销",
    projectScope: "项目讨论 · 所有人都在",
    requirementPrefix: "需求",
    join: "加入讨论",
    moreActions: "房间的更多操作",
    rename: "改名…",
    archive: "归档",
    unarchive: "取消归档",
  },
  rename: {
    title: "给讨论改名",
    nameLabel: "名称",
    nameRequired: "名称不能为空",
    cancel: "取消",
    save: "保存名称",
  },
  members: {
    /** online 为 null：成员列表还没取回来，不说在线人数。 */
    buttonLabel: (count: number, online: number | null) =>
      `成员 ${String(count)} 人${online === null ? "" : `，${String(online)} 人在线`}`,
    heading: (count: number) => `成员 ${String(count)}`,
    onlineCount: (count: number) => `${String(count)} 人在线`,
    loadFailed: (message: string) => `查不到成员：${message}`,
    listLabel: "成员",
    online: "在线",
    offline: "离线",
    add: "添加成员",
    searchPlaceholder: "搜索要拉进来的人",
    loading: "正在加载成员…",
    noneToAdd: "没有可以添加的人",
    added: (name: string) => `已把 ${name} 拉进讨论`,
  },
  body: {
    loadingMessages: "正在加载消息",
    messagesLoadFailed: (message: string) => `查不到消息：${message}`,
    emptyTitle: "还没有消息",
    emptyDescription: "发第一条消息开始讨论；同事把 Codex 共享进来后，@ 它就能直接问代码层面的问题。",
    composerPlaceholder: (room: string) => `在「${room}」里发消息，@ 同事或共享进来的 Agent`,
    resizeSide: "调整话题栏宽度",
  },
  stream: {
    label: "消息记录",
    loadOlder: "更早的消息 · 加载更多",
    start: "这是讨论的开始",
    newMessages: "有新消息",
  },
  message: {
    systemAuthor: "系统",
    someone: "有人",
    label: (name: string, time: string) => `${name}，${time}`,
    replyLabel: (name: string) => `回复 ${name} 的消息`,
    reply: "回复",
    /** 发送中的占位取不到自己名字时的称呼。 */
    me: "我",
    pendingLabel: (name: string) => `${name}，发送中`,
    sending: "发送中…",
    attachedFiles: (count: number) => `附带 ${String(count)} 个文件`,
  },
  /** 房间列表里「最后一条」的预览：没有文字时按第一个文件。 */
  preview: {
    image: "[图片]",
    video: "[视频]",
    file: (name: string) => `[文件] ${name}`,
    /** 多个附件：first 是第一个附件的预览，count 是附件总数（「[文件] a.pdf 等 3 个」）。 */
    more: (first: string, count: number) => `${first} 等 ${String(count)} 个`,
  },
  thread: {
    title: "话题",
    runTitle: "执行过程",
    close: "关闭话题",
    loading: "正在加载话题",
    loadFailed: (message: string) => `查不到这个话题：${message}`,
    noReplies: "还没有回复",
    replies: (count: number) => `${String(count)} 条回复`,
    lastReply: (time: string) => `最后回复 ${time}`,
    repliesLoadFailed: (message: string) => `查不到这个话题的回复：${message}`,
    loadOlder: "加载更早的回复",
    composerPlaceholder: "回复话题，@ 可以继续问 Agent",
  },
  composer: {
    shareRequested: (owner: string, agent: string) => `已向 ${owner} 申请共享 ${agent}`,
    archived: "这个讨论已归档，只能查看历史。需要继续讨论时，在右上角「更多」里取消归档。",
    sendFailed: (message: string) => `没能发出：${message}。内容已放回输入框。`,
    retry: "重试",
    dropFiles: "松开以把文件加入这条消息",
    filesLabel: "要发送的文件",
    messageLabel: (room: string) => `在「${room}」里发消息`,
    replyLabel: "回复话题",
    attachTitle: "添加文件（也可以直接粘贴或拖进来）",
    attach: "文件",
    fileInputLabel: "选择要发送的文件",
    mentionTitle: "@ 同事或共享进来的 Agent",
    mentionLabel: "插入 @",
    keyHint: "Enter 发送 · Shift+Enter 换行",
    waitForUpload: "等文件传完再发送",
    sendTitle: "发送（Enter）",
    send: "发送",
    file: {
      retry: (name: string) => `重新上传 ${name}`,
      remove: (name: string) => `移除 ${name}`,
      progress: (name: string) => `${name} 上传进度`,
      failed: "上传失败",
      /** 粘贴的截图没有文件名时，草稿里显示的名字。 */
      pastedImageName: "粘贴的图片.png",
      tooLarge: "文件超过 300 MB，无法上传",
    },
  },
  mention: {
    listLabel: "选择要 @ 的人或 Agent",
    people: "成员",
    agents: "Agent",
    /** 「@ 所有人」候选在列表里显示的名字（插进正文的文字见下面的 text.everyone）。 */
    everyone: "所有人",
    everyoneNote: "提醒所有人，不唤起 Agent",
    online: "在线",
    loading: "正在加载成员…",
    noMatch: "没有匹配的人或 Agent",
    /** 离线但已共享的 Agent：@ 了照样发出，消息下显示「离线，未执行」，触发人之后可以重试。 */
    offlineHint: "离线时 @ 不会执行，之后可在消息上重试",
    agentNote: {
      available: "可用",
      offline: "离线",
      unsharedMine: "未共享 · 在「共享 Agent」里开启",
      unsharedRequested: "未共享 · 已申请",
      unsharedRequest: "未共享 · 回车申请共享",
    },
    /**
     * 选中候选后插进正文的文字（不含 @），按发送者的界面语言写；
     * 高亮时各语言的写法都认（model.ts 的 mentionHighlights），所以别人用另一种语言看也能高亮。
     */
    text: {
      everyone: "所有人",
      /** 「陈思远的Codex」；同一个人有多台设备时带设备名「陈思远的Codex·MacBook Pro」。 */
      agent: (owner: string, device: string | null) => (device === null ? `${owner}的Codex` : `${owner}的Codex·${device}`),
    },
  },
  files: {
    video: (name: string) => `视频 ${name}`,
    imagePreview: "图片预览",
    viewImage: (name: string) => `查看图片 ${name}`,
    download: (name: string) => `下载 ${name}`,
    preview: (name: string) => `在新标签页预览 ${name}`,
    previewUnavailable: "这张图片没法在线预览，可以下载后查看。",
    downloadAction: "下载",
    downloadOriginal: "下载原图",
  },
  agent: {
    /** 「陈思远 的 Codex」：Agent 在消息、状态行里的名字。 */
    name: (owner: string) => `${owner} 的 Codex`,
    /** 「陈思远 的 Codex · MacBook Pro」：需要区分设备时（@ 候选、共享面板）的名字。 */
    withDevice: (owner: string, device: string) => `${owner} 的 Codex · ${device}`,
    available: "可用",
    offline: "离线",
  },
  run: {
    status: {
      queued: "排队中",
      running: "执行中",
      completed: "已完成",
      failed: "失败",
      stopped: "已停止",
      offline: "离线，未执行",
    } satisfies Record<AgentRunStatus, string>,
    stopping: "正在停止…",
    ahead: (count: number) => `前面还有 ${String(count)} 个`,
    queuedAhead: (status: string, count: number) => `${status}（前面还有 ${String(count)} 个）`,
    lineLabel: (agent: string, status: string) => `${agent}：${status}。打开话题`,
    stop: "停止",
    stopLabel: (agent: string) => `停止 ${agent} 的任务`,
    retry: "重试",
    retryLabel: (agent: string) => `重试 ${agent} 的任务`,
    elapsed: (duration: string) => `用时 ${duration}`,
    viewDetail: "查看详情",
    /**
     * 任务失败 / 停止 / 离线的原因，键是原因 code（中英双语技术设计 §4.3）。云端与所有者本机只存 code + 参数，
     * 各人按自己的语言看；参数里的路径、报错原文是所有者本机写下的原文，原样嵌进来。
     */
    reason: {
      not_shared: "未共享到这个房间",
      owner_offline: "所有者不在线",
      share_closed: "共享已关闭",
      share_expired: "共享已到期",
      owner_disconnected: "所有者本机下线，执行中断",
      stopped_by_owner: "所有者停止了任务",
      stopped_by_requester: "发起人停止了任务",
      no_local_folder: "这台电脑没有为这个项目关联代码目录",
      local_folder_unavailable: (path: string) => `这台电脑为这个项目关联的代码目录不可用（${path}），需要所有者重新关联`,
      trigger_message_missing: "找不到触发这次任务的消息",
      stopped_before_start: "开始执行前被叫停",
      stopped_while_running: "执行中被叫停",
      interrupted_locally: "在所有者电脑上被中断",
      stalled: (minutes: number) => `执行中断：${String(minutes)} 分钟没有任何进展`,
      local_start_failed: (detail: string) => `没能在本机开始执行：${detail}`,
      run_error: (detail: string) => `执行失败：${detail}`,
      reply_rejected: (detail: string) => `回答没能发到房间：${detail}`,
      local_service_restarted: "执行中断（本机服务重启）",
      result_not_delivered: "执行结果没能发回房间，详情见所有者本机的房间任务会话",
      start_connection_lost: "开始执行时与需求服务的连接中断，这次没有执行，可以重试",
      /** 回合失败：Codex 错误码 / 按状态码归类 / 报错原文 / 原因未知。 */
      turn_failed: {
        codexError: {
          contextWindowExceeded: "这段对话已经超出模型的上下文窗口。可以在新话题里重新 @，或请所有者处理。",
          usageLimitExceeded: "所有者的模型用量已经到上限，请稍后再试。",
          unauthorized: "所有者电脑上的模型服务认证失败（401），需要所有者检查模型服务设置。",
          serverOverloaded: "模型服务现在很忙，请稍等一会儿再重试。",
          internalServerError: "模型服务暂时出错，请稍后重试。",
          badRequest: "模型服务拒绝了这次请求，可能是参数或附件不被支持。",
          sandboxError: "命令没能在只读沙箱里运行。",
          rateLimitExceeded: "模型服务限流了，请稍等几分钟再重试。",
          misalignmentPolicyViolation: "这次请求触发了模型服务的安全策略，已停止。可以换个说法再试。",
          sessionBudgetExceeded: "这个话题的用量预算已经用完，可以在新话题里重新 @。",
          cyberPolicy: "请求涉及网络安全相关内容，被模型服务的安全策略拦下了。",
        } satisfies Record<AgentRunCodexError, string>,
        category: {
          rate_limited: "模型服务限流（429），请稍等几分钟再重试。",
          unauthorized: "所有者电脑上的模型服务认证失败（401），需要所有者检查模型服务设置。",
          forbidden: "模型服务拒绝了请求（403），所有者的凭证可能没有权限使用这个模型。",
          server_error: "模型服务暂时出错，请稍后重试。",
          timeout: "模型服务响应超时，请稍后重试。",
        } satisfies Record<AgentRunFailureCategory, string>,
        detail: (detail: string) => `执行失败：${detail}`,
        unknown: "执行失败，原因未知。",
      },
    },
  },
  runDetail: {
    back: "返回话题",
    loading: "正在加载执行过程",
    loadFailed: (message: string) => `查不到执行过程：${message}`,
    emptyQueued: "还在排队",
    emptyOffline: "没有执行",
    emptyNone: "还没有执行过程",
    offlineDescription: "所有者不在线或没有共享，这次没有执行。",
    emptyDescription: "开始执行后，这里会显示 Codex 查看了哪些文件、运行了哪些命令和它的回答。",
  },
  share: {
    button: "共享 Agent",
    buttonLabel: (shared: number, incoming: number) =>
      `共享 Agent${shared > 0 ? `，已共享 ${String(shared)} 个` : ""}${incoming > 0 ? `，${String(incoming)} 个申请待处理` : ""}`,
    duration: {
      until_closed: "直到我关闭",
      two_hours: "2 小时",
      today: "今天",
    } satisfies Record<AgentShareDuration, string>,
    /** 共享的到期说明：没有到期时间 / 到某个时刻（时刻由调用方按当前语言格式化）。 */
    expires: {
      untilClosed: "直到关闭",
      until: (time: string) => `到 ${time}`,
    },
    sharedHere: "本房间已共享",
    sharesLoadFailed: (message: string) => `查不到共享：${message}`,
    noneShared: "还没有人把 Agent 共享到这里。",
    incomingTitle: "待你处理的申请",
    incomingDurationLabel: "开启后共享多久",
    /** 「小王 申请使用 陈思远 的 Codex」：Agent 名字是调用方渲染好的节点。 */
    incomingRequest: (requester: string, agent: ReactNode): ReactNode[] => [requester, " 申请使用 ", agent],
    accept: "开启",
    ignore: "忽略",
    requestableTitle: "可以申请的 Agent",
    agentsLoadFailed: (message: string) => `查不到 Agent 列表：${message}`,
    noneRequestable: "同事的 Agent 都已经在这里了，或者还没有人登记 Agent。",
    request: "申请共享",
    requestLabel: (agent: string) => `申请共享 ${agent}`,
    requested: "已申请",
    requestedLabel: (agent: string) => `已申请 ${agent}`,
    myAgent: {
      title: "我的 Agent",
      loadFailed: (message: string) => `查不到本机 Agent：${message}`,
      /** message：本机服务给的原因（原样显示）；没有时用默认说明。 */
      unregistered: (message: string | null) =>
        `本机的 Codex 还没登记成 Agent${message === null ? "：登录并打开本机 SuDuo 后会自动登记。" : `：${message}`}`,
      unavailable: (message: string | null) => `本机的 Codex 暂时不可用${message === null ? "，稍后再试。" : `：${message}`}`,
      switchLabel: (agent: string) => `把 ${agent} 共享到这个房间`,
      durationLabel: "共享多久",
      notShared: (duration: string) =>
        `没有共享到这个房间。打开后按「${duration}」共享，房间里的人可以 @ 它提问，它在你的电脑上只读地分析。`,
      shared: (expires: string) => `已共享 · ${expires}。随时可以关闭，正在执行的任务会停止。`,
      noMapping: "这个项目还没关联你电脑上的代码目录，Agent 回答不了代码相关的问题。",
      linkFolder: "关联代码目录",
      /** room 为 null：在执行的任务属于一个本地没缓存的房间。 */
      activeRun: (room: string | null, queued: number) =>
        `正在为${room === null ? "另一个讨论" : `「${room}」`}执行${queued > 0 ? `，还有 ${String(queued)} 个在排队` : ""}`,
      queued: (count: number) => `还有 ${String(count)} 个在排队`,
    },
  },
  /** 所有者收到的「申请共享」提醒。 */
  shareRequestToast: {
    message: (requester: string, room: string | null, device: string) =>
      `${requester} 想在${room === null ? "一个讨论" : `「${room}」`}里使用你的 Codex（${device}）`,
    accept: "开启共享",
    accepted: "已共享到今天结束",
  },
  failures: {
    loadOlderMessages: "没能加载更早的消息",
    loadOlderReplies: "没能加载更早的回复",
    saveRoom: "没能保存房间",
    join: "没能加入",
    addMembers: "没能添加成员",
    openShare: "没能开启共享",
    closeShare: "没能关闭共享",
    requestShare: "没能申请共享",
    resolveRequest: "没能处理申请",
    stopRun: "没能停止",
    retryRun: "没能重试",
  },
  /** 需求详情的「讨论」区块。 */
  requirementRooms: {
    title: "讨论",
    create: "新建讨论",
    loadFailed: (message: string) => `查不到这条需求的讨论：${message}`,
    empty: "还没有讨论：需要和同事即时商量、请人共享 Codex 一起看代码时开一个",
    linkLabel: (name: string, archived: boolean, unread: number) =>
      `${name}${archived ? "（已归档）" : ""}${unread > 0 ? `，${String(unread)} 条未读` : ""}`,
    lastMessage: (author: string, preview: string) => `${author}：${preview}`,
  },
  /** 新建需求讨论的对话框。 */
  createDialog: {
    /** 缺省名字：存成房间名（用户数据），按创建者的语言生成。 */
    defaultName: (code: string) => `${code} 讨论`,
    title: "新建讨论",
    description: (code: string) => `挂在 ${code} 下。房间对所有人可见、可加入；你、需求负责人和需求创建人会自动在里面。`,
    nameLabel: "名称",
    membersLegend: "再拉几个人（可选）",
    noOthers: "没有其他人可以拉了。",
    failed: (message: string) => `没能新建：${message}`,
    cancel: "取消",
    submit: "新建讨论",
  },
  /** 需求预览面板底部的讨论按钮。 */
  roomButton: {
    loadFailed: (message: string) => `查不到这条需求的讨论：${message}，点击重试`,
    retry: "讨论",
    enter: "进入讨论",
    create: "创建讨论",
    enterLabel: (room: string) => `进入讨论：${room}`,
    menuLabel: (count: number, unread: number, mentioned: boolean) =>
      `进入讨论：${String(count)} 个讨论${unread > 0 ? `，${String(unread)} 条未读` : ""}${mentioned ? "，有人 @ 你" : ""}`,
    newRoom: "新建讨论",
  },
  /** 讨论悬浮窗口。 */
  window: {
    kindSuffix: (kind: string) => `（${kind}）`,
    join: "加入",
    openInPage: "在讨论页打开",
    minimize: "收起",
    close: "关闭",
    switchRoom: "切换讨论",
    projectRooms: "本项目的讨论",
    loading: "正在加载…",
    roomNotFound: "查不到这个讨论：它可能已被移走。",
  },
  /** 讨论悬浮入口。stashed：收起在入口里的窗口的房间名。 */
  launcher: {
    fallbackName: "讨论",
    label: (stashed: string | null, unread: number, mentioned: boolean) =>
      `${stashed === null ? "讨论快捷入口" : `恢复讨论窗口：${stashed}`}${unread > 0 ? `，${String(unread)} 条未读` : ""}${mentioned ? "，有人 @ 你" : ""}`,
    title: "讨论（可拖到左边）",
    restoreTitle: (name: string) => `恢复「${name}」`,
    loading: "正在加载讨论…",
    allRooms: "全部讨论…",
    allRoomsLabel: "全部讨论…，进入讨论页",
    currentLabel: (label: string) => `${label}，已在窗口里打开`,
  },
};
