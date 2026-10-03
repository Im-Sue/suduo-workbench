import {
  SUDUO_TOOL_NATIVE_METHOD,
  currentSuDuoToolName,
  suDuoToolLabel,
  type JsonValue,
  type SuDuoToolConfirmationDto,
} from "@suduo/client-contracts";
import { formatRequirementNumber } from "@suduo/cloud-contracts";
import { format } from "date-fns";
import { objectValue } from "./shared.js";

/**
 * 会话里的 SuDuo 工具（ADR-0008）在界面上的说法：审批坞的确认卡、时间线上的工具步骤共用。
 */

type ConfirmationFile = NonNullable<SuDuoToolConfirmationDto["publish"]>["files"][number];

/**
 * 从审批载荷里认出 SuDuo 写工具的确认卡（`nativeMethod = item/tool/call`，带 `suDuoTool`）。
 * 载荷形状对不上时返回 null，按普通审批显示。`suDuoTool` 放在载荷顶层；也兼容放在 `request` 里。
 */
export function suDuoToolConfirmationOf(payload: JsonValue): SuDuoToolConfirmationDto | null {
  const outer = objectValue(payload);
  const inner = objectValue(outer["request"]);
  const nativeMethod = outer["nativeMethod"] ?? inner["nativeMethod"];
  if (nativeMethod !== SUDUO_TOOL_NATIVE_METHOD) return null;
  const raw = objectValue(outer["suDuoTool"] ?? inner["suDuoTool"]);
  const toolName = typeof raw["tool"] === "string" ? raw["tool"].replace(/^suduo_/, "") : "";
  if (toolName !== "comment_submit" && toolName !== "artifact_publish") return null;
  const requirement = objectValue(raw["requirement"]);
  const comment = objectValue(raw["comment"]);
  const publish = objectValue(raw["publish"]);
  const duplicate = objectValue(raw["duplicateOf"]);
  const duplicateAt = timestampOf(duplicate["at"]);
  const files = Array.isArray(publish["files"]) ? publish["files"].map(fileOf).filter((file) => file !== null) : [];
  return {
    tool: toolName,
    requirement: {
      id: stringOr(requirement["id"], ""),
      projectId: stringOr(requirement["projectId"], ""),
      number: typeof requirement["number"] === "number" ? requirement["number"] : null,
      title: typeof requirement["title"] === "string" ? requirement["title"] : null,
    },
    ...(typeof comment["body"] === "string" ? { comment: { body: comment["body"] } } : {}),
    ...(toolName === "artifact_publish"
      ? { publish: { files, note: typeof publish["note"] === "string" && publish["note"].trim() !== "" ? publish["note"] : null } }
      : {}),
    duplicateOf: duplicateAt === null ? null : { at: duplicateAt },
  };
}

/** 确认卡标题：「发评论到 REQ-1「标题」」「发布确认版到 REQ-1「标题」」；编号与标题都没有时说「这条需求」。 */
export function suDuoToolConfirmationTitle(confirmation: SuDuoToolConfirmationDto): string {
  const target = requirementLabel(confirmation.requirement);
  return confirmation.tool === "comment_submit" ? `发评论到 ${target}` : `发布确认版到 ${target}`;
}

export function requirementLabel(requirement: { number: number | null; title: string | null }): string {
  const code = typeof requirement.number === "number" && requirement.number > 0 ? formatRequirementNumber(requirement.number) : null;
  const title = requirement.title !== null && requirement.title.trim() !== "" ? requirement.title.trim() : null;
  if (code !== null && title !== null) return `${code}「${title}」`;
  if (code !== null) return code;
  if (title !== null) return `「${title}」`;
  return "这条需求";
}

/** 重复提示（只告知，不拒绝；ADR-0004）：「本会话 14:32 已发过相同内容」。 */
export function duplicateNotice(confirmation: SuDuoToolConfirmationDto): string | null {
  if (confirmation.duplicateOf === null) return null;
  const at = format(confirmation.duplicateOf.at, "HH:mm");
  return confirmation.duplicateOf.pending === true
    ? `本会话还有一张相同内容的确认卡（${at}）`
    : `本会话 ${at} 已发过相同内容`;
}

/** 待发布文件的来源：项目里的文件（确认后先上传）或需求已有的附件。 */
export function publishFileSource(file: ConfirmationFile): string {
  return file.source === "path" ? `项目文件 ${file.ref}` : "已有附件";
}

/** 时间线上工具步骤的标题：认识的 suduo 工具用中文动作名，其它显示「调用 原名」。 */
export function dynamicToolTitle(tool: string): string {
  const label = suDuoToolLabel(currentSuDuoToolName(tool));
  if (label !== null) return label;
  return tool === "" ? "调用工具" : `调用 ${tool}`;
}

const COMMENT_PREVIEW_CHARS = 60;

/**
 * 工具步骤的关键参数（等宽显示）：需求编号、附件 ID、确认版号、评论开头、要发布的文件。
 * 认不出的参数（非 suduo 工具）原样给紧凑 JSON。
 */
export function dynamicToolDetail(tool: string, args: JsonValue | undefined): string {
  const value = parseArguments(args);
  const record = objectValue(value);
  const parts: string[] = [];
  const number = requirementNumberArg(record["number"]);
  if (number !== null) parts.push(formatRequirementNumber(number));
  if (typeof record["attachmentId"] === "string" && record["attachmentId"] !== "") parts.push(`附件 ${record["attachmentId"]}`);
  if (typeof record["version"] === "number") parts.push(`第 ${record["version"]} 版`);
  if (Array.isArray(record["attachmentIds"]) && record["attachmentIds"].length > 0) {
    parts.push(`附件 ${record["attachmentIds"].map(String).join("、")}`);
  }
  if (Array.isArray(record["paths"]) && record["paths"].length > 0) parts.push(record["paths"].map(String).join("、"));
  if (typeof record["body"] === "string" && record["body"].trim() !== "") parts.push(`「${clip(record["body"], COMMENT_PREVIEW_CHARS)}」`);
  if (parts.length > 0 || suDuoToolLabel(currentSuDuoToolName(tool)) !== null) return parts.join(" · ");
  return compactJson(value);
}

/** 工具结果：文本按段换行拼接，图片显示「（图片）」（服务端落库前已把图片地址换掉）。 */
export function dynamicToolOutput(contentItems: JsonValue | undefined): string {
  if (!Array.isArray(contentItems)) return "";
  return contentItems
    .map((raw) => {
      const item = objectValue(raw);
      if (item["type"] === "inputText") return typeof item["text"] === "string" ? item["text"] : "";
      if (item["type"] === "inputImage") return "（图片）";
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

function parseArguments(args: JsonValue | undefined): JsonValue | undefined {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args) as JsonValue;
  } catch {
    return args;
  }
}

function fileOf(raw: JsonValue): ConfirmationFile | null {
  const file = objectValue(raw);
  if (typeof file["name"] !== "string") return null;
  return {
    name: file["name"],
    sizeBytes: typeof file["sizeBytes"] === "number" ? file["sizeBytes"] : null,
    source: file["source"] === "path" ? "path" : "attachment",
    ref: stringOr(file["ref"], ""),
  };
}

function timestampOf(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function stringOr(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function compactJson(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** 工具参数里的需求编号：数字、「12」或「REQ-12」都认（服务端同样都接受）。 */
function requirementNumberArg(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const match = /^(?:req[-\s]?|#)?(\d{1,9})$/iu.exec(value.trim());
  return match ? Number(match[1]) : null;
}
