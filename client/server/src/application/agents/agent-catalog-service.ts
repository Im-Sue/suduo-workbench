import type {
  AgentActionDto,
  AgentDto,
  AgentListDto,
  AgentSettingsDto,
  AgentStatus,
  AgentStatusReasonCode,
  UpdateAgentSettingsRequest,
} from "@suduo/client-contracts";
import { ApiError, type ErrorText } from "../api-error.js";
import { AGENT_CATALOG, type AgentDescriptor, validateAgentCatalog } from "./catalog.js";
import { agentChildEnv, execAgentCommand, type AgentExec } from "./agent-exec.js";
import type { AgentSettingsStore } from "./agent-settings-store.js";
import { resolveExecutable, type ResolveExecutableOptions } from "./resolver.js";

/** Node 写的 CLI 冷启动慢，八家并行检测时更慢（OpenCode 冷启动单跑就要 3 秒）。 */
const VERSION_TIMEOUT_MS = 20_000;
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
  private readonly authFailures = new Set<string>();

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

  /**
   * 不等检测：有缓存给缓存，没有的标「检测中」并在后台开始检测（八家并行检测要好几秒，Node 写的 CLI 启动慢）。
   * 界面先出列表，再轮询把状态补上。
   */
  listNow(): AgentListDto {
    const agents = this.catalog.map((descriptor) => {
      const cached = this.cache.get(descriptor.id);
      if (cached !== undefined && cached.expiresAt > this.now()) {
        return cached.dto;
      }
      void this.status(descriptor, false).catch(() => undefined);
      return cached?.dto ?? this.placeholder(descriptor);
    });
    return { defaultAgentId: this.options.store.defaultAgentId(), agents };
  }

  private placeholder(descriptor: AgentDescriptor): AgentDto {
    const setting = this.options.store.entry(descriptor.id);
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      vendor: descriptor.vendor,
      channel: descriptor.channel,
      bundled: descriptor.bundled,
      runtimeAvailable: descriptor.runtimeAvailable,
      enabled: setting.enabled,
      status: "checking",
      reasonCode: null,
      reasonDetail: null,
      version: null,
      minVersion: descriptor.minVersion,
      verifiedVersion: descriptor.verifiedVersion,
      executablePath: null,
      actions: [],
      capabilities: [...descriptor.capabilities],
      readOnlyCapable: descriptor.readOnlyCapable,
      homepageUrl: descriptor.homepageUrl,
      termsUrl: descriptor.termsUrl,
      checkedAt: null,
    };
  }

  /**
   * 这家 Agent 能不能在讨论里替别人执行（多 Agent S6，ADR-0009 只读红线）：SuDuo 接上了、做得到只读、没在设置里停用。
   * 能返回 null，不能返回原因。登记、执行房间任务前都按它判断（配置表以后改了，老设备文件里的种类也跟着失效）。
   */
  roomAgentProblem(agentId: string): ErrorText | null {
    const descriptor = this.catalog.find((agent) => agent.id === agentId);
    if (descriptor === undefined || !descriptor.runtimeAvailable) return (t) => t.room.agentUnsupported(agentId);
    if (!descriptor.readOnlyCapable) return (t) => t.room.agentNotReadOnly(descriptor.displayName);
    if (!this.options.store.entry(agentId).enabled) return (t) => t.room.agentDisabled(descriptor.displayName);
    return null;
  }

  /** 重新检测（用户登录后点的）：之前运行中记下的登录失败也一并放下，下次用到时再确认。 */
  async recheck(agentId: string): Promise<AgentDto> {
    this.authFailures.delete(agentId);
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
  /**
   * 运行中 Agent 报了需要登录：记下来，直到它下次正常开出会话、或用户登录后点「重新检测」。
   * ACP 的登录状态没有不留痕迹的检查办法（检查要建会话），只能这样在用到时确认。
   */
  markAuthRequired(agentId: string): void {
    this.authFailures.add(agentId);
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

  /** Agent 正常开出了会话：之前记的「需要登录」作废。 */
  markAuthOk(agentId: string): void {
    if (!this.authFailures.delete(agentId)) {
      return;
    }
    this.cache.delete(agentId);
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
      .then((detected) => {
        // 检测命令看不出登录状态的 Agent：用运行中记下的登录失败。
        const dto: AgentDto =
          descriptor.auth === "acp-session-probe" && this.authFailures.has(descriptor.id) && (detected.status === "installed" || detected.status === "ready")
            ? { ...detected, status: "auth_required", reasonCode: "not_logged_in", actions: this.actionsFor(descriptor, "auth_required") }
            : detected;
        const ready = dto.status === "ready" || dto.status === "installed";
        this.cache.set(descriptor.id, { dto, expiresAt: this.now() + (ready ? READY_TTL_MS : NOT_READY_TTL_MS) });
        return dto;
      })
      .finally(() => this.inflight.delete(descriptor.id));
    this.inflight.set(descriptor.id, check);
    return check;
  }

  /** 这家 Agent 的可执行文件（用户填的路径优先，其次 PATH 与常见安装目录）；找不到为 null。运行时启动时也用它。 */
  executablePath(agentId: string): string | null {
    const descriptor = this.descriptor(agentId);
    if (descriptor.bundled) {
      return this.options.codexBin;
    }
    const setting = this.options.store.entry(descriptor.id);
    return this.resolve(descriptor.binaryNames, { override: setting.binOverride, env: this.env, platform: this.platform });
  }

  private async detect(descriptor: AgentDescriptor): Promise<AgentDto> {
    const setting = this.options.store.entry(descriptor.id);
    const env = agentChildEnv(this.env);
    const executablePath = this.executablePath(descriptor.id);
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
      // 找到了、只是版本读得太慢：照样能用，标明没读到版本（告知，不拦，ADR-0004）。
      return base("installed", "check_timeout");
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
