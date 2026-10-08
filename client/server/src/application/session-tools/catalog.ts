import type { ActiveSuDuoToolName, Locale, RuntimeToolSpec } from "@suduo/client-contracts";
import { messagesFor, type ServerMessages } from "../../i18n/messages/index.js";

/**
 * 会话工具清单（ADR-0008）。说明按 Codex「代码模式」写：工具在 exec 里以
 * `await tools.<名字>(参数)` 调用，返回值是字符串，要用 `text()` / `image()` 交回给自己。
 * 实测不写清返回格式时，模型会先把图片 data URL 当文字打印、再调第二次。
 */

/** 在 exec 里查看「第一行说明 + 每行一个 data:image 地址」结果的示例代码（与语言无关）。 */
function viewSnippet(tool: string, argument: string): string {
  return (
    `const r = String(await tools.${tool}({${argument}})); const [head, ...rest] = r.split("\\n"); text(head); ` +
    'const imgs = rest.filter((u) => u.startsWith("data:image/")); for (const u of imgs) image(u); if (imgs.length === 0) text(rest.join("\\n")); '
  );
}

/** 需求与笔记工具的定义，说明按字典。 */
function requirementSpecs(d: ServerMessages["toolSpec"]): Record<ActiveSuDuoToolName, RuntimeToolSpec> {
  const textReturn = (description: string, name: ActiveSuDuoToolName) => description + d.textReturn(name);
  const numberParam = { type: "string", description: d.numberParam };
  return {
    suduo_requirement_get: {
      name: "suduo_requirement_get",
      description: textReturn(d.requirementGet, "suduo_requirement_get"),
      inputSchema: {
        type: "object",
        properties: { number: numberParam },
        additionalProperties: false,
      },
    },
    suduo_requirement_comments: {
      name: "suduo_requirement_comments",
      description: textReturn(d.requirementComments.description, "suduo_requirement_comments"),
      inputSchema: {
        type: "object",
        properties: {
          number: numberParam,
          cursor: { type: "string", description: d.requirementComments.cursor },
        },
        additionalProperties: false,
      },
    },
    suduo_requirement_attachments: {
      name: "suduo_requirement_attachments",
      description: textReturn(d.requirementAttachments, "suduo_requirement_attachments"),
      inputSchema: {
        type: "object",
        properties: { number: numberParam },
        additionalProperties: false,
      },
    },
    suduo_attachment_view: {
      name: "suduo_attachment_view",
      description: d.attachmentView.description(viewSnippet("suduo_attachment_view", "attachmentId")),
      inputSchema: {
        type: "object",
        properties: {
          attachmentId: { type: "string", description: d.attachmentView.attachmentId },
          number: numberParam,
        },
        required: ["attachmentId"],
        additionalProperties: false,
      },
    },
    suduo_notes_read: {
      name: "suduo_notes_read",
      description: textReturn(d.notesRead, "suduo_notes_read"),
      inputSchema: {
        type: "object",
        properties: { number: numberParam },
        additionalProperties: false,
      },
    },
    suduo_notes_save: {
      name: "suduo_notes_save",
      description: textReturn(d.notesSave.description, "suduo_notes_save"),
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: d.notesSave.content },
          number: numberParam,
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    suduo_comment_submit: {
      name: "suduo_comment_submit",
      description: d.commentSubmit.description,
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", description: d.commentSubmit.body },
        },
        required: ["body"],
        additionalProperties: false,
      },
    },
  };
}

/** 房间工具（房间任务会话专用，需求「项目聊天房间与共享 Agent」4.8 按需层）。名字不在契约的 SuDuoToolName 里。 */
export const ROOM_TOOL_NAMES = ["suduo_room_history", "suduo_room_search", "suduo_room_file_view"] as const;
export type RoomToolName = (typeof ROOM_TOOL_NAMES)[number];

function roomSpecs(d: ServerMessages["toolSpec"]): Record<RoomToolName, RuntimeToolSpec> {
  return {
    suduo_room_history: {
      name: "suduo_room_history",
      description: d.roomHistory.description + d.textReturn("suduo_room_history"),
      inputSchema: {
        type: "object",
        properties: {
          beforeSeq: { type: "integer", minimum: 1, description: d.roomHistory.beforeSeq },
          limit: { type: "integer", minimum: 1, maximum: 50, description: d.roomLimit },
        },
        additionalProperties: false,
      },
    },
    suduo_room_search: {
      name: "suduo_room_search",
      description: d.roomSearch.description + d.textReturn("suduo_room_search"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: d.roomSearch.query },
          limit: { type: "integer", minimum: 1, maximum: 50, description: d.roomLimit },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    suduo_room_file_view: {
      name: "suduo_room_file_view",
      description: d.roomFileView.description(viewSnippet("suduo_room_file_view", "fileId")),
      inputSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: d.roomFileView.fileId },
        },
        required: ["fileId"],
        additionalProperties: false,
      },
    },
  };
}

/** 只读与本机笔记工具：需求会话和项目会话都有。 */
const READ_TOOLS: ActiveSuDuoToolName[] = [
  "suduo_requirement_get",
  "suduo_requirement_comments",
  "suduo_requirement_attachments",
  "suduo_attachment_view",
  "suduo_notes_read",
  "suduo_notes_save",
];

/** 对外写工具：只挂在需求会话上，目标需求只从会话派生。 */
const WRITE_TOOLS: ActiveSuDuoToolName[] = ["suduo_comment_submit"];

/**
 * 需求房间里的需求只读工具（ADR-0009）：不含结论笔记（所有者私有）与对外写工具
 * （共享 Agent 只问答与规划，不发评论）。
 */
const ROOM_REQUIREMENT_TOOLS: ActiveSuDuoToolName[] = [
  "suduo_requirement_get",
  "suduo_requirement_comments",
  "suduo_requirement_attachments",
  "suduo_attachment_view",
];

/**
 * requirement = 需求会话；project = 项目会话；room = 房间任务会话（项目默认房间）：只有房间工具；
 * room_requirement = 需求房间的房间任务会话：房间工具 + 需求只读工具。
 */
export type SessionToolScope = "requirement" | "project" | "room" | "room_requirement";

/** 工具定义按会话的语言给出（建线程时下发，之后不变）。 */
export function sessionToolSpecs(scope: SessionToolScope, locale: Locale): RuntimeToolSpec[] {
  const d = messagesFor(locale).toolSpec;
  const specs = requirementSpecs(d);
  const rooms = roomSpecs(d);
  return sessionToolNames(scope).map((name) => (isRoomToolName(name) ? rooms[name] : specs[name as ActiveSuDuoToolName]));
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

export function isWriteTool(name: string): name is "suduo_comment_submit" {
  return (WRITE_TOOLS as string[]).includes(name);
}
