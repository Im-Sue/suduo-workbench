/**
 * 会话工具定义（ADR-0008）给 Codex 的说明与参数说明，按会话的语言（中英双语 S7）。
 * 工具名、参数名、schema 不在这里，见 `session-tools/catalog.ts`。
 */
export const toolSpec = {
  /** 文本结果的取法，接在说明后面（英文版自带前导空格）。 */
  textReturn: (name: string) => `返回 Markdown 文本（字符串），在 exec 里用 text(await tools.${name}({...})) 查看。`,
  numberParam: "需求编号，如 REQ-12 或 12。需求会话里省略即为当前需求；项目会话里必填。",

  requirementGet:
    "查询 SuDuo 需求：编号、标题、状态、优先级、负责人、版本和完整正文；当前需求还会给出开工时的版本和开工以后的变化（谁、何时、改了什么）。",
  requirementComments: {
    description:
      "查看需求的评论（作者、时间、正文；确认版发布说明会标出），每次最多 20 条，结果开头和末尾都给出下一页的 cursor。",
    cursor: "上一页结果末尾给出的 cursor；第一页省略。",
  },
  requirementAttachments:
    "列出需求的附件（按上传时间从新到旧）：附件 ID、文件名、类型、大小、上传人、时间。附件是需求的资料（PRD、截图、第三方资料、压缩包等），" +
    "内容重复时以较新的为准，不重复的互为补充，拿不准就问用户。要看内容用 suduo_attachment_view。",
  attachmentView: {
    /** `snippet` 是在 exec 里查看结果的示例代码（与语言无关，由 catalog 给出）。 */
    description: (snippet: string) =>
      "查看需求附件的内容。图片直接交给你看；文本类直接返回内容；其他类型（PDF、压缩包、视频等）保存到项目的 .suduo/ 目录并返回路径。" +
      "返回字符串：第一行是附件说明；图片附件随后每行一个 data:image/... 地址。在 exec 里这样查看：" +
      snippet +
      "不要用 text() 输出 data:image 地址。",
    attachmentId: "附件 ID（来自附件清单），或评论里附带文件的编号（来自 suduo_requirement_comments）。",
  },
  notesRead: "读取这条需求在本机的结论笔记（入口文件、已确认结论、待确认问题、关键决定）。笔记只在本机，不会自动共享。",
  notesSave: {
    description:
      "用完整的新内容覆盖这条需求的结论笔记（Markdown）。用户说「记一下 / 沉淀一下」时调用；先用 suduo_notes_read 读出现有内容，在其基础上整理后整篇写回，不要丢掉用户写的内容。" +
      "旧内容会自动存档。",
    content: "笔记全文（Markdown）。",
  },
  commentSubmit: {
    description:
      "向当前需求发一条评论（全组可见，发出后不能撤回）。只在用户明确要求时调用，不要主动建议发评论。" +
      "调用后会停住，等用户在 SuDuo 界面确认，可能要几十秒到几分钟：等待期间不要输出「仍在等待」之类的进度消息，在 exec 里把等待 / 让出时间设到允许的最大值，被让出后直接继续等，拿到结果再回复用户。" +
      "返回字符串：已发出（含评论信息）、用户未同意、或未能发出及原因。",
    body: "评论全文（Markdown，最多 4000 字）。",
  },

  /** 房间工具（房间任务会话专用）。 */
  roomLimit: "条数，默认 20，最多 50。",
  roomHistory: {
    description:
      "只读：翻看当前房间更早的消息（序号、时间、作者、正文前 500 字、附件名与文件 ID），按时间先后排列，每次最多 50 条；结果末尾给出继续往前翻的 beforeSeq。",
    beforeSeq: "只看序号小于它的消息；省略则从最新的往前看。",
  },
  roomSearch: {
    description:
      "只读：在当前房间里按关键词找消息（正文包含关键词，不分大小写），返回格式同 suduo_room_history，每次最多 50 条。",
    query: "关键词。",
  },
  roomFileView: {
    /** `snippet` 同 `attachmentView`。 */
    description: (snippet: string) =>
      "只读：查看房间里的文件（消息里写了文件 ID）。图片直接交给你看；文本类直接返回内容；其他类型（视频、PDF、压缩包等）保存到项目的 .suduo/rooms/<房间>/files/ 并返回路径，之后可以直接读。" +
      "返回字符串：第一行是文件说明；图片随后每行一个 data:image/... 地址。在 exec 里这样查看：" +
      snippet +
      "不要用 text() 输出 data:image 地址。",
    fileId: "文件 ID（消息里「文件 ID」后面的值）。",
  },
};
