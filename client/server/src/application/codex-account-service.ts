import type {
  CodexAccountDto,
  CodexLoginStartDto,
  CodexLoginStatusDto,
  CodexTransportFactory,
  JsonValue,
  RpcConnection,
} from "@suduo/client-contracts";
import { initializeCodexConnection } from "../infrastructure/transport/stdio-codex-transport.js";
import { ApiError } from "./api-error.js";

/** 登录要在这么久里完成，过时自动取消（用户可以再点一次）。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 登录结束后状态再留一会儿，前端轮询还能取到结果。 */
const FINISHED_KEEP_MS = 10 * 60_000;

interface LoginEntry {
  loginId: string;
  connection: RpcConnection | null;
  status: CodexLoginStatusDto["status"];
  error: string | null;
  finishedAt: number | null;
  abort: AbortController;
  timer: NodeJS.Timeout | null;
}

/**
 * 用 ChatGPT 账号登录 Codex（桌面应用 D2，需求 4.5，技术设计 4.5）：每次登录单独起一个 `codex app-server`
 * （CODEX_HOME 与会话一致），`account/login/start` 拿到授权地址；用户在系统浏览器里授权，回调由 Codex 自己的本地服务
 * 处理，SuDuo 只等 `account/login/completed`。凭据由 Codex 写进它的配置目录，SuDuo 不经手（R4）。
 * 同一时间只留一次登录：再点「登录」时先取消上一次（不是拒绝，用户总能重新开始）。
 */
export class CodexAccountService {
  private readonly logins = new Map<string, LoginEntry>();
  private current: LoginEntry | null = null;

  constructor(
    private readonly deps: {
      transport: CodexTransportFactory;
      codexBin: string;
      /** 交给 Codex 的环境（含 CODEX_HOME 与代理设置，同会话用的那份）。 */
      env: () => Record<string, string>;
      now?: () => number;
      loginTimeoutMs?: number;
      /** 登录成功、退出登录之后：让会话用的 Codex 进程用上新的登录（本机服务在没有进行中的回合时重连）。 */
      onAccountChanged?: () => void;
      log?: (line: Record<string, unknown>) => void;
    },
  ) {}

  async account(): Promise<CodexAccountDto> {
    const result = await this.once((connection) => connection.request("account/read", { refreshToken: false }, { timeoutMs: REQUEST_TIMEOUT_MS }));
    const value = objectOf(result);
    const account = value["account"] === null || value["account"] === undefined ? null : objectOf(value["account"]);
    const requiresOpenaiAuth = value["requiresOpenaiAuth"] === true;
    if (account === null) return { mode: "none", email: null, plan: null, requiresOpenaiAuth };
    switch (account["type"]) {
      case "chatgpt":
        return { mode: "chatgpt", email: stringOrNull(account["email"]), plan: stringOrNull(account["planType"]), requiresOpenaiAuth };
      case "apiKey":
        return { mode: "apiKey", email: null, plan: null, requiresOpenaiAuth };
      default:
        return { mode: "other", email: null, plan: null, requiresOpenaiAuth };
    }
  }

  async startLogin(): Promise<CodexLoginStartDto> {
    if (this.current !== null && this.current.status === "pending") await this.finish(this.current, "cancelled", null, true);
    this.prune();
    const abort = new AbortController();
    const connection = await this.connect(abort.signal);
    let response: Record<string, JsonValue>;
    try {
      response = objectOf(await connection.request("account/login/start", { type: "chatgpt" }, { timeoutMs: REQUEST_TIMEOUT_MS }));
    } catch (error) {
      abort.abort();
      await connection.close("login start failed").catch(() => undefined);
      throw this.unavailable(error);
    }
    const loginId = stringOrNull(response["loginId"]);
    const authUrl = stringOrNull(response["authUrl"]);
    if (loginId === null || authUrl === null || !isHttpsUrl(authUrl)) {
      abort.abort();
      await connection.close("login start invalid").catch(() => undefined);
      throw new ApiError(502, "DEPENDENCY_UNAVAILABLE", (t) => t.codexAccount.invalidResponse);
    }
    const entry: LoginEntry = { loginId, connection, status: "pending", error: null, finishedAt: null, abort, timer: null };
    entry.timer = setTimeout(() => void this.finish(entry, "failed", "timeout", true), this.deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
    entry.timer.unref();
    this.logins.set(loginId, entry);
    this.current = entry;
    void this.watch(entry);
    return { loginId, authUrl };
  }

  status(loginId: string): CodexLoginStatusDto {
    const entry = this.logins.get(loginId);
    if (entry === undefined) throw new ApiError(404, "NOT_FOUND", (t) => t.codexAccount.loginNotFound);
    return { status: entry.status, error: entry.error };
  }

  async cancel(loginId: string): Promise<CodexLoginStatusDto> {
    const entry = this.logins.get(loginId);
    if (entry === undefined) throw new ApiError(404, "NOT_FOUND", (t) => t.codexAccount.loginNotFound);
    if (entry.status === "pending") await this.finish(entry, "cancelled", null, true);
    return { status: entry.status, error: entry.error };
  }

  async logout(): Promise<CodexAccountDto> {
    await this.once((connection) => connection.request("account/logout", undefined, { timeoutMs: REQUEST_TIMEOUT_MS }));
    this.deps.onAccountChanged?.();
    return this.account();
  }

  /** 本机服务退出时：还在等的登录都取消，临时进程都关掉。 */
  async dispose(): Promise<void> {
    await Promise.all([...this.logins.values()].filter((entry) => entry.status === "pending").map((entry) => this.finish(entry, "cancelled", null, true)));
  }

  private async watch(entry: LoginEntry): Promise<void> {
    const connection = entry.connection;
    if (connection === null) return;
    try {
      for await (const message of connection.messages({ signal: entry.abort.signal })) {
        if (message.kind === "server-request") {
          // 登录用不到 Codex 发来的请求：如实回不支持，免得它一直等。
          await connection.respondError(message.id, -32601, "not supported by SuDuo login").catch(() => undefined);
          continue;
        }
        if (message.kind !== "notification" || message.method !== "account/login/completed") continue;
        const params = objectOf(message.params);
        const id = params["loginId"];
        if (id !== null && id !== undefined && id !== entry.loginId) continue;
        if (params["success"] === true) await this.finish(entry, "succeeded", null, false);
        else await this.finish(entry, "failed", stringOrNull(params["error"]) ?? "failed", false);
        return;
      }
    } catch (error) {
      if (entry.status === "pending") await this.finish(entry, "failed", error instanceof Error ? error.message : String(error), false);
      return;
    }
    // 连接断了（Codex 退出）还没等到结果。
    if (entry.status === "pending") await this.finish(entry, "failed", "codex exited", false);
  }

  private async finish(entry: LoginEntry, status: CodexLoginStatusDto["status"], error: string | null, cancelInCodex: boolean): Promise<void> {
    if (entry.status !== "pending") return;
    entry.status = status;
    entry.error = error;
    entry.finishedAt = this.now();
    if (entry.timer !== null) clearTimeout(entry.timer);
    const connection = entry.connection;
    entry.connection = null;
    if (connection !== null) {
      if (cancelInCodex) {
        await connection.request("account/login/cancel", { loginId: entry.loginId }, { timeoutMs: 5_000 }).catch(() => undefined);
      }
      entry.abort.abort();
      await connection.close("login finished").catch(() => undefined);
    }
    if (this.current === entry) this.current = null;
    if (status === "succeeded") this.deps.onAccountChanged?.();
    this.log({ event: "suduo.codex_account.login_finished", status });
  }

  private prune(): void {
    const now = this.now();
    for (const [loginId, entry] of this.logins) {
      if (entry.finishedAt !== null && now - entry.finishedAt > FINISHED_KEEP_MS) this.logins.delete(loginId);
    }
  }

  /** 起一个临时 app-server 做一件事就关掉。 */
  private async once(run: (connection: RpcConnection) => Promise<JsonValue>): Promise<JsonValue> {
    const abort = new AbortController();
    const connection = await this.connect(abort.signal);
    try {
      return await run(connection);
    } catch (error) {
      throw this.unavailable(error);
    } finally {
      abort.abort();
      // 不等进程退出再回包（关掉要一两秒）。
      void connection.close("account request finished").catch(() => undefined);
    }
  }

  private async connect(signal: AbortSignal): Promise<RpcConnection> {
    let connection: RpcConnection | null = null;
    try {
      connection = await this.deps.transport.connect({ codexBin: this.deps.codexBin, env: this.deps.env(), signal });
      await initializeCodexConnection(connection, { signal });
      return connection;
    } catch (error) {
      // 握手失败（Codex 卡住、超时）也要关掉这个临时进程，不然每读一次账号就留下一个。
      if (connection !== null) void connection.close("initialize failed").catch(() => undefined);
      throw this.unavailable(error);
    }
  }

  private unavailable(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    this.log({ event: "suduo.codex_account.failed", message: detail });
    return new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.codexAccount.codexFailed(detail));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: Record<string, unknown>): void {
    (this.deps.log ?? ((value) => console.error(JSON.stringify(value))))(line);
  }
}

function objectOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 授权地址只认 https（前端会交给系统浏览器打开）。 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
