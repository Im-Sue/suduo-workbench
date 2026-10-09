/**
 * 需求相关 SuDuo 工具交回给 Codex 的文字（`session-tools/requirement-tools.ts`、`session-tool-service.ts`），
 * 按会话的语言。人写的内容（需求标题与正文、评论、附件名、笔记、确认版说明、用户名）由调用方原样传入，不翻译。
 */

/** 评论翻页提示：单独一行时用；嵌进本页说明时见 `comments.header`。 */
const navigation = (nextCursor: string | null) =>
  nextCursor === null ? "这是最后一页。" : `还有下一页：cursor=${nextCursor}`;

export const toolReply = {
  /** 「查不到 X」里的 X（三态里的「查不到」，见 `toolText.unavailable`）。 */
  what: {
    neededInfo: "需要的信息",
    requirement: (number: string) => `需求 ${number}`,
    currentRequirement: "当前需求",
    comments: (label: string) => `${label} 的评论`,
    attachmentList: (label: string) => `${label} 的附件清单`,
    attachmentContent: (fileName: string) => `附件 ${fileName} 的内容`,
    file: (fileName: string) => `文件 ${fileName}`,
  },
  args: {
    missing: (name: string) => `缺少参数 ${name}。`,
    numberType: "参数 number 应为需求编号，例如 \"REQ-12\" 或 12。",
    numberFormat: (value: string) => `需求编号「${value}」格式不对，应为 REQ-12 或 12。`,
    projectSession: "这是项目会话，没有关联需求：请在参数 number 里给出需求编号，例如 REQ-12。",
  },
  /** SuDuo 生成到项目 `.suduo/requirements/<需求>/materials/` 下的文件与目录名。 */
  files: {
    body: (version: number) => `需求正文-v${String(version)}.md`,
    /** 文件名清理后为空时的兜底名。 */
    fallbackName: "附件",
    empty: (fileName: string) => `查不到文件 ${fileName}：需求服务返回了空内容。`,
    saveFailed: (fileName: string, reason: string) => `文件 ${fileName} 没有保存成功：${reason}。`,
  },
  get: {
    status: (status: string, priority: string, assignee: string, version: number) =>
      `- 状态：${status}；优先级：${priority}；负责人：${assignee}；当前版本：v${String(version)}`,
    startVersion: (version: number) => `（开工时 v${String(version)}）`,
    created: (createdBy: string, createdAt: string, updatedBy: string, updatedAt: string) =>
      `- 创建：${createdBy}，${createdAt}；最后修改：${updatedBy}，${updatedAt}`,
    counts: (comments: number, attachments: number) =>
      `- 评论 ${String(comments)} 条；附件 ${String(attachments)} 个（用 suduo_requirement_comments / suduo_requirement_attachments 查看）`,
    changesHeading: (startedAt: string) => `## 开工以后的变化（开工时刻 ${startedAt}）`,
    anchorUnknown: "- 注意：开工时没拿到需求服务的变化记录分界，下面按本机开工时间判断，前后几分钟内的变化可能有出入。",
    bodyHeading: "## 正文",
    bodyEmpty: "（正文为空）",
    bodySaved: (length: number, path: string) =>
      `正文共 ${String(length)} 字，太长，全文已保存到 ${path}，请直接读这个文件。开头部分：`,
    /** 正文开头部分之后的省略号行。 */
    previewEllipsis: "……",
  },
  /** 「开工以后的变化」一节。 */
  changes: {
    unavailable: (reason: string) => `- 查不到开工以后的变化：${reason}。这不代表没有变化。`,
    none: "- 开工以后没有变化。",
    limited: (total: number, shown: number) => `- （共 ${String(total)} 处变化，只列出最近 ${String(shown)} 处）`,
    partial: "- （变化较多，只列出最近的部分）",
  },
  /** 活动时间线条目的一句话描述（`describeActivity`），接在「时间 + 人名」后面。 */
  activity: {
    created: "创建了需求",
    commented: (text: string) => `发了评论：「${text}」`,
    attachmentAdded: (fileName: string) => `上传了附件 ${fileName}`,
    attachmentDeleted: (fileName: string) => `删除了附件 ${fileName}`,
    /** 版本号缺失时调用方传「?」。 */
    published: (version: number | string, fileCount: number) =>
      `发布了确认版 v${String(version)}（${String(fileCount)} 个文件）`,
    titleChanged: (from: string, to: string) => `把标题从「${from}」改成「${to}」`,
    summaryChanged: "修改了正文（当前正文见上方）",
    statusChanged: (from: string, to: string) => `把状态从「${from}」改成「${to}」`,
    assigneeChanged: (from: string, to: string) => `把负责人从「${from}」改成「${to}」`,
    priorityChanged: (from: string, to: string) => `把优先级从「${from}」改成「${to}」`,
    updated: "修改了需求",
    join: (parts: readonly string[]) => parts.join("，"),
  },
  comments: {
    none: (label: string) => `${label} 还没有评论。`,
    header: (label: string, count: number, nextCursor: string | null) =>
      `${label} 的评论（本页 ${String(count)} 条；${navigation(nextCursor)}）：`,
    navigation,
    clipped: (length: number) => `……（这条评论共 ${String(length)} 字，后面省略；需要全文请让用户在需求页查看）`,
    publishNote: "（确认版发布说明）",
    /** 评论带的文件，下面每行一个：编号 · 文件名 · 类型 · 大小。 */
    filesHeading: (count: number) => `附带 ${String(count)} 个文件（用 suduo_attachment_view 查看，参数 attachmentId 填文件编号）：`,
    /** 系统代写的评论（契约 `CommentDto.system`）：按会话语言渲染，不用存下的英文兜底正文。 */
    system: {
      artifactPublished: (versionNumber: number, fileCount: number) =>
        `发布了产物 v${String(versionNumber)}，含 ${String(fileCount)} 个文件。`,
      /** 只带文件、没写文字的评论。 */
      commentFiles: (fileCount: number) => `（没写文字，只附了 ${String(fileCount)} 个文件）`,
    },
  },
  attachments: {
    none: (label: string) => `${label} 没有附件。`,
    /** 附件按上传时间从新到旧列出；阅读约定是用户定的（需求附件评论文件与优先级）。 */
    header: (label: string, count: number) =>
      `${label} 的附件（${String(count)} 个，最新在前；内容重复时以较新的为准，不重复的互为补充，拿不准就问用户。用 suduo_attachment_view 查看内容）：`,
    notFound: (label: string, id: string) =>
      `${label} 的附件里没有 ID 为 ${id} 的附件（可能已删除，或属于别的需求）。先用 suduo_requirement_attachments 看附件清单。`,
    head: (fileName: string, contentType: string, size: string, uploader: string, time: string) =>
      `附件 ${fileName}（${contentType}，${size}，${uploader} 上传于 ${time}）`,
    savedLong: (path: string) => `内容较长，已保存到项目内 ${path}，请直接读取这个文件。`,
    saved: (path: string) => `已保存到项目内 ${path}，可以直接读取这个文件。`,
  },
  notes: {
    none: (label: string, path: string) => `${label} 在本机还没有结论笔记（${path}）。`,
    tooLong: (label: string, length: number, path: string) =>
      `${label} 的结论笔记共 ${String(length)} 字，太长，不在这里显示。` +
      `请直接读取文件 ${path} 的全文；更新时在全文基础上整理后用 suduo_notes_save 整篇写回。`,
    /** 后面接空行与笔记全文。 */
    content: (label: string, path: string) => `${label} 的结论笔记（${path}）：`,
    saved: (label: string, path: string) => `已更新 ${label} 的结论笔记：${path}（只在本机，不会自动共享）。`,
    backup: (path: string) => `旧内容已存档：${path}`,
    changedSinceRead:
      "注意：在你上次读取之后，笔记被用户或其他会话改过；旧内容已存档。请告诉用户，并确认这次写入没有丢掉对方新加的内容。",
  },
  /** 对外写工具（发评论）：确认卡的准备与确认后的执行结果。 */
  write: {
    commentEmpty: "评论内容不能为空。",
    commentTooLong: (limit: number, length: number) =>
      `评论最多 ${String(limit)} 字，现在是 ${String(length)} 字，请精简后再发。`,
    requirementSessionOnly: "只有从需求创建的会话才能发评论。",
    /** 确认卡里的需求没有编号时的称呼。 */
    requirementTitleOnly: (title: string) => `需求「${title}」`,
    commentSent: (label: string, author: string, time: string, id: string) =>
      `已发出评论到 ${label}（${author}，${time}，评论 ID ${id}）。`,
    incomplete: "确认卡内容不完整，没有执行。",
    /** 远程明确没接受（4xx）。 */
    notSent: (_kind: "comment", reason: string) => `未能发出评论：${reason}。`,
    /** 其他失败：可能已经送达，提醒核对、不要重发。 */
    unconfirmed: (_kind: "comment", reason: string) =>
      `评论的发送结果未确认：${reason}。请让用户到需求页核对是否已经发出，不要直接重发。`,
  },
  /** 工具调度（`session-tool-service.ts`）。 */
  dispatch: {
    failed: (reason: string) => `SuDuo 执行工具时出错：${reason}`,
    noProject: "这个会话没有关联 SuDuo 项目，不能使用 suduo 工具。",
    roomReadOnly: (tool: string) => `房间里的共享 Agent 只能用只读工具，不能调用 ${tool}。`,
    threadMissing: "找不到会话线程，没有执行。",
    roomToolsUnavailable: "房间工具暂时不可用。",
    sessionToolsUnavailable: "会话工具暂时不可用。",
    delegationToolsUnavailable: "委派工具暂时不可用。",
    unknownTool: (tool: string) => `SuDuo 没有工具 ${tool}。`,
    declinedComment: "用户没有同意，评论没有发出。",
    /** 经 MCP 调用发评论、等用户确认等到快超时（ADR-0015）：卡片留作草稿，不丢。 */
    commentDraftSaved: "用户还没确认，评论已存为待发出草稿（没有发出）。用户之后可以在 SuDuo 里发出或丢弃；不要再次调用发评论。",
    /** 确认版停用后，旧会话里模型仍调用三个已撤下的工具时。 */
    retired: (tool: string) =>
      `${tool} 已停用：SuDuo 不再有「确认版」，需求的资料都在附件里。用 suduo_requirement_attachments 看附件清单（最新在前），用 suduo_attachment_view 查看内容。`,
    sessionUnlinked: "会话已经没有关联的 SuDuo 项目，没有执行。",
    runFailed: (reason: string) => `执行时出错：${reason}`,
    /** 结果记进账本时图片的占位。 */
    image: "（图片）",
  },
};
