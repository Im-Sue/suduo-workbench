import { describe, expect, it } from "vitest";
import type { CodexTransportFactory, JsonValue, RpcConnection, RpcInbound } from "@suduo/client-contracts";
import { CodexAccountService } from "../src/application/codex-account-service.js";

/** 用 ChatGPT 账号登录 Codex（桌面应用 D2）：临时 app-server、授权地址、等完成通知、取消、超时、退出登录。 */

class FakeConnection implements RpcConnection {
  readonly connectionId = "fake";
  readonly transportKind = "stdio" as const;
  readonly requests: Array<{ method: string; params: JsonValue | undefined }> = [];
  closed = false;
  private readonly queue: RpcInbound[] = [];
  private wake: (() => void) | null = null;

  constructor(private readonly answer: (method: string, params: JsonValue | undefined) => JsonValue) {}

  async request(method: string, params: JsonValue | undefined): Promise<JsonValue> {
    this.requests.push({ method, params });
    return this.answer(method, params);
  }
  async notify(): Promise<void> {}
  async respond(): Promise<void> {}
  async respondError(): Promise<void> {}
  push(message: RpcInbound): void {
    this.queue.push(message);
    this.wake?.();
  }
  async *messages(options: { signal: AbortSignal }): AsyncIterable<RpcInbound> {
    while (!options.signal.aborted && !this.closed) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
  }
}

function setup(answer: (method: string, params: JsonValue | undefined) => JsonValue, loginTimeoutMs?: number) {
  const connections: FakeConnection[] = [];
  const changed: string[] = [];
  const transport: CodexTransportFactory = {
    kind: "stdio",
    connect: async () => {
      const connection = new FakeConnection(answer);
      connections.push(connection);
      return connection;
    },
  };
  const service = new CodexAccountService({
    transport,
    codexBin: "codex",
    env: () => ({ CODEX_HOME: "/tmp/codex" }),
    log: () => undefined,
    onAccountChanged: () => changed.push("changed"),
    ...(loginTimeoutMs === undefined ? {} : { loginTimeoutMs }),
  });
  return { service, connections, changed };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Codex 账号", () => {
  it("读登录方式：ChatGPT 带邮箱与套餐；没登录为 none；每次用完关掉临时进程", async () => {
    let account: JsonValue = { type: "chatgpt", email: "a@b.c", planType: "plus" };
    const { service, connections } = setup((method) => (method === "account/read" ? { account, requiresOpenaiAuth: true } : {}));
    expect(await service.account()).toEqual({ mode: "chatgpt", email: "a@b.c", plan: "plus", requiresOpenaiAuth: true });
    account = null;
    expect(await service.account()).toMatchObject({ mode: "none" });
    expect(connections.every((connection) => connection.closed)).toBe(true);
    expect(connections[0]!.requests.map((request) => request.method)).toEqual(["initialize", "account/read"]);
  });

  it("登录：拿到授权地址，等到完成通知后成功并关掉临时进程；失败带原因", async () => {
    const { service, connections, changed } = setup((method) =>
      method === "account/login/start" ? { type: "chatgpt", loginId: "L1", authUrl: "https://auth.openai.com/oauth/authorize?x=1" } : {},
    );
    const started = await service.startLogin();
    expect(started).toEqual({ loginId: "L1", authUrl: "https://auth.openai.com/oauth/authorize?x=1" });
    expect(connections[0]!.requests.at(-1)).toEqual({ method: "account/login/start", params: { type: "chatgpt" } });
    expect(service.status("L1")).toEqual({ status: "pending", error: null });
    connections[0]!.push({ kind: "notification", method: "account/login/completed", params: { loginId: "L1", success: true, error: null, onboardingEntrypoint: null } });
    await tick();
    expect(service.status("L1")).toEqual({ status: "succeeded", error: null });
    expect(connections[0]!.closed).toBe(true);
    // 登录成功后让会话用的 Codex 重连（由本机服务决定什么时候）。
    expect(changed).toEqual(["changed"]);

    const again = await service.startLogin();
    connections[1]!.push({ kind: "notification", method: "account/login/completed", params: { loginId: again.loginId, success: false, error: "denied", onboardingEntrypoint: null } });
    await tick();
    expect(service.status(again.loginId)).toEqual({ status: "failed", error: "denied" });
    expect(changed).toEqual(["changed"]);
  });

  it("握手失败：关掉这个临时进程，如实报错", async () => {
    const { service, connections } = setup((method) => {
      if (method === "initialize") throw new Error("handshake timed out");
      return {};
    });
    await expect(service.account()).rejects.toMatchObject({ statusCode: 503 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(connections[0]!.closed).toBe(true);
  });

  it("取消：告诉 Codex 取消并关掉进程；再点登录会先取消上一次；超时自动取消；授权地址不是 https 不用", async () => {
    let n = 0;
    const { service, connections } = setup((method) => {
      if (method !== "account/login/start") return {};
      n += 1;
      return { type: "chatgpt", loginId: `L${String(n)}`, authUrl: "https://auth.openai.com/x" };
    }, 30);
    await service.startLogin();
    expect(await service.cancel("L1")).toEqual({ status: "cancelled", error: null });
    expect(connections[0]!.requests.map((request) => request.method)).toContain("account/login/cancel");
    await service.startLogin();
    await service.startLogin();
    expect(service.status("L2").status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(service.status("L3")).toEqual({ status: "failed", error: "timeout" });
    expect(() => service.status("nope")).toThrow();

    const bad = setup((method) => (method === "account/login/start" ? { type: "chatgpt", loginId: "X", authUrl: "javascript:alert(1)" } : {}));
    await expect(bad.service.startLogin()).rejects.toMatchObject({ statusCode: 502 });
    expect(bad.connections[0]!.closed).toBe(true);
  });

  it("退出登录：调 account/logout 后返回最新状态", async () => {
    let loggedIn = true;
    const { service, changed } = setup((method) => {
      if (method === "account/logout") loggedIn = false;
      return method === "account/read" ? { account: loggedIn ? { type: "apiKey" } : null, requiresOpenaiAuth: true } : {};
    });
    expect(await service.logout()).toMatchObject({ mode: "none" });
    expect(changed).toEqual(["changed"]);
  });
});
