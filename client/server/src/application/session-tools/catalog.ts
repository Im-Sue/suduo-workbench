import type { Locale, RuntimeToolSpec, SuDuoToolName } from "@suduo/client-contracts";

/**
 * 会话工具清单（ADR-0008）。说明按 Codex「代码模式」写：工具在 exec 里以
 * `await tools.<名字>(参数)` 调用，返回值是字符串，要用 `text()` / `image()` 交回给自己。
 * 实测不写清返回格式时，模型会先把图片 data URL 当文字打印、再调第二次。
 */

const TEXT_RETURN = "返回 Markdown 文本（字符串），在 exec 里用 text(await tools.NAME({...})) 查看。";

function textReturn(name: string): string {
  return TEXT_RETURN.replace("NAME", name);
}

const NUMBER_PARAM = {
  type: "string",
  description: "需求编号，如 REQ-12 或 12。需求会话里省略即为当前需求；项目会话里必填。",
};

const SPECS: Record<SuDuoToolName, RuntimeToolSpec> = {
  suduo_requirement_get: {
    name: "suduo_requirement_get",
    description:
      "查询 SuDuo 需求：编号、标题、状态、负责人、版本和完整正文；当前需求还会给出开工时的版本和开工以后的变化（谁、何时、改了什么）。" +
      textReturn("suduo_requirement_get"),
    inputSchema: {
      type: "object",
      properties: { number: NUMBER_PARAM },
      additionalProperties: false,
    },
  },
  suduo_requirement_comments: {
    name: "suduo_requirement_comments",
    description:
      "查看需求的评论（作者、时间、正文；确认版发布说明会标出），每次最多 20 条，结果开头和末尾都给出下一页的 cursor。" +
      textReturn("suduo_requirement_comments"),
    inputSchema: {
      type: "object",
      properties: {
        number: NUMBER_PARAM,
        cursor: { type: "string", description: "上一页结果末尾给出的 cursor；第一页省略。" },
      },
      additionalProperties: false,
    },
  },
  suduo_requirement_attachments: {
    name: "suduo_requirement_attachments",
    description:
      "列出需求的附件：附件 ID、文件名、类型、大小、上传人、时间。要看内容用 suduo_attachment_view。" +
      textReturn("suduo_requirement_attachments"),
    inputSchema: {
      type: "object",
      properties: { number: NUMBER_PARAM },
      additionalProperties: false,
    },
  },
  suduo_attachment_view: {
    name: "suduo_attachment_view",
    description:
      "查看需求附件的内容。图片直接交给你看；文本类直接返回内容；其他类型（PDF、压缩包、视频等）保存到项目的 .suduo/ 目录并返回路径。" +
      "返回字符串：第一行是附件说明；图片附件随后每行一个 data:image/... 地址。在 exec 里这样查看：" +
      'const r = String(await tools.suduo_attachment_view({attachmentId})); const [head, ...rest] = r.split("\\n"); text(head); ' +
      'const imgs = rest.filter((u) => u.startsWith("data:image/")); for (const u of imgs) image(u); if (imgs.length === 0) text(rest.join("\\n")); ' +
      "不要用 text() 输出 data:image 地址。",
    inputSchema: {
      type: "object",
      properties: {
        attachmentId: { type: "string", description: "附件 ID（来自附件清单）。" },
        number: NUMBER_PARAM,
      },
      required: ["attachmentId"],
      additionalProperties: false,
    },
  },
  suduo_artifact_versions: {
    name: "suduo_artifact_versions",
    description:
      "列出需求的确认版（产物版本）：版本号、发布人、时间、每版的文件清单。" +
      textReturn("suduo_artifact_versions"),
    inputSchema: {
      type: "object",
      properties: { number: NUMBER_PARAM },
      additionalProperties: false,
    },
  },
  suduo_artifact_fetch: {
    name: "suduo_artifact_fetch",
    description:
      "把某个确认版的全部文件保存到项目的 .suduo/requirements/<需求>/materials/确认版-v<版本>/（保留原文件名，重复拉取直接覆盖），返回保存目录和文件清单，之后可以直接读这些文件。" +
      textReturn("suduo_artifact_fetch"),
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "integer", minimum: 1, description: "确认版版本号，如 2。" },
        number: NUMBER_PARAM,
      },
      required: ["version"],
      additionalProperties: false,
    },
  },
  suduo_notes_read: {
    name: "suduo_notes_read",
    description:
      "读取这条需求在本机的结论笔记（入口文件、已确认结论、待确认问题、关键决定）。笔记只在本机，不会自动共享。" +
      textReturn("suduo_notes_read"),
    inputSchema: {
      type: "object",
      properties: { number: NUMBER_PARAM },
      additionalProperties: false,
    },
  },
  suduo_notes_save: {
    name: "suduo_notes_save",
    description:
      "用完整的新内容覆盖这条需求的结论笔记（Markdown）。用户说「记一下 / 沉淀一下」时调用；先用 suduo_notes_read 读出现有内容，在其基础上整理后整篇写回，不要丢掉用户写的内容。" +
      "旧内容会自动存档。" +
      textReturn("suduo_notes_save"),
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "笔记全文（Markdown）。" },
        number: NUMBER_PARAM,
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  suduo_comment_submit: {
    name: "suduo_comment_submit",
    description:
      "向当前需求发一条评论（全组可见，发出后不能撤回）。只在用户明确要求时调用，不要主动建议发评论。" +
      "调用后会停住，等用户在 SuDuo 界面确认，可能要几十秒到几分钟：等待期间不要输出「仍在等待」之类的进度消息，在 exec 里把等待 / 让出时间设到允许的最大值，被让出后直接继续等，拿到结果再回复用户。" +
      "返回字符串：已发出（含评论信息）、用户未同意、或未能发出及原因。",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "评论全文（Markdown，最多 4000 字）。" },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  suduo_artifact_publish: {
    name: "suduo_artifact_publish",
    description:
      "把文件发布为当前需求的一个新确认版（全组可见，不能撤回）。只在用户明确要求时调用。" +
      "paths 是项目里的文件（相对项目目录的路径），确认后会先上传为需求附件再发布；attachmentIds 是需求已有的附件。" +
      "调用后会停住，等用户在 SuDuo 界面确认：等待期间不要输出进度消息，在 exec 里把等待 / 让出时间设到最大，拿到结果再回复用户。" +
      "返回字符串：已发布（含版本号）、用户未同意、或未能发布及原因。",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "项目里要发布的文件路径。" },
        attachmentIds: { type: "array", items: { type: "string" }, description: "需求已有附件的 ID。" },
        note: { type: "string", description: "发布说明（可选）。" },
      },
      additionalProperties: false,
    },
  },
};

/** 房间工具（房间任务会话专用，需求「项目聊天房间与共享 Agent」4.8 按需层）。名字不在契约的 SuDuoToolName 里。 */
export const ROOM_TOOL_NAMES = ["suduo_room_history", "suduo_room_search", "suduo_room_file_view"] as const;
export type RoomToolName = (typeof ROOM_TOOL_NAMES)[number];

const ROOM_SPECS: Record<RoomToolName, RuntimeToolSpec> = {
  suduo_room_history: {
    name: "suduo_room_history",
    description:
      "只读：翻看当前房间更早的消息（序号、时间、作者、正文前 500 字、附件名与文件 ID），按时间先后排列，每次最多 50 条；结果末尾给出继续往前翻的 beforeSeq。" +
      textReturn("suduo_room_history"),
    inputSchema: {
      type: "object",
      properties: {
        beforeSeq: { type: "integer", minimum: 1, description: "只看序号小于它的消息；省略则从最新的往前看。" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "条数，默认 20，最多 50。" },
      },
      additionalProperties: false,
    },
  },
  suduo_room_search: {
    name: "suduo_room_search",
    description:
      "只读：在当前房间里按关键词找消息（正文包含关键词，不分大小写），返回格式同 suduo_room_history，每次最多 50 条。" +
      textReturn("suduo_room_search"),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词。" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "条数，默认 20，最多 50。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  suduo_room_file_view: {
    name: "suduo_room_file_view",
    description:
      "只读：查看房间里的文件（消息里写了文件 ID）。图片直接交给你看；文本类直接返回内容；其他类型（视频、PDF、压缩包等）保存到项目的 .suduo/rooms/<房间>/files/ 并返回路径，之后可以直接读。" +
      "返回字符串：第一行是文件说明；图片随后每行一个 data:image/... 地址。在 exec 里这样查看：" +
      'const r = String(await tools.suduo_room_file_view({fileId})); const [head, ...rest] = r.split("\\n"); text(head); ' +
      'const imgs = rest.filter((u) => u.startsWith("data:image/")); for (const u of imgs) image(u); if (imgs.length === 0) text(rest.join("\\n")); ' +
      "不要用 text() 输出 data:image 地址。",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "文件 ID（消息里「文件 ID」后面的值）。" },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
};

/** 只读与本机笔记工具：需求会话和项目会话都有。 */
const READ_TOOLS: SuDuoToolName[] = [
  "suduo_requirement_get",
  "suduo_requirement_comments",
  "suduo_requirement_attachments",
  "suduo_attachment_view",
  "suduo_artifact_versions",
  "suduo_artifact_fetch",
  "suduo_notes_read",
  "suduo_notes_save",
];

/** 对外写工具：只挂在需求会话上，目标需求只从会话派生。 */
const WRITE_TOOLS: SuDuoToolName[] = ["suduo_comment_submit", "suduo_artifact_publish"];

/**
 * 需求房间里的需求只读工具（ADR-0009）：不含结论笔记（所有者私有）与对外写工具
 * （共享 Agent 只问答与规划，不发评论、不发布确认版）。
 */
const ROOM_REQUIREMENT_TOOLS: SuDuoToolName[] = [
  "suduo_requirement_get",
  "suduo_requirement_comments",
  "suduo_requirement_attachments",
  "suduo_attachment_view",
  "suduo_artifact_versions",
  "suduo_artifact_fetch",
];

/**
 * requirement = 需求会话；project = 项目会话；room = 房间任务会话（项目默认房间）：只有房间工具；
 * room_requirement = 需求房间的房间任务会话：房间工具 + 需求只读工具。
 */
export type SessionToolScope = "requirement" | "project" | "room" | "room_requirement";

/** 工具定义按会话的语言给出（建线程时下发，之后不变）。 */
export function sessionToolSpecs(scope: SessionToolScope, locale: Locale): RuntimeToolSpec[] {
  void locale;
  return sessionToolNames(scope).map((name) =>
    isRoomToolName(name) ? ROOM_SPECS[name] : SPECS[name as SuDuoToolName],
  );
}

/** 某个 scope 下挂了哪些工具（调度时据此拒绝清单外的调用）。 */
export function sessionToolNames(scope: SessionToolScope): string[] {
  switch (scope) {
    case "requirement":
      return [...READ_TOOLS, ...WRITE_TOOLS];
    case "project":
      return [...READ_TOOLS];
    case "room":
      return [...ROOM_TOOL_NAMES];
    case "room_requirement":
      return [...ROOM_TOOL_NAMES, ...ROOM_REQUIREMENT_TOOLS];
  }
}

export function isRoomToolName(name: string): name is RoomToolName {
  return (ROOM_TOOL_NAMES as readonly string[]).includes(name);
}

export function isWriteTool(name: string): name is "suduo_comment_submit" | "suduo_artifact_publish" {
  return (WRITE_TOOLS as string[]).includes(name);
}
