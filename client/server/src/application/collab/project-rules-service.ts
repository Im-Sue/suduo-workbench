import type { Locale, SessionAiRulesDto } from "@suduo/client-contracts";
import type { ProjectAiRulesDto, ProjectAiRulesVersionDetailDto } from "@suduo/cloud-contracts";
import { messagesFor } from "../../i18n/messages/index.js";
import type { SessionRecord } from "../../infrastructure/db/repositories/session-repository.js";
import { ApiError } from "../api-error.js";
import { aiRulesLines } from "./ai-rules-text.js";
import type { SchedulerSource } from "../scheduler/turn-scheduler.js";

/**
 * 进行中的会话遇到项目 AI 规范的新版本（多 Agent 协作 S11，需求 4.8）：会话记着开工 / 重建线程时注入的版本，
 * 界面按它提示「有新版本」；用户看过内容、确认后往会话里发一条带这一版规范的消息（经本机调度，时间线可见；
 * 材料口吻、带边界，说明不能改 SuDuo 的规则与会话角色），并记下这一版。
 * 不改线程的开场说明（各家 Agent 都不支持中途换），也不改仓库里的 AGENTS.md 等（R12）。
 */
export class ProjectRulesService {
  constructor(
    private readonly deps: {
      sessions: { getById(sessionId: string): SessionRecord | null; setRulesVersion(sessionId: string, version: number | null): void };
      /** 会话所属的远程项目（需求会话、项目会话）；本机会话为 null。 */
      remoteProjectOf(sessionId: string): string | null;
      remote: {
        getProjectAiRules(projectId: string): Promise<ProjectAiRulesDto>;
        getProjectAiRulesVersion(projectId: string, version: number): Promise<ProjectAiRulesVersionDetailDto>;
      };
      messages: {
        send(
          sessionId: string,
          input: { content: Array<{ type: "text"; text: string }> },
          idempotencyKey: string,
          options: { locale?: Locale; source?: SchedulerSource; label?: string },
        ): Promise<unknown>;
      };
    },
  ) {}

  /** 会话用的版本与项目当前的版本；没关联项目、读不到（老服务器、连不上）时 current 为 null。 */
  async status(sessionId: string): Promise<SessionAiRulesDto> {
    const session = this.deps.sessions.getById(sessionId);
    if (session === null) throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    const current = await this.current(sessionId);
    return {
      used: session.rulesVersion ?? null,
      current:
        current === null
          ? null
          : { version: current.version, content: current.content, updatedBy: current.updatedBy?.displayName ?? null, updatedAt: current.updatedAt },
    };
  }

  /**
   * 把用户看过的那一版发进会话，记下版本。期间又存了新版本也照发这一版（用户确认的是它），提示照旧留着。
   * 消息进的是发送队列：用户之后从队列里删掉它的话，这里记下的版本会比 Agent 实际读到的新（技术设计「偏差与遗留」）。
   */
  async apply(sessionId: string, version: number, locale: Locale): Promise<SessionAiRulesDto> {
    const session = this.deps.sessions.getById(sessionId);
    if (session === null) throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    const projectId = this.deps.remoteProjectOf(sessionId);
    if (projectId === null) throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.rulesUnavailable);
    const rules = await this.deps.remote.getProjectAiRulesVersion(projectId, version);
    if (rules.content.trim() === "") throw new ApiError(400, "VALIDATION_ERROR", (t) => t.sharedDraft.rulesUnavailable);
    // 发给 Agent 的文字按会话的语言（与开场注入的一致）；时间线上的标签按界面的语言。
    const text = messagesFor(session.locale).sharedDraft.rulesApplyMessage(rules.version, aiRulesLines(session.locale, rules.version, rules.content).join("\n"));
    await this.deps.messages.send(sessionId, { content: [{ type: "text", text }] }, `ai-rules:${sessionId}:${String(rules.version)}`, {
      locale,
      source: "user",
      label: messagesFor(locale).sharedDraft.rulesApplyLabel(rules.version),
    });
    this.deps.sessions.setRulesVersion(sessionId, rules.version);
    return this.status(sessionId);
  }

  private async current(sessionId: string): Promise<ProjectAiRulesDto | null> {
    const projectId = this.deps.remoteProjectOf(sessionId);
    if (projectId === null) return null;
    const rules = await this.deps.remote.getProjectAiRules(projectId).catch(() => null);
    return rules === null || rules.version === 0 || rules.content.trim() === "" ? null : rules;
  }
}
