import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  Locale,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
} from "@suduo/client-contracts";
import { ApiError } from "../src/application/api-error.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import type { DoctorResult } from "../src/infrastructure/doctor/doctor-service.js";
import { openWithSystemApp } from "../src/infrastructure/platform/system-open.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

/**
 * `http` 分区：请求校验、loopback 限制、打开系统程序的报错，以及 /doctor 页的语言选择，按请求语言生成。
 * 带 `x-suduo-locale: en` 出英文；不带时用夹具记下的 zh-CN，与迁移前逐字一致。
 * 请求头里的语言会被记下来（之后不带头的请求沿用它），所以每个用例先断言不带头的中文，之后的中文断言显式带 zh-CN。
 */

// 只在这里的用例里让 spawn 失败，其余调用照常（构建 HTTP 上下文时不受影响）。
const spawnFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (!spawnFailure.enabled) return actual.spawn(...args);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error(`spawn ${String(args[0])} ENOENT`)));
      return child;
    }) as typeof actual.spawn,
  };
});

const HOST = "127.0.0.1:8787";
const EN = { "x-suduo-locale": "en" };
const ZH = { "x-suduo-locale": "zh-CN" };

class IdleRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  async startThread(): Promise<StartThreadResult> {
    throw new Error("not used");
  }
  async startTurn(): Promise<StartTurnResult> {
    throw new Error("not used");
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> {
    return undefined;
  }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}

const contexts: Array<ReturnType<typeof createMinimalHttpContext>> = [];
const temporary: string[] = [];

afterEach(async () => {
  spawnFailure.enabled = false;
  for (const context of contexts.splice(0)) await context.close();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(overrides: Parameters<typeof createMinimalHttpContext>[1] = {}) {
  const context = createMinimalHttpContext(new IdleRuntime(), overrides);
  contexts.push(context);
  return context;
}

const errorOf = (response: { json(): unknown }) => (response.json() as { error: { code: string; message: string } }).error;

describe("请求校验与 loopback 限制按请求语言", () => {
  it("非本机 Host、缺 Origin 的写请求", async () => {
    const { server } = setup();
    const foreign = (headers: Record<string, string> = {}) =>
      server.inject({ method: "GET", url: "/api/v1/projects", headers: { host: "evil.example", ...headers } });
    expect(errorOf(await foreign())).toMatchObject({ code: "ORIGIN_REJECTED", message: "Host 必须是 loopback 地址" });
    expect(errorOf(await foreign(EN)).message).toBe("Host must be a loopback address");

    const noOrigin = await server.inject({ method: "POST", url: "/api/v1/projects", headers: { host: HOST, ...EN }, payload: {} });
    expect(errorOf(noOrigin).message).toBe("Write requests must include a same-origin Origin header");
  });

  it("查询参数、幂等键、未知 API", async () => {
    const { server } = setup();
    const get = (url: string, headers: Record<string, string> = {}) =>
      server.inject({ method: "GET", url, headers: { host: HOST, ...headers } });
    expect(errorOf(await get("/api/v1/projects?state=bogus")).message).toBe("项目 state 查询参数无效");
    expect(errorOf(await get("/api/v1/projects?state=bogus", EN)).message).toBe("The project state query parameter is invalid");
    expect(errorOf(await get("/api/v1/nothing-here", EN))).toMatchObject({ code: "NOT_FOUND", message: "API route not found" });
    expect(errorOf(await get("/api/v1/nothing-here", ZH)).message).toBe("API 路由不存在");

    const create = (headers: Record<string, string>) =>
      server.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", ...headers },
        payload: JSON.stringify({ name: "x" }),
      });
    expect(errorOf(await create(EN)).message).toBe("Write requests must include an Idempotency-Key header");
    expect(errorOf(await create(ZH)).message).toBe("写请求必须携带 Idempotency-Key");

    const body = (headers: Record<string, string>) =>
      server.inject({
        method: "PATCH",
        url: "/api/v1/settings",
        headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json", ...headers },
        payload: "[1]",
      });
    expect(errorOf(await body(EN)).message).toBe("Request body must be a JSON object");
    expect(errorOf(await body(ZH)).message).toBe("请求体必须是 JSON object");
  });
});

describe("调起系统程序失败", () => {
  it("说明按语言生成，系统原因原样带上；error.message 仍是中文", async () => {
    const directory = mkdtempSync(join(tmpdir(), "suduo-system-open-"));
    temporary.push(directory);
    const file = join(directory, "a.txt");
    writeFileSync(file, "x");
    spawnFailure.enabled = true;
    const error = await openWithSystemApp(file, "open").then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.localizedMessage("en")).toMatch(/^Couldn't run \S+: spawn \S+ ENOENT$/);
    expect(apiError.message).toMatch(/^无法调用系统程序 \S+：spawn \S+ ENOENT$/);
  });
});

describe("/doctor 页的语言", () => {
  function doctorFixture(seen: Locale[]) {
    return async (locale: Locale): Promise<DoctorResult> => {
      seen.push(locale);
      const t = messagesFor(locale);
      return {
        status: "PASS",
        codexHome: "/test/.codex",
        platform: process.platform,
        mode: "installed",
        configDir: "/test/.codex",
        dataDir: "/test/data",
        port: 8787,
        checkedAt: "2026-10-04T00:00:00.000Z",
        checks: [
          { id: "suduo.port", name: t.doctor.names.port, status: "pass", message: t.doctor.port.available("127.0.0.1:8787") },
        ],
      };
    };
  }

  it("?lang= 优先，其次已记下的界面语言；JSON 接口用请求语言", async () => {
    const seen: Locale[] = [];
    const { server } = setup({ doctor: doctorFixture(seen) });
    const page = (url: string, headers: Record<string, string> = {}) =>
      server.inject({ method: "GET", url, headers: { host: HOST, ...headers } });

    const zh = await page("/doctor");
    expect(zh.body).toContain('<html lang="zh-CN">');
    expect(zh.body).toContain("<title>SuDuo 自检</title>");
    expect(zh.body).toContain("<h1>本机环境自检</h1>");
    expect(zh.body).toContain("检查时间 2026-10-04T00:00:00.000Z");
    expect(zh.body).toContain('data-copied-text="诊断信息已复制"');
    expect(zh.body).toContain("<h2>监听端口</h2>");

    const en = await page("/doctor?lang=en");
    expect(en.body).toContain('<html lang="en">');
    expect(en.body).toContain("<title>SuDuo self-check</title>");
    expect(en.body).toContain("Checked at 2026-10-04T00:00:00.000Z");
    expect(en.body).toContain(">Copy diagnostics</button>");
    expect(en.body).toContain("<h2>Listening port</h2>");
    expect(en.body).toContain("127.0.0.1:8787 is available");
    // 不认识的 lang 不算数，退回已记下的界面语言。
    expect((await page("/doctor?lang=fr")).body).toContain('<html lang="zh-CN">');

    const json = await page("/api/v1/doctor", EN);
    expect((json.json() as DoctorResult).checks[0]).toMatchObject({ id: "suduo.port", name: "Listening port" });
    expect(seen).toEqual(["zh-CN", "en", "zh-CN", "en"]);
  });

  it("脚本里的「已复制」提示从页面读，脚本本身不带文字", async () => {
    const { server } = setup();
    const script = await server.inject({ method: "GET", url: "/doctor/client.js", headers: { host: HOST } });
    expect(script.body).toContain("dataset.copiedText");
    expect(script.body).not.toMatch(/[㐀-鿿]/u);
  });
});
