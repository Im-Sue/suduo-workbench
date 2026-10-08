import type {
  AgentActionDto,
  AgentDto,
  AgentListDto,
  AgentSettingsDto,
  AgentStatus,
  AgentStatusReasonCode,
  UpdateAgentSettingsRequest,
} from "@suduo/client-contracts";
import { ApiError } from "../api-error.js";
import { AGENT_CATALOG, type AgentDescriptor, validateAgentCatalog } from "./catalog.js";
import { agentChildEnv, execAgentCommand, type AgentExec } from "./agent-exec.js";
import type { AgentSettingsStore } from "./agent-settings-store.js";
import { resolveExecutable, type ResolveExecutableOptions } from "./resolver.js";

const VERSION_TIMEOUT_MS = 8_000;
const AUTH_TIMEOUT_MS = 12_000;
/** 检测结果缓存：成功 10 分钟、不成功 1 分钟（技术设计 4.6）。 */
const READY_TTL_MS = 10 * 60_000;
const NOT_READY_TTL_MS = 60_000;

export interface AgentCatalogServiceOptions {
  store: AgentSettingsStore;
  /** 随 SuDuo 捆绑的 Codex 可执行文件。 */
  codexBin: string;
  catalog?: readonly AgentDescriptor[];
  exec?: AgentExec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  resolve?: (names: readonly string[], options: ResolveExecutableOptions) => string | null;
}

interface CachedStatus {
  dto: AgentDto;
  expiresAt: number;
}

/**
 * 本机 Agent 的列表、检测与设置（多 Agent S1，ADR-0014 / ADR-0016）。
 * 只用各家 CLI 自己的命令判断版本与登录状态，不读任何凭据文件。
 */
export class AgentCatalogService {
  private readonly catalog: readonly AgentDescriptor[];
  private readonly exec: AgentExec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly resolve: (names: readonly string[], options: ResolveExecutableOptions) => string | null;
  private readonly cache = new Map<string, CachedStatus>();
  private readonly inflight = new Map<string, Promise<AgentDto>>();

  constructor(private readonly options: AgentCatalogServiceOptions) {
    this.catalog = options.catalog ?? AGENT_CATALOG;
    validateAgentCatalog(this.catalog);
    this.exec = options.exec ?? execAgentCommand;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.resolve = options.resolve ?? resolveExecutable;
  }

  descriptor(agentId: string): AgentDescriptor {
    const descriptor = this.catalog.find((agent) => agent.id === agentId);
    if (!descriptor) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.http.agentNotFound(agentId));
    }
    return descriptor;
  }

  async list(): Promise<AgentListDto> {
    const agents = await Promise.all(this.catalog.map((descriptor) => this.status(descriptor, false)));
    return { defaultAgentId: this.options.store.defaultAgentId(), agents };
  }

  async recheck(agentId: string): Promise<AgentDto> {
    return this.status(this.descriptor(agentId), true);
  }

  settings(): AgentSettingsDto {
    return {
      defaultAgentId: this.options.store.defaultAgentId(),
      agents: this.catalog.map((agent) => ({ id: agent.id, ...this.options.store.entry(agent.id) })),
    };
  }

  updateSettings(input: UpdateAgentSettingsRequest): AgentSettingsDto {
    if (input.defaultAgentId !== undefined) {
      this.descriptor(input.defaultAgentId);
    }
    for (const change of input.agents ?? []) {
      this.descriptor(change.id);
      if (change.enabled !== undefined && typeof change.enabled !== "boolean") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.mustBeBoolean("enabled"));
      }
      if (change.binOverride !== undefined && change.binOverride !== null && typeof change.binOverride !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.agentBinOverrideInvalid);
      }
    }
    this.options.store.update(input);
    for (const change of input.agents ?? []) {
      this.cache.delete(change.id);
    }
    return this.settings();
  }

  /** 官方登录命令（ADR-0016：登录由用户在官方流程里完成）。 */
  loginCommand(agentId: string): string {
    const descriptor = this.descriptor(agentId);
    if (descriptor.loginCommand === null) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.http.agentLoginUnsupported(descriptor.displayName));
    }
    return descriptor.loginCommand;
  }

  /** 运行时发现鉴权失败时调用：把状态回灌为「需要登录」，不用等缓存过期。 */
  markAuthRequired(agentId: string): void {
    const cached = this.cache.get(agentId);
    if (!cached) {
      return;
    }
    const dto: AgentDto = {
      ...cached.dto,
      status: "auth_required",
      reasonCode: "not_logged_in",
      reasonDetail: null,
      checkedAt: this.now(),
    };
    dto.actions = this.actionsFor(this.descriptor(agentId), dto.status);
    this.cache.set(agentId, { dto, expiresAt: this.now() + NOT_READY_TTL_MS });
  }

  private status(descriptor: AgentDescriptor, force: boolean): Promise<AgentDto> {
    const cached = this.cache.get(descriptor.id);
    if (!force && cached && cached.expiresAt > this.now()) {
      return Promise.resolve(cached.dto);
    }
    const running = this.inflight.get(descriptor.id);
    if (running) {
      return running;
    }
    const check = this.detect(descriptor)
      .then((dto) => {
        const ready = dto.status === "ready" || dto.status === "installed";
        this.cache.set(descriptor.id, { dto, expiresAt: this.now() + (ready ? READY_TTL_MS : NOT_READY_TTL_MS) });
        return dto;
      })
      .finally(() => this.inflight.delete(descriptor.id));
    this.inflight.set(descriptor.id, check);
    return check;
  }

  private async detect(descriptor: AgentDescriptor): Promise<AgentDto> {
    const setting = this.options.store.entry(descriptor.id);
    const env = agentChildEnv(this.env);
    const executablePath = descriptor.bundled
      ? this.options.codexBin
      : this.resolve(descriptor.binaryNames, { override: setting.binOverride, env: this.env, platform: this.platform });
    const base = (status: AgentStatus, reasonCode: AgentStatusReasonCode | null, extra: Partial<AgentDto> = {}): AgentDto => {
      const dto: AgentDto = {
        id: descriptor.id,
        displayName: descriptor.displayName,
        vendor: descriptor.vendor,
        channel: descriptor.channel,
        bundled: descriptor.bundled,
        runtimeAvailable: descriptor.runtimeAvailable,
        enabled: setting.enabled,
        status,
        reasonCode,
        reasonDetail: null,
        version: null,
        minVersion: descriptor.minVersion,
        verifiedVersion: descriptor.verifiedVersion,
        executablePath: executablePath ?? null,
        actions: [],
        capabilities: [...descriptor.capabilities],
        readOnlyCapable: descriptor.readOnlyCapable,
        homepageUrl: descriptor.homepageUrl,
        termsUrl: descriptor.termsUrl,
        checkedAt: this.now(),
        ...extra,
      };
      dto.actions = this.actionsFor(descriptor, dto.status);
      return dto;
    };

    if (executablePath === null) {
      return base("not_installed", "binary_not_found");
    }
    const versionRun = await this.exec(executablePath, descriptor.versionArgs, { timeoutMs: VERSION_TIMEOUT_MS, env });
    if (versionRun.spawnError !== null) {
      return base("not_installed", "binary_not_found", { reasonDetail: versionRun.spawnError });
    }
    if (versionRun.timedOut) {
      return base("error", "check_timeout");
    }
    const version = parseVersion(versionRun.stdout + "\n" + versionRun.stderr);
    if (version !== null && descriptor.minVersion !== null && compareVersions(version, descriptor.minVersion) < 0) {
      return base("version_unsupported", "version_below_minimum", { version, reasonDetail: version });
    }
    const versionNote: Partial<AgentDto> = version === null
      ? { reasonCode: "version_unreadable", reasonDetail: firstLine(versionRun.stdout || versionRun.stderr) }
      : {};

    switch (descriptor.auth) {
      case "bundled-codex":
        return base("ready", null, { version, ...versionNote });
      case "acp-session-probe":
        // 登录状态要等 ACP 运行时（S4）用 session/new 的鉴权错误判断；在那之前只能说「已安装」。
        return base("installed", versionNote.reasonCode ?? null, { version, reasonDetail: versionNote.reasonDetail ?? null });
      case "claude-auth-status": {
        const authRun = await this.exec(executablePath, ["auth", "status"], { timeoutMs: AUTH_TIMEOUT_MS, env });
        if (authRun.timedOut) {
          return base("installed", "check_timeout", { version });
        }
        const loggedIn = parseClaudeLoggedIn(authRun.stdout);
        if (loggedIn === true) {
          return base("ready", versionNote.reasonCode ?? null, { version, reasonDetail: versionNote.reasonDetail ?? null });
        }
        if (loggedIn === false) {
          return base("auth_required", "not_logged_in", { version });
        }
        return base("installed", "auth_check_failed", { version, reasonDetail: authRun.exitCode === null ? null : `exit ${authRun.exitCode}` });
      }
    }
  }

  private actionsFor(descriptor: AgentDescriptor, status: AgentStatus): AgentActionDto[] {
    const actions: AgentActionDto[] = [];
    const install = this.platform === "win32" ? descriptor.install.windows : descriptor.install.unix;
    if (status === "not_installed" && install !== null) {
      actions.push({ kind: "copy_install_command", command: install });
    }
    if ((status === "auth_required" || status === "installed") && descriptor.loginCommand !== null) {
      actions.push({ kind: "open_terminal_login", command: descriptor.loginCommand });
    }
    if (status === "version_unsupported" && install !== null) {
      actions.push({ kind: "copy_install_command", command: install });
    }
    actions.push({ kind: "recheck" });
    actions.push({ kind: "open_homepage", url: descriptor.homepageUrl });
    return actions;
  }
}

/** 从 `--version` 输出里取第一个版本号（如「2.1.284 (Claude Code)」「GitHub Copilot CLI 1.0.93.」）。 */
export function parseVersion(output: string): string | null {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output);
  return match ? match[1]! : null;
}

/** 只比较主、次、修订号；预发布标记忽略（只用于「低于最低版本」的判断）。 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * `claude auth status` 输出 JSON（S0 实测：loggedIn、authMethod、apiProvider、邮箱、组织……）。
 * 只读 loggedIn；邮箱、组织等不读不存（ADR-0016）。读不出返回 null。
 */
export function parseClaudeLoggedIn(stdout: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed !== null && typeof parsed === "object" && "loggedIn" in parsed) {
      const value = (parsed as { loggedIn: unknown }).loggedIn;
      return typeof value === "boolean" ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).find((part) => part.trim() !== "");
  return line === undefined ? null : line.trim().slice(0, 200);
}
