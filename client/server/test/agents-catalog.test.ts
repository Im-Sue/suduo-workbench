import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDto, AgentRuntime, StartThreadResult, StartTurnResult } from "@suduo/client-contracts";
import {
  AgentCatalogService,
  compareVersions,
  parseClaudeLoggedIn,
  parseVersion,
} from "../src/application/agents/agent-catalog-service.js";
import { agentChildEnv, type AgentExec, type AgentExecResult } from "../src/application/agents/agent-exec.js";
import { AgentSettingsStore } from "../src/application/agents/agent-settings-store.js";
import { AGENT_CATALOG, validateAgentCatalog, type AgentDescriptor } from "../src/application/agents/catalog.js";
import { resolveExecutable } from "../src/application/agents/resolver.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/** 多 Agent S1-2：Agent 配置表、可执行文件解析、状态检测与接口（技术设计 2.1、4.6）。 */

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (stdout: string): AgentExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, spawnError: null });

function fakeExec(table: Record<string, AgentExecResult>): AgentExec & { calls: string[] } {
  const calls: string[] = [];
  const exec = (async (file: string, args: readonly string[]) => {
    const key = [file, ...args].join(" ");
    calls.push(key);
    return table[key] ?? { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false, spawnError: null };
  }) as unknown as AgentExec & { calls: string[] };
  exec.calls = calls;
  return exec;
}

function service(options: {
  exec: AgentExec;
  found?: Record<string, string>;
  catalog?: readonly AgentDescriptor[];
  now?: () => number;
  platform?: NodeJS.Platform;
}) {
  const store = new AgentSettingsStore(join(tempDir("suduo-agent-settings-"), "agent-settings.json"));
  return new AgentCatalogService({
    store,
    codexBin: "/bundled/codex",
    exec: options.exec,
    catalog: options.catalog ?? AGENT_CATALOG,
    platform: options.platform ?? "darwin",
    now: options.now ?? (() => 1_000),
    resolve: (names) => {
      for (const name of names) {
        const hit = options.found?.[name];
        if (hit) return hit;
      }
      return null;
    },
  });
}

const byId = (agents: AgentDto[], id: string) => agents.find((agent) => agent.id === id)!;

describe("Agent 配置表", () => {
  it("内置配置表通过校验，首批八家都在，只有 Codex 是捆绑的；八家都已可驱动（S3 Claude、S4 ACP）", () => {
    expect(() => validateAgentCatalog(AGENT_CATALOG)).not.toThrow();
    expect(AGENT_CATALOG.map((agent) => agent.id)).toEqual([
      "claude-code",
      "codex",
      "copilot",
      "gemini",
      "cursor",
      "opencode",
      "qwen-code",
      "kimi-code",
    ]);
    expect(AGENT_CATALOG.filter((agent) => agent.bundled).map((agent) => agent.id)).toEqual(["codex"]);
    expect(AGENT_CATALOG.filter((agent) => !agent.runtimeAvailable)).toEqual([]);
  });

  it("重复 id、ACP 缺启动参数都启动失败", () => {
    const base = AGENT_CATALOG.find((agent) => agent.id === "gemini")!;
    expect(() => validateAgentCatalog([base, base])).toThrow(/duplicate/);
    expect(() => validateAgentCatalog([{ ...base, launchArgs: [] }])).toThrow(/launch args/);
    expect(() => validateAgentCatalog([{ ...base, id: "Bad Id" }])).toThrow(/invalid id/);
  });
});

describe("版本与登录状态解析", () => {
  it("从各家 --version 输出取版本号", () => {
    expect(parseVersion("2.1.284 (Claude Code)")).toBe("2.1.284");
    expect(parseVersion("GitHub Copilot CLI 1.0.93.\nRun 'copilot update'")).toBe("1.0.93");
    expect(parseVersion("codex-cli 0.159.2")).toBe("0.159.2");
    expect(parseVersion("no version here")).toBeNull();
  });

  it("版本比较只看主、次、修订号", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0-beta.1", "0.9.0")).toBe(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("claude auth status 只读 loggedIn，读不出返回 null", () => {
    expect(parseClaudeLoggedIn(JSON.stringify({ loggedIn: true, email: "someone@example.com", orgName: "x" }))).toBe(true);
    expect(parseClaudeLoggedIn(JSON.stringify({ loggedIn: false }))).toBe(false);
    expect(parseClaudeLoggedIn("Logged in as someone")).toBeNull();
    expect(parseClaudeLoggedIn(JSON.stringify({ loggedIn: "yes" }))).toBeNull();
  });

  it("子进程环境去掉 Claude Code 的嵌套标记与会话标识，其余保留", () => {
    const env = agentChildEnv({
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "vscode",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_PID: "1",
      HTTPS_PROXY: "http://p",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    // 用户自己的 Claude Code 配置保留
    expect(env).toEqual({ PATH: "/bin", HTTPS_PROXY: "http://p", CLAUDE_CODE_USE_BEDROCK: "1" });
  });
});

describe("可执行文件解析", () => {
  it("先 PATH 后常见安装目录；覆盖路径只认它自己", () => {
    const home = tempDir("suduo-home-");
    const pathDir = tempDir("suduo-path-");
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const inLocal = join(localBin, "claude");
    writeFileSync(inLocal, "#!/bin/sh\n");
    chmodSync(inLocal, 0o755);
    expect(resolveExecutable(["claude"], { env: { PATH: pathDir }, home, platform: "darwin" })).toBe(inLocal);

    const inPath = join(pathDir, "claude");
    writeFileSync(inPath, "#!/bin/sh\n");
    chmodSync(inPath, 0o755);
    expect(resolveExecutable(["claude"], { env: { PATH: pathDir }, home, platform: "darwin" })).toBe(inPath);

    expect(resolveExecutable(["claude"], { override: join(pathDir, "missing"), env: { PATH: pathDir }, home, platform: "darwin" })).toBeNull();
    const notExecutable = join(pathDir, "plain");
    writeFileSync(notExecutable, "x");
    expect(resolveExecutable(["plain"], { env: { PATH: pathDir }, home: tempDir("suduo-empty-home-"), platform: "darwin" })).toBeNull();
  });

  it("Windows 按 .cmd、.exe 的顺序找，不选无扩展名的 shim", () => {
    const existing = new Set(["C:\\npm\\copilot", "C:\\npm\\copilot.exe", "C:\\npm\\copilot.cmd"]);
    const found = resolveExecutable(["copilot"], {
      env: { Path: "C:\\npm", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      home: "C:\\Users\\u",
      isExecutable: (candidate) => existing.has(candidate),
    });
    expect(found).toBe("C:\\npm\\copilot.cmd");
  });
});

describe("Agent 状态检测", () => {
  it("没装：not_installed，给安装命令与官网；捆绑的 Codex 读版本即可", async () => {
    const exec = fakeExec({ "/bundled/codex --version": ok("codex-cli 0.159.2\n") });
    const { agents, defaultAgentId } = await service({ exec }).list();
    expect(defaultAgentId).toBe("codex");
    const codex = byId(agents, "codex");
    expect(codex).toMatchObject({ status: "ready", version: "0.159.2", bundled: true, runtimeAvailable: true });
    const gemini = byId(agents, "gemini");
    expect(gemini).toMatchObject({ status: "not_installed", reasonCode: "binary_not_found", runtimeAvailable: true });
    expect(gemini.actions.map((action) => action.kind)).toEqual(["copy_install_command", "recheck", "open_homepage"]);
    expect(gemini.actions[0]!.command).toBe("npm install -g @google/gemini-cli");
    // Kimi 没有核实过的安装命令：只给官网
    expect(byId(agents, "kimi-code").actions.map((action) => action.kind)).toEqual(["recheck", "open_homepage"]);
  });

  it("ACP Agent 装了但登录状态要到运行时才知道：installed，并给登录入口", async () => {
    const exec = fakeExec({
      "/bundled/codex --version": ok("codex-cli 0.159.2"),
      "/usr/local/bin/opencode --version": ok("1.18.35\n"),
    });
    const { agents } = await service({ exec, found: { opencode: "/usr/local/bin/opencode" } }).list();
    const opencode = byId(agents, "opencode");
    expect(opencode).toMatchObject({ status: "installed", version: "1.18.35", verifiedVersions: ["1.18.35"], versionVerified: true, executablePath: "/usr/local/bin/opencode" });
    expect(opencode.actions.find((action) => action.kind === "open_terminal_login")?.command).toBe("opencode auth login");
  });

  it("Claude Code：auth status 已登录为 ready，未登录为 auth_required，读不出为 installed", async () => {
    const make = (authStdout: string) =>
      service({
        exec: fakeExec({
          "/bundled/codex --version": ok("codex-cli 0.159.2"),
          "/home/u/.local/bin/claude --version": ok("2.1.284 (Claude Code)"),
          "/home/u/.local/bin/claude auth status": ok(authStdout),
        }),
        found: { claude: "/home/u/.local/bin/claude" },
      });
    expect(byId((await make(JSON.stringify({ loggedIn: true, email: "x@y" })).list()).agents, "claude-code").status).toBe("ready");
    const out = byId((await make(JSON.stringify({ loggedIn: false })).list()).agents, "claude-code");
    expect(out).toMatchObject({ status: "auth_required", reasonCode: "not_logged_in" });
    expect(out.actions.find((action) => action.kind === "open_terminal_login")?.command).toBe("claude auth login");
    expect(byId((await make("garbled").list()).agents, "claude-code")).toMatchObject({ status: "installed", reasonCode: "auth_check_failed" });
  });

  it("低于最低版本为 version_unsupported；读不出版本不拦截", async () => {
    const base = AGENT_CATALOG.find((agent) => agent.id === "qwen-code")!;
    const exec = fakeExec({ "/q --version": ok("0.1.0") });
    const strict = service({ exec, catalog: [{ ...base, minVersion: "0.20.0" }], found: { qwen: "/q" } });
    expect((await strict.list()).agents[0]).toMatchObject({ status: "version_unsupported", version: "0.1.0" });
    const vague = service({ exec: fakeExec({ "/q --version": ok("dev build") }), catalog: [{ ...base, minVersion: "0.20.0" }], found: { qwen: "/q" } });
    expect((await vague.list()).agents[0]).toMatchObject({ status: "installed", reasonCode: "version_unreadable", reasonDetail: "dev build" });
  });

  it("检测结果按时间缓存；recheck 强制重测；运行中鉴权失败可回灌", async () => {
    let now = 1_000;
    const exec = fakeExec({
      "/bundled/codex --version": ok("codex-cli 0.159.2"),
      "/c --version": ok("2.1.284"),
      "/c auth status": ok(JSON.stringify({ loggedIn: true })),
    });
    const agents = service({ exec, found: { claude: "/c" }, now: () => now });
    await agents.list();
    await agents.list();
    expect(exec.calls.filter((call) => call === "/c auth status")).toHaveLength(1);
    await agents.recheck("claude-code");
    expect(exec.calls.filter((call) => call === "/c auth status")).toHaveLength(2);
    agents.markAuthRequired("claude-code");
    expect(byId((await agents.list()).agents, "claude-code").status).toBe("auth_required");
    now += 11 * 60_000;
    expect(byId((await agents.list()).agents, "claude-code").status).toBe("ready");
  });

  it("不等检测的列表：先回「检测中」并在后台检测，检测完再取就是结果（多 Agent S5）", async () => {
    const exec = fakeExec({ "/bundled/codex --version": ok("codex-cli 0.159.2\n") });
    const agents = service({ exec });
    const first = agents.listNow();
    expect(byId(first.agents, "codex").status).toBe("checking");
    expect(byId(first.agents, "codex").actions).toEqual([]);
    await vi.waitFor(() => expect(byId(agents.listNow().agents, "codex").status).toBe("ready"));
  });

  it("ACP Agent 的登录失败一直记着（检测命令看不出），直到正常开出会话或用户重新检测（多 Agent S4）", async () => {
    let now = 1_000_000;
    const agents = service({
      exec: fakeExec({ "/g/gemini --version": { exitCode: 0, stdout: "0.63.0\n", stderr: "", timedOut: false, spawnError: null } }),
      found: { gemini: "/g/gemini" },
      now: () => now,
    });
    expect(byId((await agents.list()).agents, "gemini").status).toBe("installed");
    agents.markAuthRequired("gemini");
    now += 11 * 60_000;
    expect(byId((await agents.list()).agents, "gemini").status).toBe("auth_required");
    agents.markAuthOk("gemini");
    expect(byId((await agents.list()).agents, "gemini").status).toBe("installed");
    agents.markAuthRequired("gemini");
    expect((await agents.recheck("gemini")).status).toBe("installed");
  });

  it("设置：默认 Agent 与开关、路径覆盖；未知 Agent 报 404", async () => {
    const agents = service({ exec: fakeExec({}) });
    const updated = agents.updateSettings({ defaultAgentId: "claude-code", agents: [{ id: "gemini", enabled: false, binOverride: "/opt/gemini" }] });
    expect(updated.defaultAgentId).toBe("claude-code");
    expect(updated.agents.find((agent) => agent.id === "gemini")).toEqual({ id: "gemini", enabled: false, binOverride: "/opt/gemini", concurrency: 2 });
    // 并发上限（多 Agent 协作 S8）：每家与合计都可改，范围 1–8。
    const limited = agents.updateSettings({ agents: [{ id: "claude-code", concurrency: 3 }], globalConcurrency: 6 });
    expect(limited.globalConcurrency).toBe(6);
    expect(limited.agents.find((agent) => agent.id === "claude-code")?.concurrency).toBe(3);
    expect(agents.concurrency("claude-code")).toBe(3);
    expect(agents.globalConcurrency()).toBe(6);
    expect(() => agents.updateSettings({ globalConcurrency: 0 })).toThrow();
    expect(() => agents.updateSettings({ agents: [{ id: "codex", concurrency: 9 }] })).toThrow();
    expect(() => agents.updateSettings({ defaultAgentId: "nope" })).toThrow();
    expect(() => agents.loginCommand("codex")).toThrow();
    expect(agents.loginCommand("copilot")).toBe("copilot login");
  });

  it("能不能在讨论里替别人执行（多 Agent S6，ADR-0009 只读红线）：做得到只读、没停用的才行", () => {
    const agents = service({ exec: fakeExec({}) });
    const text = (agentId: string) => {
      const problem = agents.roomAgentProblem(agentId);
      return problem === null ? null : typeof problem === "string" ? problem : problem(messagesFor("zh-CN"));
    };
    // 实测过只读拦截的三家。
    expect(["codex", "claude-code", "opencode"].map(text)).toEqual([null, null, null]);
    expect(text("gemini")).toBe("Gemini CLI 做不到只读（可能不经询问就写文件），不能共享进讨论、不执行讨论里的任务");
    expect(text("nope")).toBe("这个版本的 SuDuo 不能在讨论里使用 nope");
    agents.updateSettings({ agents: [{ id: "claude-code", enabled: false }] });
    expect(text("claude-code")).toBe("Claude Code 在这台电脑的 AI Agent 设置里停用了，不执行讨论里的任务");
  });
});

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    throw new Error("unused");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("unused");
  }
  async approve() {
    return { acknowledged: true };
  }
  async interrupt() {}
  async *subscribe() {}
}

describe("Agent 接口", () => {
  const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];
  afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
  });
  const HOST = "127.0.0.1:8790";
  const writeHeaders = { host: HOST, origin: `http://${HOST}`, "idempotency-key": randomUUID(), "content-type": "application/json" };

  it("列表、重新检测、登录（打开终端）、读写设置", async () => {
    const opened: string[] = [];
    const agents = service({ exec: fakeExec({ "/bundled/codex --version": ok("codex-cli 0.159.2") }) });
    const context = createMinimalHttpContext(new IdleRuntime(), {
      agents,
      openTerminal: async (command) => {
        opened.push(command);
        return true;
      },
    });
    contexts.push(context);
    const list = await context.server.inject({ method: "GET", url: "/api/v1/agents", headers: { host: HOST } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { agents: AgentDto[] }).agents).toHaveLength(8);

    const recheck = await context.server.inject({ method: "POST", url: "/api/v1/agents/codex/recheck", headers: writeHeaders, payload: {} });
    expect(recheck.statusCode, recheck.body).toBe(200);
    expect((recheck.json() as AgentDto).status).toBe("ready");

    const login = await context.server.inject({ method: "POST", url: "/api/v1/agents/gemini/login", headers: { ...writeHeaders, "idempotency-key": randomUUID() }, payload: {} });
    expect(login.json()).toEqual({ opened: true, command: "gemini" });
    expect(opened).toEqual(["gemini"]);

    // 会话级模型选择器按 Agent 取选项：Claude 用别名，ACP 先不给，不认识的 Agent 404（多 Agent S5）
    const claudeModels = await context.server.inject({ method: "GET", url: "/api/v1/agents/claude-code/models", headers: { host: HOST } });
    expect((claudeModels.json() as { models: string[] }).models).toEqual(["opus", "sonnet", "haiku"]);
    const geminiModels = await context.server.inject({ method: "GET", url: "/api/v1/agents/gemini/models", headers: { host: HOST } });
    expect(geminiModels.json()).toEqual({ models: [], items: [] });
    expect((await context.server.inject({ method: "GET", url: "/api/v1/agents/nope/models", headers: { host: HOST } })).statusCode).toBe(404);

    const missing = await context.server.inject({ method: "POST", url: "/api/v1/agents/nope/recheck", headers: { ...writeHeaders, "idempotency-key": randomUUID() }, payload: {} });
    expect(missing.statusCode).toBe(404);

    const put = await context.server.inject({
      method: "PUT",
      url: "/api/v1/settings/agents",
      headers: { ...writeHeaders, "idempotency-key": randomUUID() },
      payload: { defaultAgentId: "claude-code" },
    });
    expect(put.statusCode).toBe(200);
    const settings = await context.server.inject({ method: "GET", url: "/api/v1/settings/agents", headers: { host: HOST } });
    expect((settings.json() as { defaultAgentId: string }).defaultAgentId).toBe("claude-code");
  });
});
