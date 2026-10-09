import { REVIEW_FOCUSES, REVIEW_SEVERITIES, type ActiveSuDuoToolName, type Locale, type RuntimeToolSpec } from "@suduo/client-contracts";
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

/**
 * 跨会话读取（多 Agent 协作 S7，技术设计 2.9）：主会话（需求会话、项目会话）有；房间任务没有（R10）。
 * 名字不在契约的 SuDuoToolName 里（与房间工具一样）。
 */
export const SESSION_TOOL_NAMES = ["suduo_session_list", "suduo_session_read"] as const;
export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

function sessionSpecs(locale: Locale, d: ServerMessages["toolSpec"]): Record<SessionToolName, RuntimeToolSpec> {
  const spec = messagesFor(locale).sessionContext.spec;
  return {
    suduo_session_list: {
      name: "suduo_session_list",
      description: spec.list.description + d.textReturn("suduo_session_list"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: spec.list.query },
          scope: { type: "string", enum: ["project", "all"], description: spec.list.scope },
          limit: { type: "integer", minimum: 1, maximum: 50, description: spec.list.limit },
        },
        additionalProperties: false,
      },
    },
    suduo_session_read: {
      name: "suduo_session_read",
      description: spec.read.description + d.textReturn("suduo_session_read"),
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: spec.read.sessionId },
          view: { type: "string", enum: ["summary", "conversation", "turns", "turn", "changes"], description: spec.read.view },
          turn: { type: "integer", minimum: 1, description: spec.read.turn },
          rounds: { type: "integer", minimum: 1, maximum: 10, description: spec.read.rounds },
          page: { type: "integer", minimum: 1, description: spec.read.page },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
  };
}

export function isSessionToolName(name: string): name is SessionToolName {
  return (SESSION_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 委派（多 Agent 协作 S8，技术设计 2.9 / 2.10）：只有主会话有（深度 1，R2）；委派出来的子会话建线程时去掉，
 * 调用时也按会话关系拒绝。
 */
export const DELEGATION_TOOL_NAMES = [
  "suduo_agent_list",
  "suduo_delegate_start",
  "suduo_delegate_wait",
  "suduo_delegate_send",
  "suduo_delegate_cancel",
] as const;
export type DelegationToolName = (typeof DELEGATION_TOOL_NAMES)[number];

export function isDelegationToolName(name: string): name is DelegationToolName {
  return (DELEGATION_TOOL_NAMES as readonly string[]).includes(name);
}

function delegationSpecs(locale: Locale, d: ServerMessages["toolSpec"]): Record<DelegationToolName, RuntimeToolSpec> {
  const spec = messagesFor(locale).delegation.spec;
  const id = { type: "string", description: spec.wait.delegationId };
  return {
    suduo_agent_list: {
      name: "suduo_agent_list",
      description: spec.agentList + d.textReturn("suduo_agent_list"),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    suduo_delegate_start: {
      name: "suduo_delegate_start",
      description: spec.start.description + d.textReturn("suduo_delegate_start"),
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: spec.start.agentId },
          task: { type: "string", description: spec.start.task },
          files: { type: "array", items: { type: "string" }, description: spec.start.files },
          autoHandback: { type: "boolean", description: spec.start.autoHandback },
          approvalMode: { type: "string", enum: ["readonly", "ask", "auto", "full"], description: spec.start.approvalMode },
        },
        required: ["agentId", "task"],
        additionalProperties: false,
      },
    },
    suduo_delegate_wait: {
      name: "suduo_delegate_wait",
      description: spec.wait.description + d.textReturn("suduo_delegate_wait"),
      inputSchema: {
        type: "object",
        properties: { delegationId: id, maxSeconds: { type: "integer", minimum: 1, maximum: 600, description: spec.wait.maxSeconds } },
        required: ["delegationId"],
        additionalProperties: false,
      },
    },
    suduo_delegate_send: {
      name: "suduo_delegate_send",
      description: spec.send.description + d.textReturn("suduo_delegate_send"),
      inputSchema: {
        type: "object",
        properties: { delegationId: id, message: { type: "string", description: spec.send.message } },
        required: ["delegationId", "message"],
        additionalProperties: false,
      },
    },
    suduo_delegate_cancel: {
      name: "suduo_delegate_cancel",
      description: spec.cancel.description + d.textReturn("suduo_delegate_cancel"),
      inputSchema: { type: "object", properties: { delegationId: id }, required: ["delegationId"], additionalProperties: false },
    },
  };
}

/**
 * 交叉评审（多 Agent 协作 S9，技术设计 2.9 / 2.11）：请求评审只有主会话有；提交评审意见只挂在评审会话上
 * （建评审会话时加上，不属于任何 scope）。
 */
export const REVIEW_TOOL_NAMES = ["suduo_review_request", "suduo_review_submit"] as const;
export type ReviewToolName = (typeof REVIEW_TOOL_NAMES)[number];

export function isReviewToolName(name: string): name is ReviewToolName {
  return (REVIEW_TOOL_NAMES as readonly string[]).includes(name);
}

function reviewSpecs(locale: Locale, d: ServerMessages["toolSpec"]): Record<ReviewToolName, RuntimeToolSpec> {
  const spec = messagesFor(locale).review.spec;
  return {
    suduo_review_request: {
      name: "suduo_review_request",
      description: spec.request.description + d.textReturn("suduo_review_request"),
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: spec.request.agentId },
          focus: { type: "array", items: { type: "string", enum: [...REVIEW_FOCUSES] }, description: spec.request.focus },
          note: { type: "string", description: spec.request.note },
        },
        required: ["agentId"],
        additionalProperties: false,
      },
    },
    suduo_review_submit: {
      name: "suduo_review_submit",
      description: spec.submit.description + d.textReturn("suduo_review_submit"),
      inputSchema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            description: spec.submit.findings,
            items: {
              type: "object",
              properties: {
                severity: { type: "string", enum: [...REVIEW_SEVERITIES], description: spec.submit.severity },
                file: { type: "string", description: spec.submit.file },
                line: { type: "integer", minimum: 1, description: spec.submit.line },
                title: { type: "string", description: spec.submit.title },
                detail: { type: "string", description: spec.submit.detail },
                suggestion: { type: "string", description: spec.submit.suggestion },
              },
              required: ["severity", "title", "detail"],
              additionalProperties: false,
            },
          },
          summary: { type: "string", description: spec.submit.summary },
        },
        required: ["findings", "summary"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * 委派出来的子会话不挂的工具（技术设计 2.9）：委派与请求评审（深度 1，R2）、对外写工具（评论由发起会话去发）。
 * 建子会话与线程重建时都用它。
 */
export function delegateChildDropsTool(name: string): boolean {
  return isDelegationToolName(name) || isReviewToolName(name) || isWriteTool(name);
}

/** 评审会话不挂的工具（技术设计 2.9）：结论笔记、对外写、委派与请求评审；另加 `review_submit`。 */
export function reviewerDropsTool(name: string): boolean {
  return isDelegationToolName(name) || isReviewToolName(name) || isWriteTool(name) || name === "suduo_notes_save";
}

/** 评审会话的工具（建评审会话时加在 scope 的工具之外）。 */
export function reviewSubmitSpec(locale: Locale): RuntimeToolSpec {
  return reviewSpecs(locale, messagesFor(locale).toolSpec).suduo_review_submit;
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
  const sessions = sessionSpecs(locale, d);
  const delegations = delegationSpecs(locale, d);
  const reviews = reviewSpecs(locale, d);
  return sessionToolNames(scope).map((name) =>
    isRoomToolName(name)
      ? rooms[name]
      : isSessionToolName(name)
        ? sessions[name]
        : isDelegationToolName(name)
          ? delegations[name]
          : isReviewToolName(name)
            ? reviews[name]
            : specs[name as ActiveSuDuoToolName],
  );
}

/** 某个 scope 下挂了哪些工具（调度时据此拒绝清单外的调用）。 */
export function sessionToolNames(scope: SessionToolScope): string[] {
  switch (scope) {
    case "requirement":
      return [...READ_TOOLS, ...WRITE_TOOLS, ...SESSION_TOOL_NAMES, ...DELEGATION_TOOL_NAMES, "suduo_review_request"];
    case "project":
      return [...READ_TOOLS, ...SESSION_TOOL_NAMES, ...DELEGATION_TOOL_NAMES, "suduo_review_request"];
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

/** 经 SuDuo 本机 MCP 工具服务（ADR-0015）下发时去掉的前缀：各家 Agent 会自己加服务名前缀（S0 实测）。 */
const MCP_TOOL_PREFIX = "suduo_";

/** 内部工具名 → MCP 工具名（suduo_requirement_get → requirement_get）。 */
export function mcpToolName(internal: string): string {
  return internal.startsWith(MCP_TOOL_PREFIX) ? internal.slice(MCP_TOOL_PREFIX.length) : internal;
}

/** MCP 工具名 → 内部工具名。 */
export function internalToolName(mcpName: string): string {
  return MCP_TOOL_PREFIX + mcpName;
}

const KNOWN_TOOL_NAMES = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS, ...ROOM_TOOL_NAMES, ...SESSION_TOOL_NAMES, ...DELEGATION_TOOL_NAMES, ...REVIEW_TOOL_NAMES]);

/** 说明与回复文字里提到的 SuDuo 工具名换成 MCP 名（只换认识的工具名，其余原样）。 */
export function mcpToolText(text: string): string {
  return text.replace(/\bsuduo_[a-z_]+/g, (name) => (KNOWN_TOOL_NAMES.has(name) ? mcpToolName(name) : name));
}

/**
 * 经 MCP 下发的工具定义：不用代码模式的写法（去掉返回格式那一句、查看类与发评论换成 MCP 版说明），
 * 工具名与说明里提到的工具名都去掉 suduo_ 前缀。参数与 schema 不变。按建线程时定下的工具清单给出，
 * 不认识的名字跳过。
 */
export function mcpToolSpecsFor(toolNames: readonly string[], locale: Locale): RuntimeToolSpec[] {
  const d = messagesFor(locale).toolSpec;
  const specs = requirementSpecs(d);
  const rooms = roomSpecs(d);
  const sessions = sessionSpecs(locale, d);
  const delegations = delegationSpecs(locale, d);
  const reviews = reviewSpecs(locale, d);
  return toolNames.flatMap((name): RuntimeToolSpec[] => {
    const spec = isRoomToolName(name)
      ? rooms[name]
      : isSessionToolName(name)
        ? sessions[name]
        : isDelegationToolName(name)
          ? delegations[name]
          : isReviewToolName(name)
            ? reviews[name]
          : KNOWN_TOOL_NAMES.has(name)
          ? specs[name as ActiveSuDuoToolName]
          : undefined;
    if (spec === undefined) return [];
    let description = spec.description.replace(d.textReturn(spec.name), "");
    if (spec.name === "suduo_attachment_view") description = d.mcp.attachmentView;
    if (spec.name === "suduo_room_file_view") description = d.mcp.roomFileView;
    if (spec.name === "suduo_comment_submit") description = d.mcp.commentSubmit;
    return [
      {
        name: mcpToolName(spec.name),
        description: mcpToolText(description).trim(),
        inputSchema: JSON.parse(mcpToolText(JSON.stringify(spec.inputSchema))) as RuntimeToolSpec["inputSchema"],
      },
    ];
  });
}

/** 某个范围的 MCP 工具定义。 */
export function mcpToolSpecs(scope: SessionToolScope, locale: Locale): RuntimeToolSpec[] {
  return mcpToolSpecsFor(sessionToolNames(scope), locale);
}
