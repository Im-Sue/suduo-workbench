import type {
  AiActivityDto,
  HandoffContent,
  ListAiActivityResponse,
  ListProjectAiRulesVersionsResponse,
  ListSharedItemsResponse,
  ProjectAiRulesDto,
  ProjectAiRulesVersionDetailDto,
  PublishSharedItemRequest,
  RecordAiActivityRequest,
  ReviewFindingSeverity,
  ReviewReportContent,
  SaveProjectAiRulesResponse,
  SharedItemContent,
  SharedItemDetailDto,
  SharedItemKind,
  SnapshotContent,
} from "@suduo/cloud-contracts";
import { PROJECT_AI_RULES_MAX_BYTES, SHARED_ITEM_FIELD_LIMITS, SHARED_ITEM_MAX_BYTES, SHARED_ITEM_TITLE_MAX } from "@suduo/cloud-contracts";
import type { AiCollabRepository } from "../infrastructure/ai-collab-repository.js";
import { ApplicationError } from "./errors.js";

const LIMITS = SHARED_ITEM_FIELD_LIMITS;
/** 协作记录的本机发生时间最多比服务器时间晚这么多（容忍时钟偏差）。 */
const OCCURRED_AT_SKEW_MS = 5 * 60_000;
const SEVERITIES: ReadonlySet<string> = new Set<ReviewFindingSeverity>(["high", "medium", "low", "info"]);

/**
 * 多 Agent 协作的团队共享部分（技术设计 2.13）：需求共享对象的发布、列表、读取、撤回；项目 AI 规范的读取、保存与历史版本；
 * 协作记录的上报与列表。写库前的字符串都去掉 NUL、把孤立的代理字符换成 U+FFFD（Agent 输出里会有，PostgreSQL 不收）。
 * 内容按种类规整：结构不对报参数错；单个字段超长截断并在回包里列出（不因为一条超长命令拒掉整份）；只有超过总大小才报错。
 */
export class AiCollabService {
  constructor(private readonly repository: AiCollabRepository) {}

  async publish(actorId: string, requirementId: string, request: PublishSharedItemRequest): Promise<{ item: SharedItemDetailDto; projectId: string }> {
    const truncated: string[] = [];
    const content = normalizeContent(request.kind, request.content, truncated);
    const sizeBytes = Buffer.byteLength(JSON.stringify(content), "utf8");
    const limit = SHARED_ITEM_MAX_BYTES[request.kind];
    if (sizeBytes > limit) {
      throw new ApplicationError(400, "VALIDATION_ERROR", `Shared item content is ${String(sizeBytes)} bytes; the limit for ${request.kind} is ${String(limit)} bytes`, {
        sizeBytes,
        limit,
      });
    }
    const title = clip(clean(request.title).trim(), SHARED_ITEM_TITLE_MAX, "title", truncated);
    const { item, projectId } = await this.repository.publishSharedItem({
      actorId,
      requirementId,
      kind: request.kind,
      title: title === "" ? request.kind : title,
      content,
      sizeBytes,
      agentId: request.agentId ?? null,
      sessionRef: request.sessionRef === undefined || request.sessionRef === null || clean(request.sessionRef) === "" ? null : clean(request.sessionRef),
    });
    return { item: truncated.length === 0 ? item : { ...item, truncatedFields: truncated }, projectId };
  }

  async list(requirementId: string): Promise<ListSharedItemsResponse> {
    return { items: await this.repository.listSharedItems(requirementId) };
  }

  read(itemId: string, readerId: string): Promise<SharedItemDetailDto> {
    return this.repository.readSharedItem(itemId, readerId);
  }

  /**
   * 撤回：项目成员都能撤（记下是谁、显示出来；发布人本机的草稿还在，可以重新发布）。已被读过的照样撤回，
   * 回包里的 readCount 用来说明「已读过的无法收回」。
   */
  retract(itemId: string, actorId: string): Promise<{ item: SharedItemDetailDto; changed: boolean; projectId: string }> {
    return this.repository.retractSharedItem(itemId, actorId);
  }

  rules(projectId: string): Promise<ProjectAiRulesDto> {
    return this.repository.currentRules(projectId);
  }

  async ruleVersions(projectId: string): Promise<ListProjectAiRulesVersionsResponse> {
    return { items: await this.repository.listRuleVersions(projectId) };
  }

  ruleVersion(projectId: string, version: number): Promise<ProjectAiRulesVersionDetailDto> {
    return this.repository.getRuleVersion(projectId, version);
  }

  async saveRules(projectId: string, actorId: string, content: string, baseVersion?: number): Promise<{ rules: SaveProjectAiRulesResponse; changed: boolean }> {
    const cleaned = clean(content);
    const sizeBytes = Buffer.byteLength(cleaned, "utf8");
    if (sizeBytes > PROJECT_AI_RULES_MAX_BYTES) {
      throw new ApplicationError(400, "VALIDATION_ERROR", `AI rules are ${String(sizeBytes)} bytes; the limit is ${String(PROJECT_AI_RULES_MAX_BYTES)} bytes`, {
        sizeBytes,
        limit: PROJECT_AI_RULES_MAX_BYTES,
      });
    }
    return this.repository.saveRules(projectId, actorId, cleaned, baseVersion);
  }

  /**
   * 上报协作记录。本机发生时间钳到服务器时间之后最多 5 分钟：本机时钟偏快时，带着未来时间的一条不会让之后的正常上报
   * 一直被当成「旧的」而忽略。
   */
  record(actorId: string, requirementId: string, request: RecordAiActivityRequest): Promise<{ activity: AiActivityDto; projectId: string; changed: boolean }> {
    const branch = typeof request.branch === "string" && clean(request.branch).trim() !== "" ? clean(request.branch).trim() : null;
    const reported = request.occurredAt === undefined ? new Date() : new Date(request.occurredAt);
    if (Number.isNaN(reported.getTime())) throw new ApplicationError(400, "VALIDATION_ERROR", "Invalid occurredAt", { field: "occurredAt" });
    const occurredAt = new Date(Math.min(reported.getTime(), Date.now() + OCCURRED_AT_SKEW_MS));
    const localRef = clean(request.localRef);
    if (localRef === "") throw new ApplicationError(400, "VALIDATION_ERROR", "Invalid localRef", { field: "localRef" });
    return this.repository.recordActivity({
      actorId,
      requirementId,
      localRef,
      agentId: request.agentId,
      kind: request.kind,
      status: request.status,
      branch,
      occurredAt,
    });
  }

  async activity(requirementId: string): Promise<ListAiActivityResponse> {
    return { items: await this.repository.listActivity(requirementId) };
  }
}

/**
 * 按种类规整内容：只留约定的字段；字符串去 NUL、换掉孤立代理；超长的截断并记在 `truncated`（字段路径）；
 * 列表超出条数截掉多余的。类型不对（该是文字的不是文字）报参数错。
 */
export function normalizeContent(kind: SharedItemKind, raw: unknown, truncated: string[] = []): SharedItemContent {
  const value = object(raw, "content");
  const text = (input: unknown, field: string, max: number): string => clip(clean(requireString(input, field)), max, field, truncated);
  const nullableText = (input: unknown, field: string, max: number): string | null => (input === undefined || input === null ? null : text(input, field, max));
  const list = (input: unknown, field: string, max: number): unknown[] => {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) invalid(field);
    if (input.length > max) truncated.push(field);
    return input.slice(0, max);
  };
  const strings = (input: unknown, field: string): string[] => list(input, field, LIMITS.list).map((item, index) => text(item, `${field}[${String(index)}]`, LIMITS.item));
  if (kind === "handoff") {
    const content: HandoffContent = {
      summary: text(value["summary"], "content.summary", LIMITS.text),
      decisions: strings(value["decisions"], "content.decisions"),
      todo: strings(value["todo"], "content.todo"),
      risks: strings(value["risks"], "content.risks"),
      branch: nullableText(value["branch"], "content.branch", 255),
      files: strings(value["files"], "content.files"),
    };
    return content;
  }
  if (kind === "review") {
    const findings = list(value["findings"], "content.findings", LIMITS.findings).map((entry, index) => {
      const field = `content.findings[${String(index)}]`;
      const finding = object(entry, field);
      const severity = finding["severity"];
      if (typeof severity !== "string" || !SEVERITIES.has(severity)) invalid(`${field}.severity`);
      const line = finding["line"];
      return {
        severity: severity as ReviewFindingSeverity,
        file: nullableText(finding["file"], `${field}.file`, LIMITS.short),
        line: Number.isSafeInteger(line) && (line as number) >= 1 ? (line as number) : null,
        title: text(finding["title"], `${field}.title`, LIMITS.short),
        detail: text(finding["detail"], `${field}.detail`, LIMITS.item),
        suggestion: nullableText(finding["suggestion"], `${field}.suggestion`, LIMITS.item),
      };
    });
    const content: ReviewReportContent = {
      summary: text(value["summary"], "content.summary", LIMITS.text),
      findings,
      targetAgentId: nullableText(value["targetAgentId"], "content.targetAgentId", 32),
    };
    return content;
  }
  const rounds = list(value["rounds"], "content.rounds", LIMITS.rounds).map((entry, index) => {
    const field = `content.rounds[${String(index)}]`;
    const round = object(entry, field);
    const startedAt = round["startedAt"];
    return {
      userText: text(round["userText"], `${field}.userText`, LIMITS.text),
      answer: nullableText(round["answer"], `${field}.answer`, LIMITS.text),
      files: strings(round["files"], `${field}.files`),
      commands: list(round["commands"], `${field}.commands`, LIMITS.list).map((item, commandIndex) => {
        const command = object(item, `${field}.commands[${String(commandIndex)}]`);
        const exitCode = command["exitCode"];
        return {
          command: text(command["command"], `${field}.commands[${String(commandIndex)}].command`, LIMITS.item),
          exitCode: Number.isSafeInteger(exitCode) ? (exitCode as number) : null,
        };
      }),
      startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : null,
    };
  });
  const content: SnapshotContent = { rounds };
  return content;
}

/** 去掉 NUL，把孤立的代理字符换成 U+FFFD（PostgreSQL 的 text / jsonb 都不收）。 */
export function clean(value: string): string {
  return value.replaceAll("\u0000", "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** 超长截断（按字符，不切开代理对），加「…」并记下字段。 */
function clip(value: string, max: number, field: string, truncated: string[]): string {
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  truncated.push(field);
  return characters.slice(0, Math.max(0, max - 1)).join("") + "…";
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field);
  return value;
}

function invalid(field: string): never {
  throw new ApplicationError(400, "VALIDATION_ERROR", `Invalid ${field}`, { field });
}
