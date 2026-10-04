import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type {
  AgentRuntime,
  ApproveResult,
  Locale,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
} from "@suduo/client-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "../src/application/settings-service.js";
import { registerRequestLocale, requestLocaleOf, resolveRequestLocale } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import { createMinimalHttpContext } from "./helpers/minimal-http-context.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function settingsFile(): string {
  const root = mkdtempSync(join(tmpdir(), "suduo-locale-"));
  roots.push(root);
  return join(root, "settings.json");
}

describe("请求语言的回退链", () => {
  it("请求头 → 地址上的 ?locale= → 已同步的语言 → Accept-Language → en", () => {
    expect(resolveRequestLocale({ header: "zh-CN", query: "en", stored: "en", acceptLanguage: "en" })).toBe("zh-CN");
    expect(resolveRequestLocale({ header: undefined, query: "en", stored: "zh-CN", acceptLanguage: "zh-CN" })).toBe("en");
    expect(resolveRequestLocale({ header: "fr", query: undefined, stored: "en", acceptLanguage: "zh-CN" })).toBe("en");
    expect(resolveRequestLocale({ header: undefined, query: "fr", stored: "zh-CN", acceptLanguage: "en" })).toBe("zh-CN");
    expect(resolveRequestLocale({ header: undefined, query: ["en", "zh-CN"], stored: null, acceptLanguage: "zh-CN" })).toBe("zh-CN");
    expect(resolveRequestLocale({ header: undefined, query: undefined, stored: null, acceptLanguage: "zh-CN,zh;q=0.9" })).toBe("zh-CN");
    expect(resolveRequestLocale({ header: ["en", "zh-CN"], query: undefined, stored: null, acceptLanguage: undefined })).toBe("en");
  });

  it("EventSource 带不了头：认地址上的 ?locale=，但只管这一个请求、不记下来", async () => {
    const settings = new SettingsService(settingsFile(), {});
    const server = Fastify();
    registerRequestLocale(server, settings);
    server.get("/stream", async (request) => ({ locale: request.locale }));
    const probe = async (url: string, headers: Record<string, string> = {}) =>
      (await server.inject({ method: "GET", url, headers })).json() as { locale: Locale };

    expect(await probe("/stream", { "x-suduo-locale": "zh-CN" })).toEqual({ locale: "zh-CN" });
    expect(settings.locale()).toBe("zh-CN");
    // 切到英文后事件流先于普通请求重连：按地址上的语言出文字。
    expect(await probe("/stream?locale=en")).toEqual({ locale: "en" });
    expect(await probe("/stream?after=12&locale=en", { "accept-language": "zh-CN" })).toEqual({ locale: "en" });
    // 不记：后台任务与没带语言的请求仍用请求头记下的语言。
    expect(settings.locale()).toBe("zh-CN");
    expect(await probe("/stream")).toEqual({ locale: "zh-CN" });
    // 请求头优先；非法值与重复参数不认。
    expect(await probe("/stream?locale=en", { "x-suduo-locale": "zh-CN" })).toEqual({ locale: "zh-CN" });
    expect(await probe("/stream?locale=fr")).toEqual({ locale: "zh-CN" });
    expect(await probe("/stream?locale=en&locale=zh-CN")).toEqual({ locale: "zh-CN" });
    await server.close();
  });

  it("早于 request.locale 的错误处理（requestLocaleOf）同样认 ?locale=", async () => {
    const settings = new SettingsService(settingsFile(), {});
    const server = Fastify();
    server.addHook("onRequest", async (request) => {
      if (request.url.startsWith("/blocked")) throw new Error("blocked");
    });
    registerRequestLocale(server, settings);
    server.setErrorHandler((_error, request, reply) => {
      void reply.code(403).send({ locale: requestLocaleOf(request, settings) });
    });
    server.get("/blocked", async () => ({ ok: true }));
    const response = await server.inject({ method: "GET", url: "/blocked?locale=en", headers: { "accept-language": "zh-CN" } });
    expect(response.json()).toEqual({ locale: "en" });
    await server.close();
  });

  it("挂在每个请求上，并记住请求头带来的语言", async () => {
    const settings = new SettingsService(settingsFile(), {});
    const server = Fastify();
    registerRequestLocale(server, settings);
    server.get("/probe", async (request) => ({ locale: request.locale }));
    const probe = async (headers: Record<string, string>) =>
      (await server.inject({ method: "GET", url: "/probe", headers })).json() as { locale: Locale };

    expect(await probe({})).toEqual({ locale: "en" });
    expect(await probe({ "accept-language": "zh-TW" })).toEqual({ locale: "zh-CN" });
    expect(settings.locale()).toBeNull();
    expect(await probe({ "x-suduo-locale": "zh-CN" })).toEqual({ locale: "zh-CN" });
    expect(settings.locale()).toBe("zh-CN");
    // EventSource 这类带不了头的请求沿用最近一次的语言，而不是 Accept-Language。
    expect(await probe({ "accept-language": "en-US" })).toEqual({ locale: "zh-CN" });
    expect(await probe({ "x-suduo-locale": "fr" })).toEqual({ locale: "zh-CN" });
    await server.close();
  });
});

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

describe("事件流的 ?locale= 走到真实的 HTTP 服务", () => {
  it("会话事件流打不开时的报错按地址上的语言；夹具记下的中文不被改掉", async () => {
    const context = createMinimalHttpContext(new IdleRuntime());
    try {
      const open = async (url: string) =>
        (await context.server.inject({ method: "GET", url, headers: { host: "127.0.0.1:8787" } })).json() as {
          error: { code: string; message: string };
        };
      expect((await open("/api/v1/sessions/missing/events?after=0&locale=en")).error).toEqual(
        expect.objectContaining({ code: "NOT_FOUND", message: messagesFor("en").session.notFound }),
      );
      expect((await open("/api/v1/sessions/missing/events?after=0")).error.message).toBe(messagesFor("zh-CN").session.notFound);
    } finally {
      await context.close();
    }
  });
});

describe("记下的界面语言", () => {
  it("默认为 null；记下后存进 settings.locale.json，重启后读回", () => {
    const file = settingsFile();
    const settings = new SettingsService(file, {});
    expect(settings.get().locale).toBeNull();
    settings.rememberLocale("en");
    expect(settings.get().locale).toBe("en");
    expect(JSON.parse(readFileSync(file.replace(/\.json$/, ".locale.json"), "utf8"))).toEqual({ locale: "en" });
    expect(existsSync(file)).toBe(false);
    expect(new SettingsService(file, {}).get().locale).toBe("en");
  });

  it("不碰 settings.json：手改坏的设置文件保持原样，不会被覆盖成默认值", () => {
    const file = settingsFile();
    const broken = '{ "httpsProxy": "http://proxy.internal:3128", }';
    writeFileSync(file, broken);
    const settings = new SettingsService(file, {});
    settings.rememberLocale("zh-CN");
    expect(readFileSync(file, "utf8")).toBe(broken);
  });

  it("文件里的坏值当作没记过；写不进去只记日志、不抛错", () => {
    const file = settingsFile();
    writeFileSync(file.replace(/\.json$/, ".locale.json"), JSON.stringify({ locale: "system" }));
    expect(new SettingsService(file, {}).get().locale).toBeNull();

    // 数据目录的位置被一个普通文件占着：建不了目录，写不进去。
    const blocker = settingsFile();
    writeFileSync(blocker, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = new SettingsService(join(blocker, "settings.json"), {});
    expect(() => settings.rememberLocale("en")).not.toThrow();
    expect(settings.locale()).toBe("en");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("本机服务字典", () => {
  it("按语言取字典", () => {
    expect(messagesFor("zh-CN").checkpoint.restoredTo("abc1234")).toBe("还原到 abc1234");
    expect(messagesFor("en").checkpoint.restoredTo("abc1234")).toBe("Restored to abc1234");
  });
});
